/**
 * Suite hostil del dominio de `reserva` (F3 — ADR-003, ADR-009, ADR-010).
 *
 * **Ataca la API de dominio directamente, nunca el formulario.** Ése es el punto: hasta F3
 * las invariantes las protegía el Angular, que consultaba disponibilidad y solo ofrecía lo
 * válido. Un agente no tiene esa cortesía y `curl` tampoco. Si estos tests pasan, el dominio
 * se defiende solo, venga quien venga.
 *
 * Criterios de aceptación de F3 que se comprueban aquí:
 *   1. Es imposible crear una cita fuera del horario laboral, sobre un bloqueo o en un
 *      estado inválido, llamando directamente al servicio.
 *   2. Un slot devuelto por disponibilidad SIEMPRE puede confirmarse (incluida la carrera
 *      entre dos peticiones simultáneas).
 *   3. Un hold expirado libera el slot automáticamente.
 *   4. La transición `completada → pendiente` es rechazada por el dominio.
 *
 * Requiere la BD local con la agenda de reserva y la tabla de holds:
 *   psql ... -f scripts/fixtures/dev_reserva.sql
 *   npm run migrate:reserva-hold
 *
 * Correr con:  npx jest __tests__/reserva/ --runInBand
 */
require('dotenv').config();
const Models = require('../../app_core/models/conection');
const Citas = require('../../app_reserva_api/services/citaService');
const CitaListado = require('../../app_reserva_api/services/citaListadoService');
const Disponibilidad = require('../../app_reserva_api/services/disponibilidadService');
const Holds = require('../../app_reserva_api/services/holdService');
const Reglas = require('../../app_reserva_api/services/reglasAgenda');
const EstadoCita = require('../../app_reserva_api/services/estadoCita');

const sequelize = Models.sequelize;

/** Marca de todo lo que crea esta suite, para poder borrarlo sin tocar nada más. */
const MARCA = 'TEST-F3';

let idNegocio;
let idServicio;
let duracionServicio;
let idProfesional;
let cfgOriginal;

async function unaFila(sql, replacements = {}) {
    const [[fila]] = await sequelize.query(sql, { replacements });
    return fila ?? null;
}

