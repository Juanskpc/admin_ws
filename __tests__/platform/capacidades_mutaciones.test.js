/**
 * Suite de las mutaciones de capacidad (F4-B — ADR-010, ADR-011).
 *
 * Completa los criterios de aceptación de F4 que F4-A no podía cubrir por no tener ninguna
 * mutación real:
 *
 *   1. Se puede agendar, reagendar y cancelar una cita completa sin IA y sin frontend, y el
 *      resultado en base de datos es correcto.
 *   3. Ejecutar dos veces la misma capacidad con la misma clave de idempotencia produce
 *      **una sola** cita.
 *
 * Y comprueba lo que el ciclo `propose → hold → confirm` promete: que una propuesta sin
 * confirmar caduca sola, y que confirmar sobre una propuesta muerta falla en vez de
 * inventarse una cita.
 *
 * Requiere:
 *   psql ... -f scripts/fixtures/dev_reserva.sql
 *   npm run migrate:platform-capacidades && npm run migrate:reserva-hold
 *   npm run migrate:platform-idempotencia
 *
 * Correr con:  npx jest __tests__/platform/capacidades_mutaciones.test.js --runInBand
 */
require('dotenv').config();
process.env.FEATURES_FORZADAS = 'asistente_ia';

const Models = require('../../app_core/models/conection');
const { resolverPrincipalUsuario } = require('../../app_core/authz/principal');
const intelligence = require('../../intelligence');
const policyGate = require('../../intelligence/core/policyGate');

const sequelize = Models.sequelize;

const MUTACIONES = ['proponer_turno', 'reservar_turno', 'reagendar_cita', 'cancelar_cita'];
const CLIENTE = 'F4B Ana';

let negocioDemo;
let negocioRival;
let principalDemo;
let principalRival;
let idServicio;

async function unaFila(sql, replacements = {}) {
    const [[fila]] = await sequelize.query(sql, { replacements });
    return fila ?? null;
}

async function habilitar(idNegocio, capacidad, habilitada = true) {
    await sequelize.query(
        `
        INSERT INTO platform.capacidad_habilitada (id_negocio, capacidad, habilitada)
        VALUES (:idNegocio, :capacidad, :habilitada)
        ON CONFLICT (id_negocio, capacidad) DO UPDATE SET habilitada = EXCLUDED.habilitada;
        `,
        { replacements: { idNegocio, capacidad, habilitada } }
    );
}

/** Lunes lejano y estable: lejos de la anticipación mínima y de la ventana de cancelación. */
function lunes(semanas = 3) {
    const d = new Date();
    d.setDate(d.getDate() + 7 * semanas);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Ejecuta por el Gate, con la confirmación puesta cuando la capacidad la exige (F7).
 *
 * Esta suite es la del ciclo sin IA ni frontend: aquí el humano que confirma es quien corre el
 * test, igual que en la CLI de `scripts/`, y por eso la prueba lleva `origen` en vez del turno de
 * una conversación. Los tests que comprueban que **sin** confirmación se deniega la pasan a mano.
 */
function ejecutar(capacidad, args, extra = {}) {
    const exige = intelligence.registry.describir(capacidad)?.requiere_confirmacion;
    return policyGate.ejecutar({
        capacidad,
        principal: principalDemo,
        idNegocio: negocioDemo,
        args,
        ...(exige ? { confirmadoPor: { origen: 'test', texto: 'sí' } } : {}),
        ...extra,
    });
}

/** Propone un hueco y devuelve su código. */
async function proponer(hora, dia = lunes()) {
    const { resultado } = await ejecutar('proponer_turno', {
        id_servicio: idServicio,
        inicio: `${dia}T${hora}:00`,
    });
    return resultado.codigo_hold;
}

async function limpiar() {
    await sequelize.query(`DELETE FROM platform.capacidad_idempotencia WHERE clave LIKE 'F4B%';`);
    await sequelize.query(`DELETE FROM reserva.reserva_hold WHERE id_negocio IN (:n);`, {
        replacements: { n: [negocioDemo, negocioRival] },
    });
    await sequelize.query(
        `DELETE FROM reserva.reserva_cita_servicio
          WHERE id_cita IN (SELECT id_cita FROM reserva.reserva_cita WHERE cliente_nombre LIKE :m);`,
        { replacements: { m: `${CLIENTE}%` } }
    );
    await sequelize.query(`DELETE FROM reserva.reserva_cita WHERE cliente_nombre LIKE :m;`, {
        replacements: { m: `${CLIENTE}%` },
    });
}

beforeAll(async () => {
    intelligence.arrancar();

    negocioDemo = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`))?.id_negocio;
    negocioRival = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Rival';`))?.id_negocio;

    const svc = await unaFila(
        `SELECT id_servicio FROM reserva.reserva_servicio WHERE id_negocio = :n AND nombre = 'Corte de cabello';`,
        { n: negocioDemo }
    );
    if (!svc) throw new Error('Falta la agenda de reserva. Ejecuta scripts/fixtures/dev_reserva.sql.');
    idServicio = svc.id_servicio;

    const idDemo = (await unaFila(`SELECT id_usuario FROM general.gener_usuario WHERE num_identificacion = '1000000002';`))?.id_usuario;
    const idRival = (await unaFila(`SELECT id_usuario FROM general.gener_usuario WHERE num_identificacion = '1000000003';`))?.id_usuario;
    principalDemo = await resolverPrincipalUsuario(idDemo);
    principalRival = await resolverPrincipalUsuario(idRival);

    for (const c of MUTACIONES) {
        await habilitar(negocioDemo, c);
        // También en el rival: si no, los tests de aislamiento fallarían por «capacidad no
        // habilitada» y no por lo que quieren probar, que es el acotado por inquilino.
        await habilitar(negocioRival, c);
    }
    await limpiar();
});