/** Fecha futura y estable: la anticipación mínima descarta lo que ya pasó. */
function proximoDiaSemana(objetivo, semanasAdelante = 2) {
    const d = new Date();
    d.setDate(d.getDate() + 7 * semanasAdelante);
    while (d.getDay() !== objetivo) d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const LUNES = () => proximoDiaSemana(1);
const DOMINGO = () => proximoDiaSemana(0);

function crear(fechaHoraInicioISO, extra = {}) {
    return Citas.crearCita({
        idNegocio,
        idProfesional,
        idServicios: [idServicio],
        fechaHoraInicioISO,
        clienteNombre: `${MARCA} cliente`,
        ...extra,
    });
}

async function limpiar() {
    await sequelize.query(`DELETE FROM reserva.reserva_hold WHERE id_negocio = :n;`, { replacements: { n: idNegocio } });
    await sequelize.query(
        `DELETE FROM reserva.reserva_cita_servicio
          WHERE id_cita IN (SELECT id_cita FROM reserva.reserva_cita WHERE cliente_nombre LIKE :m);`,
        { replacements: { m: `${MARCA}%` } }
    );
    await sequelize.query(`DELETE FROM reserva.reserva_cita WHERE cliente_nombre LIKE :m;`, { replacements: { m: `${MARCA}%` } });
    await sequelize.query(`DELETE FROM reserva.reserva_bloqueo WHERE motivo LIKE :m;`, { replacements: { m: `${MARCA}%` } });
}

beforeAll(async () => {
    idNegocio = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`))?.id_negocio;

    const svc = await unaFila(
        `SELECT id_servicio, duracion_min FROM reserva.reserva_servicio WHERE id_negocio = :n AND nombre = 'Corte de cabello';`,
        { n: idNegocio }
    );
    const pro = await unaFila(
        `SELECT id_profesional FROM reserva.reserva_profesional WHERE id_negocio = :n AND nombre = 'Marco Ruiz';`,
        { n: idNegocio }
    );
    if (!svc || !pro) {
        throw new Error('Falta la agenda de reserva. Ejecuta scripts/fixtures/dev_reserva.sql.');
    }

    idServicio = svc.id_servicio;
    duracionServicio = svc.duracion_min;
    idProfesional = pro.id_profesional;

    cfgOriginal = await Disponibilidad.getConfig(idNegocio);
    await limpiar();
});

afterEach(async () => {
    await limpiar();
    await sequelize.query(`UPDATE reserva.reserva_config SET buffer_limpieza_min = :b WHERE id_negocio = :n;`, {
        replacements: { b: cfgOriginal.buffer_limpieza_min, n: idNegocio },
    });
});

afterAll(async () => {
    await sequelize.close();
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('CRITERIO 1 — el dominio rechaza lo inválido sin ayuda del formulario', () => {
    it('un domingo: el negocio no abre', async () => {
        await expect(crear(`${DOMINGO()}T10:00:00`)).rejects.toMatchObject({ code: 'FUERA_DE_HORARIO' });
    });

    it('a medianoche de un día laborable', async () => {
        await expect(crear(`${LUNES()}T00:00:00`)).rejects.toMatchObject({ code: 'FUERA_DE_HORARIO' });
    });

    it('a las 8:30, media hora antes de abrir', async () => {
        await expect(crear(`${LUNES()}T08:30:00`)).rejects.toMatchObject({ code: 'FUERA_DE_HORARIO' });
    });

    it('durante la pausa del almuerzo (13:00–14:00)', async () => {
        await expect(crear(`${LUNES()}T13:15:00`)).rejects.toMatchObject({ code: 'FUERA_DE_HORARIO' });
    });

    it('a caballo entre la jornada y el almuerzo: no cabe entera en un tramo', async () => {
        // 12:45 + 30 min = 13:15, pasado el cierre de la mañana. Antes se aceptaba: nadie
        // comprobaba que la cita cupiera dentro de un intervalo laboral.
        await expect(crear(`${LUNES()}T12:45:00`)).rejects.toMatchObject({ code: 'FUERA_DE_HORARIO' });
    });

    it('sobre las vacaciones del profesional', async () => {
        const lunes = LUNES();
        await sequelize.query(
            `INSERT INTO reserva.reserva_bloqueo (id_negocio, id_profesional, fecha_inicio, fecha_fin, motivo)
             VALUES (:n, :p, :ini, :fin, :m);`,
            {
                replacements: {
                    n: idNegocio, p: idProfesional,
                    ini: `${lunes} 00:00:00`, fin: `${lunes} 23:59:59`,
                    m: `${MARCA} vacaciones`,
                },
            }
        );

        await expect(crear(`${lunes}T10:00:00`)).rejects.toMatchObject({ code: 'SOBRE_BLOQUEO' });
    });

    it('sobre un bloqueo de un par de horas, no del día entero', async () => {
        const lunes = LUNES();
        await sequelize.query(
            `INSERT INTO reserva.reserva_bloqueo (id_negocio, id_profesional, fecha_inicio, fecha_fin, motivo)
             VALUES (:n, :p, :ini, :fin, :m);`,
            {
                replacements: {
                    n: idNegocio, p: idProfesional,
                    ini: `${lunes} 10:00:00`, fin: `${lunes} 12:00:00`,
                    m: `${MARCA} formación`,
                },
            }
        );

        await expect(crear(`${lunes}T10:30:00`)).rejects.toMatchObject({ code: 'SOBRE_BLOQUEO' });
        // Y fuera del bloqueo la agenda sigue funcionando: la invariante acota, no apaga.
        await expect(crear(`${lunes}T09:00:00`)).resolves.toBeTruthy();
    });

    it('una hora válida sí se acepta (si no, los tests anteriores no prueban nada)', async () => {
        const cita = await crear(`${LUNES()}T10:00:00`);
        expect(cita.id_cita).toEqual(expect.any(Number));
        expect(cita.estado).toBe('pendiente');
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('CRITERIO 2 — un slot ofrecido siempre se puede confirmar', () => {
    /**
     * Éste es el test que faltaba. El bug era real: disponibilidad expandía cada cita
     * `buffer/2` a cada lado y creación la expandía entera, así que existía una banda de
     * horas que el sistema ofrecía y luego rechazaba con un 409.
     */
    it.each([10, 20, 30, 45])('con buffer de %i minutos, todo slot ofrecido se confirma', async (buffer) => {
        const lunes = LUNES();
        await sequelize.query(`UPDATE reserva.reserva_config SET buffer_limpieza_min = :b WHERE id_negocio = :n;`, {
            replacements: { b: buffer, n: idNegocio },
        });

        // Se ocupa el centro de la mañana para que el buffer tenga contra qué medir.
        await crear(`${lunes}T10:00:00`);

        const { slots } = await Disponibilidad.calcularSlots({
            idNegocio, idServicio, idProfesional, fechaISO: lunes,
        });
        const ofrecidos = slots.filter((s) => s.disponible).map((s) => s.hora);
        expect(ofrecidos.length).toBeGreaterThan(0);

        // Se verifica cada hora ofrecida contra la MISMA puerta que usa `crearCita`. No se
        // crean todas porque crear una cambiaría la disponibilidad de las siguientes.
        for (const hora of ofrecidos) {
            const inicio = new Date(`${lunes}T${hora}:00-05:00`);
            await expect(
                Reglas.verificarReservable({
                    idNegocio,
                    idProfesional,
                    inicio,
                    fin: Reglas.addMinutes(inicio, duracionServicio),
                    bufferMin: buffer,
                })
            ).resolves.toBeUndefined();
        }
    });

    it('el buffer se respeta de verdad: la hora pegada a una cita NO se ofrece', async () => {
        const lunes = LUNES();
        await sequelize.query(`UPDATE reserva.reserva_config SET buffer_limpieza_min = 30 WHERE id_negocio = :n;`, {
            replacements: { n: idNegocio },
        });

        await crear(`${lunes}T10:00:00`); // ocupa 10:00–10:30

        const { slots } = await Disponibilidad.calcularSlots({
            idNegocio, idServicio, idProfesional, fechaISO: lunes,
        });
        const ofrecidos = slots.filter((s) => s.disponible).map((s) => s.hora);

        // Con 30 min de buffer, lo siguiente reservable empieza a las 11:00, no a las 10:45.
        expect(ofrecidos).not.toContain('10:45');
        expect(ofrecidos).toContain('11:00');
    });

    it('CARRERA: dos peticiones simultáneas por el mismo hueco producen UNA cita', async () => {
        const cuando = `${LUNES()}T11:00:00`;

        const resultados = await Promise.allSettled([crear(cuando), crear(cuando)]);
        const ok = resultados.filter((r) => r.status === 'fulfilled');
        const ko = resultados.filter((r) => r.status === 'rejected');

        expect(ok).toHaveLength(1);
        expect(ko).toHaveLength(1);
        expect(ko[0].reason.code).toBe('SLOT_NO_DISPONIBLE');

        const { n } = await unaFila(
            `SELECT count(*)::int AS n FROM reserva.reserva_cita WHERE cliente_nombre LIKE :m AND estado IN ('pendiente','confirmada');`,
            { m: `${MARCA}%` }
        );
        expect(n).toBe(1);
    });

    it('una cita cancelada devuelve su hueco a la agenda', async () => {
        const lunes = LUNES();
        const cita = await crear(`${lunes}T10:00:00`);
        await CitaListado.cambiarEstado(cita.id_cita, idNegocio, 'cancelada');

        await expect(crear(`${lunes}T10:00:00`)).resolves.toBeTruthy();
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('CRITERIO 3 — el hold protege el hueco y lo suelta al caducar', () => {
    it('un hold activo impide crear una cita encima', async () => {
        const lunes = LUNES();
        const hold = await Holds.tomar({
            idNegocio, idProfesional, idServicios: [idServicio],
            fechaHoraInicioISO: `${lunes}T10:00:00`,
        });
        expect(hold.codigo).toEqual(expect.any(String));

        await expect(crear(`${lunes}T10:00:00`)).rejects.toMatchObject({ code: 'SLOT_NO_DISPONIBLE' });
    });

    it('y también impide un segundo hold sobre lo mismo', async () => {
        const lunes = LUNES();
        await Holds.tomar({ idNegocio, idProfesional, idServicios: [idServicio], fechaHoraInicioISO: `${lunes}T10:00:00` });

        await expect(
            Holds.tomar({ idNegocio, idProfesional, idServicios: [idServicio], fechaHoraInicioISO: `${lunes}T10:00:00` })
        ).rejects.toMatchObject({ code: 'SLOT_NO_DISPONIBLE' });
    });

    it('un hold EXPIRADO libera el hueco sin que nadie lo borre', async () => {
        const lunes = LUNES();
        const hold = await Holds.tomar({
            idNegocio, idProfesional, idServicios: [idServicio],
            fechaHoraInicioISO: `${lunes}T10:00:00`,
        });

        // Se envejece el hold en la base. La fila sigue ahí, con estado 'activo': lo único
        // que cambia es el reloj. Si hiciera falta un cron para liberar el hueco, este test
        // fallaría — y ése es justo el punto.
        await sequelize.query(`UPDATE reserva.reserva_hold SET expira_en = now() - interval '1 second' WHERE id_hold = :h;`, {
            replacements: { h: hold.id_hold },
        });

        await expect(crear(`${lunes}T10:00:00`)).resolves.toBeTruthy();

        const fila = await unaFila(`SELECT estado FROM reserva.reserva_hold WHERE id_hold = :h;`, { h: hold.id_hold });
        expect(fila.estado).toBe('activo'); // nadie tocó la fila; solo dejó de contar
    });

    it('confirmar un hold crea la cita y lo marca consumido, en una sola transacción', async () => {
        const lunes = LUNES();
        const hold = await Holds.tomar({
            idNegocio, idProfesional, idServicios: [idServicio],
            fechaHoraInicioISO: `${lunes}T10:00:00`,
        });

        const cita = await crear(`${lunes}T10:00:00`, { consumirHoldId: hold.id_hold });

        const fila = await unaFila(`SELECT estado, id_cita FROM reserva.reserva_hold WHERE id_hold = :h;`, { h: hold.id_hold });
        expect(fila.estado).toBe('confirmado');
        expect(fila.id_cita).toBe(cita.id_cita);
    });

    it('liberar un hold devuelve el hueco de inmediato, y es idempotente', async () => {
        const lunes = LUNES();
        const hold = await Holds.tomar({
            idNegocio, idProfesional, idServicios: [idServicio],
            fechaHoraInicioISO: `${lunes}T10:00:00`,
        });

        expect(await Holds.liberar(hold.codigo, idNegocio)).toBe(true);
        expect(await Holds.liberar(hold.codigo, idNegocio)).toBe(false); // ya estaba liberado
        await expect(crear(`${lunes}T10:00:00`)).resolves.toBeTruthy();
    });

    it('no se puede tomar un hold sobre un domingo: la misma puerta que crear', async () => {
        await expect(
            Holds.tomar({ idNegocio, idProfesional, idServicios: [idServicio], fechaHoraInicioISO: `${DOMINGO()}T10:00:00` })
        ).rejects.toMatchObject({ code: 'FUERA_DE_HORARIO' });
    });

    it('el hold de otro negocio no se encuentra por código', async () => {
        const hold = await Holds.tomar({
            idNegocio, idProfesional, idServicios: [idServicio],
            fechaHoraInicioISO: `${LUNES()}T10:00:00`,
        });

        expect(await Holds.vigentePorCodigo(hold.codigo, idNegocio)).not.toBeNull();
        expect(await Holds.vigentePorCodigo(hold.codigo, 999999)).toBeNull();
    });

    it('el TTL tiene techo: no se puede retener la agenda un día entero', async () => {
        const hold = await Holds.tomar({
            idNegocio, idProfesional, idServicios: [idServicio],
            fechaHoraInicioISO: `${LUNES()}T10:00:00`,
            ttlMinutos: 60 * 24,
        });

        const minutos = (new Date(hold.expira_en) - Date.now()) / 60_000;
        expect(minutos).toBeLessThanOrEqual(Holds.TTL_MINUTOS_MAXIMO + 1);
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('CRITERIO 4 — la máquina de estados', () => {
    it('completada → pendiente se rechaza en el dominio', async () => {
        const cita = await crear(`${LUNES()}T10:00:00`);
        await CitaListado.cambiarEstado(cita.id_cita, idNegocio, 'completada');

        await expect(CitaListado.cambiarEstado(cita.id_cita, idNegocio, 'pendiente')).rejects.toMatchObject({
            code: 'TRANSICION_INVALIDA',
        });
    });

    it('una cita cancelada no se puede completar', async () => {
        const cita = await crear(`${LUNES()}T10:00:00`);
        await CitaListado.cambiarEstado(cita.id_cita, idNegocio, 'cancelada');

        await expect(CitaListado.cambiarEstado(cita.id_cita, idNegocio, 'completada')).rejects.toMatchObject({
            code: 'TRANSICION_INVALIDA',
        });
    });

    it('repetir una transición se distingue de una inválida', async () => {
        const cita = await crear(`${LUNES()}T10:00:00`);
        await CitaListado.cambiarEstado(cita.id_cita, idNegocio, 'confirmada');

        await expect(CitaListado.cambiarEstado(cita.id_cita, idNegocio, 'confirmada')).rejects.toMatchObject({
            code: 'TRANSICION_REDUNDANTE',
        });
    });

    it('el camino normal funciona: pendiente → confirmada → completada', async () => {
        const cita = await crear(`${LUNES()}T10:00:00`);
        await CitaListado.cambiarEstado(cita.id_cita, idNegocio, 'confirmada');
        const fin = await CitaListado.cambiarEstado(cita.id_cita, idNegocio, 'completada');
        expect(fin.estado).toBe('completada');
    });

    it('pendiente → completada también, para el cliente que llega y se atiende', async () => {
        const cita = await crear(`${LUNES()}T10:00:00`);
        const fin = await CitaListado.cambiarEstado(cita.id_cita, idNegocio, 'completada');
        expect(fin.estado).toBe('completada');
    });

    it('los tres estados terminales lo son de verdad', () => {
        expect(EstadoCita.TERMINALES.sort()).toEqual(['cancelada', 'completada', 'no_show']);
        for (const terminal of EstadoCita.TERMINALES) {
            for (const destino of Object.values(EstadoCita.ESTADO)) {
                expect(EstadoCita.puedeTransitar(terminal, destino)).toBe(false);
            }
        }
    });

    it('una cita que no existe devuelve null, no un error de transición', async () => {
        expect(await CitaListado.cambiarEstado(999999, idNegocio, 'confirmada')).toBeNull();
    });

    it('y una cita de otro negocio tampoco se toca', async () => {
        const cita = await crear(`${LUNES()}T10:00:00`);
        expect(await CitaListado.cambiarEstado(cita.id_cita, 999999, 'confirmada')).toBeNull();
    });
});