afterEach(limpiar);

afterAll(async () => {
    await sequelize.query(`DELETE FROM platform.capacidad_habilitada WHERE id_negocio = :n;`, {
        replacements: { n: negocioRival },
    });
    intelligence._reiniciar();
    await sequelize.close();
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('CRITERIO 1 — el ciclo completo sin IA ni frontend', () => {
    it('agendar → reagendar → cancelar, y la base queda correcta', async () => {
        const dia = lunes();

        const hold = await proponer('10:00', dia);
        const { resultado: cita } = await ejecutar('reservar_turno', {
            codigo_hold: hold,
            cliente_nombre: `${CLIENTE} ciclo`,
            cliente_telefono: '3001112233',
        });
        expect(cita.estado).toBe('pendiente');
        expect(cita.monto_total).toBeGreaterThan(0);

        const holdNuevo = await proponer('15:00', dia);
        const { resultado: movida } = await ejecutar('reagendar_cita', {
            codigo_cita: cita.codigo_cita,
            codigo_hold: holdNuevo,
        });
        expect(movida.codigo_cita).toBe(cita.codigo_cita);

        const { resultado: cancelada } = await ejecutar('cancelar_cita', {
            codigo_cita: cita.codigo_cita,
            motivo: 'le surgió un viaje',
        });
        expect(cancelada.estado).toBe('cancelada');

        // Lo que importa no es lo que devolvió la capacidad, es lo que quedó en la base.
        const fila = await unaFila(
            `SELECT to_char(fecha_hora_inicio,'YYYY-MM-DD HH24:MI') inicio, estado, cancelado_motivo, cliente_telefono
               FROM reserva.reserva_cita WHERE codigo_publico = :c;`,
            { c: cita.codigo_cita }
        );
        expect(fila.inicio).toBe(`${dia} 15:00`); // la hora reagendada, en wall-time de Bogotá
        expect(fila.estado).toBe('cancelada');
        expect(fila.cancelado_motivo).toBe('le surgió un viaje');
        expect(fila.cliente_telefono).toBe('3001112233');

        // Y una sola cita, no tres.
        const { n } = await unaFila(
            `SELECT count(*)::int n FROM reserva.reserva_cita WHERE cliente_nombre LIKE :m;`,
            { m: `${CLIENTE}%` }
        );
        expect(n).toBe(1);
    });

    it('el hueco reagendado queda libre y el nuevo ocupado', async () => {
        const dia = lunes();
        const hold = await proponer('10:00', dia);
        const { resultado: cita } = await ejecutar('reservar_turno', {
            codigo_hold: hold,
            cliente_nombre: `${CLIENTE} mueve`,
        });

        await ejecutar('reagendar_cita', {
            codigo_cita: cita.codigo_cita,
            codigo_hold: await proponer('15:00', dia),
        });

        const { resultado } = await ejecutar('consultar_disponibilidad', { id_servicio: idServicio, fecha: dia });
        const horas = resultado.horas.map((h) => h.hora);
        expect(horas).toContain('10:00'); // liberada
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('CRITERIO 3 — idempotencia', () => {
    it('la misma clave dos veces produce UNA sola cita', async () => {
        const hold = await proponer('10:00');
        const args = { codigo_hold: hold, cliente_nombre: `${CLIENTE} idem` };

        const primera = await ejecutar('reservar_turno', args, { claveIdempotencia: 'F4B-turno-1' });
        const segunda = await ejecutar('reservar_turno', args, { claveIdempotencia: 'F4B-turno-1' });

        expect(primera.reintento).toBeUndefined();
        expect(segunda.reintento).toBe(true);
        expect(segunda.resultado.codigo_cita).toBe(primera.resultado.codigo_cita);

        const { n } = await unaFila(
            `SELECT count(*)::int n FROM reserva.reserva_cita WHERE cliente_nombre LIKE :m;`,
            { m: `${CLIENTE}%` }
        );
        expect(n).toBe(1);
    });

    it('CARRERA: dos invocaciones simultáneas con la misma clave, una sola cita', async () => {
        const hold = await proponer('10:00');
        const args = { codigo_hold: hold, cliente_nombre: `${CLIENTE} carrera` };

        const [a, b] = await Promise.all([
            ejecutar('reservar_turno', args, { claveIdempotencia: 'F4B-carrera' }),
            ejecutar('reservar_turno', args, { claveIdempotencia: 'F4B-carrera' }),
        ]);

        expect(a.resultado.codigo_cita).toBe(b.resultado.codigo_cita);
        const { n } = await unaFila(
            `SELECT count(*)::int n FROM reserva.reserva_cita WHERE cliente_nombre LIKE :m;`,
            { m: `${CLIENTE}%` }
        );
        expect(n).toBe(1);
    });

    it('claves distintas no se comparten resultado', async () => {
        const hold = await proponer('10:00');
        await ejecutar(
            'reservar_turno',
            { codigo_hold: hold, cliente_nombre: `${CLIENTE} k1` },
            { claveIdempotencia: 'F4B-k1' }
        );

        // Con otra clave se ejecuta de verdad — y falla porque el hold ya se consumió, que
        // es la segunda red de seguridad: aunque la clave no proteja, el hold sí.
        await expect(
            ejecutar('reservar_turno', { codigo_hold: hold, cliente_nombre: `${CLIENTE} k2` }, { claveIdempotencia: 'F4B-k2' })
        ).rejects.toMatchObject({ code: 'HOLD_NO_VIGENTE' });
    });

    it('un dry-run NO gasta la clave', async () => {
        const hold = await proponer('10:00');
        const args = { codigo_hold: hold, cliente_nombre: `${CLIENTE} seco` };

        await ejecutar('reservar_turno', args, { claveIdempotencia: 'F4B-seco', dryRun: true });

        const guardada = await unaFila(
            `SELECT clave FROM platform.capacidad_idempotencia WHERE clave = 'F4B-seco';`
        );
        expect(guardada).toBeNull();

        // Y la ejecución de verdad sigue funcionando: el dry-run no consumió el hold.
        const real = await ejecutar('reservar_turno', args, { claveIdempotencia: 'F4B-seco' });
        expect(real.reintento).toBeUndefined();
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('propose → hold → confirm (ADR-010)', () => {
    it('proponer no crea ninguna cita', async () => {
        await proponer('10:00');
        const { n } = await unaFila(`SELECT count(*)::int n FROM reserva.reserva_cita WHERE cliente_nombre LIKE :m;`, {
            m: `${CLIENTE}%`,
        });
        expect(n).toBe(0);
    });

    it('una propuesta sin confirmar caduca sola y libera el hueco', async () => {
        const dia = lunes();
        const hold = await proponer('10:00', dia);

        await sequelize.query(
            `UPDATE reserva.reserva_hold SET expira_en = now() - interval '1 second' WHERE codigo = :c;`,
            { replacements: { c: hold } }
        );

        // Otro cliente puede tomar el mismo hueco.
        await expect(proponer('10:00', dia)).resolves.toEqual(expect.any(String));
    });

    it('confirmar sobre una propuesta caducada falla, no inventa una cita', async () => {
        const hold = await proponer('10:00');
        await sequelize.query(
            `UPDATE reserva.reserva_hold SET expira_en = now() - interval '1 second' WHERE codigo = :c;`,
            { replacements: { c: hold } }
        );

        await expect(
            ejecutar('reservar_turno', { codigo_hold: hold, cliente_nombre: `${CLIENTE} tarde` })
        ).rejects.toMatchObject({ code: 'HOLD_NO_VIGENTE' });
    });

    it('dos propuestas sobre el mismo hueco: la segunda choca', async () => {
        const dia = lunes();
        await proponer('10:00', dia);
        await expect(proponer('10:00', dia)).rejects.toMatchObject({ code: 'SLOT_NO_DISPONIBLE' });
    });

    it('el dominio sigue mandando: no se propone un domingo', async () => {
        const d = new Date();
        d.setDate(d.getDate() + 21);
        while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
        const domingo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        await expect(proponer('10:00', domingo)).rejects.toMatchObject({ code: 'FUERA_DE_HORARIO' });
    });

    it('un dry-run de proponer_turno no deja hold', async () => {
        await ejecutar(
            'proponer_turno',
            { id_servicio: idServicio, inicio: `${lunes()}T10:00:00` },
            { dryRun: true }
        );
        const { n } = await unaFila(`SELECT count(*)::int n FROM reserva.reserva_hold WHERE id_negocio = :g;`, {
            g: negocioDemo,
        });
        expect(n).toBe(0);
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('Confirmación humana en el Gate de verdad (ADR-010, paso 5 — F7)', () => {
    it('sin la prueba del sí, la mutación NO se ejecuta y la cita queda intacta', async () => {
        const hold = await proponer('10:00');
        const { resultado: cita } = await ejecutar('reservar_turno', {
            codigo_hold: hold,
            cliente_nombre: `${CLIENTE} sin confirmar`,
        });

        // Exactamente la misma invocación que arriba, menos el sobre de confirmación.
        await expect(
            policyGate.ejecutar({
                capacidad: 'cancelar_cita',
                principal: principalDemo,
                idNegocio: negocioDemo,
                args: { codigo_cita: cita.codigo_cita },
            })
        ).rejects.toMatchObject({ code: 'CONFIRMACION_REQUERIDA', statusCode: 403 });

        const fila = await unaFila(`SELECT estado FROM reserva.reserva_cita WHERE codigo_publico = :c;`, {
            c: cita.codigo_cita,
        });
        expect(fila.estado).toBe('pendiente'); // nadie la canceló
    });

    it('una prueba a medias tampoco vale: hay que decir dónde se confirmó y con qué', async () => {
        const hold = await proponer('11:00');
        const { resultado: cita } = await ejecutar('reservar_turno', {
            codigo_hold: hold,
            cliente_nombre: `${CLIENTE} media prueba`,
        });

        await expect(
            policyGate.ejecutar({
                capacidad: 'cancelar_cita',
                principal: principalDemo,
                idNegocio: negocioDemo,
                args: { codigo_cita: cita.codigo_cita },
                // Sin `texto` ni identificador: es un «confirmado: true» disfrazado.
                confirmadoPor: {},
            })
        ).rejects.toMatchObject({ code: 'CONFIRMACION_REQUERIDA' });
    });

    it('el hold NO exige confirmación: es la mitad *propose* del ciclo', async () => {
        // Si la exigiera, agendar sería «¿confirmas que aparte la hora?» y luego «¿confirmo la
        // cita?»: dos preguntas para una decisión. Su efecto se deshace solo al caducar.
        const { resultado } = await policyGate.ejecutar({
            capacidad: 'proponer_turno',
            principal: principalDemo,
            idNegocio: negocioDemo,
            args: { id_servicio: idServicio, inicio: `${lunes()}T12:00:00` },
        });
        expect(resultado.codigo_hold).toBeTruthy();
    });

    it('quién autorizó qué queda en la auditoría', async () => {
        const hold = await proponer('09:00');
        const { resultado: cita } = await ejecutar('reservar_turno', {
            codigo_hold: hold,
            cliente_nombre: `${CLIENTE} auditada`,
        });

        await policyGate.ejecutar({
            capacidad: 'cancelar_cita',
            principal: principalDemo,
            idNegocio: negocioDemo,
            args: { codigo_cita: cita.codigo_cita },
            confirmadoPor: { idTurno: 'turno-de-prueba', texto: 'sí, cancélala' },
        });

        // Es la mitad del valor de la regla: el Gate no puede verificar que una persona dijera
        // sí, pero sí puede dejar por escrito quién lo afirmó y con qué palabras.
        const fila = await unaFila(
            `
            SELECT detalle
              FROM auditoria.audit_evento
             WHERE modulo = :modulo AND accion = 'cancelar_cita' AND resultado = 'ok'
             ORDER BY id_evento DESC
             LIMIT 1;
            `,
            { modulo: policyGate.MODULO_AUDITORIA }
        );
        expect(fila.detalle.confirmado_en_turno).toBe('turno-de-prueba');
        expect(fila.detalle.confirmado_con).toBe('sí, cancélala');
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('Aislamiento: los handles públicos no cruzan inquilinos', () => {
    it('el código de una cita de otro negocio no se encuentra', async () => {
        const hold = await proponer('10:00');
        const { resultado: cita } = await ejecutar('reservar_turno', {
            codigo_hold: hold,
            cliente_nombre: `${CLIENTE} ajena`,
        });

        // El rival tiene la capacidad habilitada y pertenece a SU negocio: lo único que le
        // separa de la cita es el acotado por inquilino. Si esto pasara, la fuga sería real.
        await expect(
            policyGate.ejecutar({
                capacidad: 'cancelar_cita',
                principal: principalRival,
                idNegocio: negocioRival,
                args: { codigo_cita: cita.codigo_cita },
                // Con la confirmación puesta: sin ella el Gate denegaría antes de llegar al
                // dominio y el test dejaría de probar el aislamiento, que es lo que dice probar.
                confirmadoPor: { origen: 'test', texto: 'sí' },
            })
        ).rejects.toMatchObject({ code: 'CITA_NO_ENCONTRADA' });

        const fila = await unaFila(`SELECT estado FROM reserva.reserva_cita WHERE codigo_publico = :c;`, {
            c: cita.codigo_cita,
        });
        expect(fila.estado).toBe('pendiente'); // intacta
    });

    it('el código de un hold de otro negocio tampoco', async () => {
        const hold = await proponer('10:00');

        await expect(
            policyGate.ejecutar({
                capacidad: 'reservar_turno',
                principal: principalRival,
                idNegocio: negocioRival,
                args: { codigo_hold: hold, cliente_nombre: `${CLIENTE} ajeno` },
                confirmadoPor: { origen: 'test', texto: 'sí' },
            })
        ).rejects.toMatchObject({ code: 'HOLD_NO_VIGENTE' });
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('Capa económica declarada (ADR-011)', () => {
    it('cancelar_cita declara la ventana de cancelación en su manifiesto', () => {
        expect(intelligence.registry.describir('cancelar_cita').politica).toEqual(['ventana_cancelacion_horas']);
    });

    it('y el límite lo aplica el DOMINIO, no el Gate', async () => {
        // Una cita dentro de la ventana no se puede cancelar. Se crea saltándose el camino
        // de capacidad (el asistente no podría agendar tan cerca) para poder atacar la
        // cancelación con una cita inminente.
        const dentro = new Date(Date.now() + 60 * 60_000); // dentro de una hora
        const fila = await unaFila(
            `
            INSERT INTO reserva.reserva_cita
                (id_negocio, id_profesional, fecha_hora_inicio, fecha_hora_fin, estado, cliente_nombre)
            SELECT :n, p.id_profesional, :ini, :fin, 'confirmada', :cliente
              FROM reserva.reserva_profesional p
             WHERE p.id_negocio = :n LIMIT 1
            RETURNING codigo_publico;
            `,
            {
                n: negocioDemo,
                ini: dentro,
                fin: new Date(dentro.getTime() + 30 * 60_000),
                cliente: `${CLIENTE} inminente`,
            }
        );

        await expect(
            ejecutar('cancelar_cita', { codigo_cita: fila.codigo_publico })
        ).rejects.toMatchObject({ code: 'CANCELACION_TARDE' });
    });
});
