/**
 * Suite de capacidades (F4-A — ADR-007, ADR-008, ADR-010, ADR-021).
 *
 * Cubre los criterios de aceptación de F4 que F4-A puede cumplir hoy:
 *
 *   2. Invocar una capacidad con un `id_negocio` falsificado en los argumentos no tiene
 *      ningún efecto.
 *   4. Toda invocación aparece en la auditoría, con sus argumentos.
 *   5. El dry-run de una capacidad de mutación no deja rastro en el dominio.
 *
 * Los criterios 1 (agendar/reagendar/cancelar desde la CLI) y 3 (idempotencia) son de F4-B:
 * necesitan mutaciones, y las mutaciones de `reserva` dependen de F3 (invariantes en el
 * dominio y hold con TTL). Ver `intelligence/adapters/reserva/index.js`.
 *
 * Requiere la BD local con dos negocios y la agenda de reserva:
 *   node scripts/seed_dev_local.js
 *   psql ... -f scripts/fixtures/dev_segundo_negocio.sql
 *   psql ... -f scripts/fixtures/dev_reserva.sql
 *   npm run migrate:platform-capacidades
 *
 * Correr con:  npx jest __tests__/platform/capacidades.test.js --runInBand
 */
require('dotenv').config();

// Las capacidades exigen la feature comercial y ningún plan la incluye todavía. Se fuerza
// ANTES de cargar el módulo porque `features.js` lee la variable al importarse.
process.env.FEATURES_FORZADAS = 'asistente_ia';

const db = require('../../app_core/models/conection');
const { resolverPrincipalUsuario, crearPrincipal, TIPO } = require('../../app_core/authz/principal');
const intelligence = require('../../intelligence');
const registry = require('../../intelligence/core/registry');
const policyGate = require('../../intelligence/core/policyGate');

const sequelize = db.sequelize;

const ADMIN_DEMO = '1000000002';
const ADMIN_RIVAL = '1000000003';

let idAdminDemo;
let idAdminRival;
let negocioDemo;
let negocioRival;
let principalDemo;
let principalRival;

/** Nombre reservado para las capacidades sintéticas de esta suite. */
const CAPACIDAD_FALSA = 'capacidad_de_prueba';
const MUTACION_FALSA = 'mutacion_de_prueba';

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

/** Última fila de auditoría de una capacidad. Es cómo se comprueba el criterio 4. */
async function ultimaAuditoria(accion) {
    return unaFila(
        `
        SELECT resultado, detalle, id_negocio, id_usuario
          FROM auditoria.audit_evento
         WHERE modulo = :modulo AND accion = :accion
         ORDER BY id_evento DESC
         LIMIT 1;
        `,
        { modulo: policyGate.MODULO_AUDITORIA, accion }
    );
}

beforeAll(async () => {
    intelligence.arrancar();

    idAdminDemo = (await unaFila(`SELECT id_usuario FROM general.gener_usuario WHERE num_identificacion = :n;`, { n: ADMIN_DEMO }))?.id_usuario;
    idAdminRival = (await unaFila(`SELECT id_usuario FROM general.gener_usuario WHERE num_identificacion = :n;`, { n: ADMIN_RIVAL }))?.id_usuario;
    negocioDemo = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`))?.id_negocio;
    negocioRival = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Rival';`))?.id_negocio;

    if (!idAdminRival || !negocioRival) {
        throw new Error(
            'Faltan los datos de dos inquilinos. Ejecuta scripts/seed_dev_local.js y ' +
                'scripts/fixtures/dev_segundo_negocio.sql antes de esta suite.'
        );
    }

    const servicios = await unaFila(`SELECT count(*)::int AS n FROM reserva.reserva_servicio WHERE id_negocio = :n;`, { n: negocioDemo });
    if (!servicios || servicios.n === 0) {
        throw new Error('Falta la agenda de reserva. Ejecuta scripts/fixtures/dev_reserva.sql.');
    }

    principalDemo = await resolverPrincipalUsuario(idAdminDemo);
    principalRival = await resolverPrincipalUsuario(idAdminRival);

    // Capacidad sintética: permite probar el Gate sin depender de qué haga una capacidad
    // real, y permite tener una MUTACIÓN antes de que exista ninguna en el catálogo.
    registry.registrar({
        nombre: CAPACIDAD_FALSA,
        descripcion: 'Capacidad sintética para ejercitar el Policy Gate en los tests.',
        vertical: 'pruebas',
        tipo: registry.TIPO.CONSULTA,
        feature: 'asistente_ia',
        parametros: { eco: { tipo: 'string', requerido: false, max_longitud: 20 } },
        async ejecutar({ idNegocio, args }) {
            return { visto_id_negocio: idNegocio, eco: args.eco ?? null };
        },
    });

    registry.registrar({
        nombre: MUTACION_FALSA,
        descripcion: 'Mutación sintética que escribe en el dominio, para probar el dry-run.',
        vertical: 'pruebas',
        tipo: registry.TIPO.MUTACION,
        idempotente: false,
        // La suite la ejecuta sin pasar por ninguna conversación, así que declara que no exige
        // confirmación (F7). Lo que se prueba aquí es el Gate, no el ciclo de ADR-010: eso vive
        // en `capacidades_mutaciones.test.js` y en `confirmacion.test.js`.
        confirmacion: registry.CONFIRMACION.NO_REQUIERE,
        feature: 'asistente_ia',
        parametros: { nombre: { tipo: 'string', requerido: true, max_longitud: 100 } },
        async ejecutar({ idNegocio, args, contexto }) {
            const [fila] = await sequelize.query(
                `
                INSERT INTO reserva.reserva_servicio (id_negocio, nombre, duracion_min, precio, estado)
                VALUES (:idNegocio, :nombre, 15, 0, 'A')
                RETURNING id_servicio;
                `,
                {
                    replacements: { idNegocio, nombre: args.nombre },
                    type: sequelize.QueryTypes.SELECT,
                    // Sin esta transacción el dry-run no podría deshacer nada. Es el contrato
                    // entre el Gate y toda capacidad de mutación.
                    transaction: contexto.transaction,
                }
            );
            return { id_servicio: fila.id_servicio };
        },
    });

    await habilitar(negocioDemo, CAPACIDAD_FALSA);
    await habilitar(negocioDemo, MUTACION_FALSA);
    await habilitar(negocioDemo, 'consultar_servicios');
    await habilitar(negocioDemo, 'consultar_disponibilidad');
});

afterAll(async () => {
    await sequelize.query(`DELETE FROM platform.capacidad_habilitada WHERE capacidad IN (:c);`, {
        replacements: { c: [CAPACIDAD_FALSA, MUTACION_FALSA] },
    });
    await sequelize.query(`DELETE FROM reserva.reserva_servicio WHERE nombre LIKE 'DRY-RUN %';`);
    intelligence._reiniciar();
    await sequelize.close();
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('Capability Registry (ADR-008)', () => {
    it('registra el catálogo del adaptador piloto', () => {
        const nombres = registry.listar({ vertical: 'reserva' }).map((c) => c.nombre);
        expect(nombres).toEqual(expect.arrayContaining(['consultar_servicios', 'consultar_disponibilidad']));
    });

    it('RECHAZA un manifiesto que declare id_negocio como parámetro (ADR-010)', () => {
        expect(() =>
            registry.registrar({
                nombre: 'capacidad_insegura',
                descripcion: 'Intenta declarar el id_negocio como parámetro del modelo.',
                vertical: 'pruebas',
                tipo: registry.TIPO.CONSULTA,
                feature: 'asistente_ia',
                parametros: { id_negocio: { tipo: 'entero' } },
                ejecutar: async () => ({}),
            })
        ).toThrow(/id_negocio lo inyecta la plataforma/i);
    });

    it('exige declarar la idempotencia en toda mutación (capability-language.md §4)', () => {
        expect(() =>
            registry.registrar({
                nombre: 'mutacion_sin_declarar',
                descripcion: 'Una mutación que no dice si repetirla es seguro.',
                vertical: 'pruebas',
                tipo: registry.TIPO.MUTACION,
                confirmacion: registry.CONFIRMACION.NO_REQUIERE,
                feature: 'asistente_ia',
                ejecutar: async () => ({}),
            })
        ).toThrow(/idempotente/i);
    });

    it('exige declarar la confirmación humana en toda mutación (ADR-010, F7)', () => {
        // Sin valor por defecto y a propósito: el único seguro sería exigir confirmación siempre,
        // y eso convierte el hold de `proponer_turno` en una pregunta de más. Que se declare es lo
        // que evita que una mutación nueva se ejecute sola porque nadie se acordó.
        expect(() =>
            registry.registrar({
                nombre: 'mutacion_sin_confirmacion',
                descripcion: 'Una mutación que no dice si hay que preguntarle al cliente.',
                vertical: 'pruebas',
                tipo: registry.TIPO.MUTACION,
                idempotente: true,
                feature: 'asistente_ia',
                ejecutar: async () => ({}),
            })
        ).toThrow(/confirmacion/i);
    });

    it('rechaza una confirmación declarada a medias', () => {
        expect(() =>
            registry.registrar({
                nombre: 'mutacion_media_confirmacion',
                descripcion: 'Declara la pregunta pero no qué se le dice al cliente después.',
                vertical: 'pruebas',
                tipo: registry.TIPO.MUTACION,
                idempotente: true,
                confirmacion: { pregunta: () => '¿Seguro?' },
                feature: 'asistente_ia',
                ejecutar: async () => ({}),
            })
        ).toThrow(/hecho/i);
    });

    it('rechaza nombres que no sean verbos de negocio en minúsculas', () => {
        expect(() =>
            registry.registrar({
                nombre: 'ActualizarCampoFechaHoraInicio',
                descripcion: 'CRUD disfrazado con nombre técnico.',
                vertical: 'pruebas',
                tipo: registry.TIPO.CONSULTA,
                feature: 'asistente_ia',
                ejecutar: async () => ({}),
            })
        ).toThrow(/Nombre de capacidad inválido/i);
    });

    it('no permite dos capacidades con el mismo nombre', () => {
        expect(() =>
            registry.registrar({
                nombre: CAPACIDAD_FALSA,
                descripcion: 'Un duplicado del catálogo, que rompería el vocabulario único.',
                vertical: 'pruebas',
                tipo: registry.TIPO.CONSULTA,
                feature: 'asistente_ia',
                ejecutar: async () => ({}),
            })
        ).toThrow(/ya está registrada/i);
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('Policy Gate — el id_negocio lo impone la plataforma (ADR-010)', () => {
    it('CRITERIO 2: un id_negocio falsificado en los argumentos no tiene ningún efecto', async () => {
        await expect(
            policyGate.ejecutar({
                capacidad: CAPACIDAD_FALSA,
                principal: principalDemo,
                idNegocio: negocioDemo,
                args: { id_negocio: negocioRival },
            })
        ).rejects.toMatchObject({ code: policyGate.DENEGADO.ID_NEGOCIO_EN_ARGUMENTOS });
    });

    it('tampoco cuela en camelCase ni con nombres de otras plataformas', async () => {
        for (const clave of ['idNegocio', 'tenant_id', 'tenantId']) {
            await expect(
                policyGate.ejecutar({
                    capacidad: CAPACIDAD_FALSA,
                    principal: principalDemo,
                    idNegocio: negocioDemo,
                    args: { [clave]: negocioRival },
                })
            ).rejects.toMatchObject({ code: policyGate.DENEGADO.ID_NEGOCIO_EN_ARGUMENTOS });
        }
    });

    it('la capacidad recibe el id_negocio del Principal, no el de los argumentos', async () => {
        const { resultado } = await policyGate.ejecutar({
            capacidad: CAPACIDAD_FALSA,
            principal: principalDemo,
            idNegocio: negocioDemo,
            args: {},
        });
        expect(resultado.visto_id_negocio).toBe(negocioDemo);
    });

    it('el intento queda auditado con el valor que se intentó colar', async () => {
        await expect(
            policyGate.ejecutar({
                capacidad: CAPACIDAD_FALSA,
                principal: principalDemo,
                idNegocio: negocioDemo,
                args: { id_negocio: negocioRival },
            })
        ).rejects.toThrow();

        const fila = await ultimaAuditoria(CAPACIDAD_FALSA);
        expect(fila.resultado).toBe('denegado');
        expect(fila.detalle.motivo).toBe(policyGate.DENEGADO.ID_NEGOCIO_EN_ARGUMENTOS);
        expect(fila.detalle.valor_intentado).toBe(negocioRival);
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('Policy Gate — las tres capas (ADR-021)', () => {
    it('deniega a quien no pertenece al negocio, aunque la capacidad esté habilitada', async () => {
        await expect(
            policyGate.ejecutar({
                capacidad: CAPACIDAD_FALSA,
                principal: principalRival,
                idNegocio: negocioDemo,
                args: {},
            })
        ).rejects.toMatchObject({ code: policyGate.DENEGADO.PRINCIPAL_AJENO });
    });

    it('DOMINIO: sin fila en capacidad_habilitada, deniega (la ausencia no autoriza)', async () => {
        await expect(
            policyGate.ejecutar({
                capacidad: CAPACIDAD_FALSA,
                principal: principalRival,
                idNegocio: negocioRival,
                args: {},
            })
        ).rejects.toMatchObject({ code: policyGate.DENEGADO.CAPACIDAD_NO_HABILITADA });
    });

    it('DOMINIO: y deshabilitarla explícitamente también deniega', async () => {
        await habilitar(negocioDemo, CAPACIDAD_FALSA, false);
        try {
            await expect(
                policyGate.ejecutar({
                    capacidad: CAPACIDAD_FALSA,
                    principal: principalDemo,
                    idNegocio: negocioDemo,
                    args: {},
                })
            ).rejects.toMatchObject({ code: policyGate.DENEGADO.CAPACIDAD_NO_HABILITADA });
        } finally {
            // En try/finally: una aserción fallida que dejara la capacidad apagada
            // arrastraría el fallo a todos los tests siguientes.
            await habilitar(negocioDemo, CAPACIDAD_FALSA, true);
        }
    });

    it('una capacidad que no existe se deniega, no revienta', async () => {
        await expect(
            policyGate.ejecutar({
                capacidad: 'capacidad_que_nadie_registro',
                principal: principalDemo,
                idNegocio: negocioDemo,
                args: {},
            })
        ).rejects.toMatchObject({ code: policyGate.DENEGADO.NO_EXISTE });
    });

    it('un principal sin negocios no ejecuta nada', async () => {
        const nadie = crearPrincipal({ tipo: TIPO.USUARIO, idUsuario: 999999 });
        await expect(
            policyGate.ejecutar({
                capacidad: CAPACIDAD_FALSA,
                principal: nadie,
                idNegocio: negocioDemo,
                args: {},
            })
        ).rejects.toMatchObject({ code: policyGate.DENEGADO.PRINCIPAL_AJENO });
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('Validación estricta de argumentos', () => {
    it('rechaza un parámetro no declarado en vez de ignorarlo en silencio', async () => {
        await expect(
            policyGate.ejecutar({
                capacidad: CAPACIDAD_FALSA,
                principal: principalDemo,
                idNegocio: negocioDemo,
                args: { descuento: 90 },
            })
        ).rejects.toMatchObject({ code: 'ARGUMENTOS_INVALIDOS' });
    });

    it('exige los parámetros obligatorios', async () => {
        await expect(
            policyGate.ejecutar({
                capacidad: 'consultar_disponibilidad',
                principal: principalDemo,
                idNegocio: negocioDemo,
                args: { fecha: '2026-08-10' },
            })
        ).rejects.toThrow(/id_servicio/);
    });

    it('rechaza una fecha que no es una fecha', async () => {
        await expect(
            policyGate.ejecutar({
                capacidad: 'consultar_disponibilidad',
                principal: principalDemo,
                idNegocio: negocioDemo,
                args: { id_servicio: 1, fecha: 'mañana' },
            })
        ).rejects.toMatchObject({ code: 'ARGUMENTOS_INVALIDOS' });
    });

    it('rechaza un entero que no lo es', async () => {
        await expect(
            policyGate.ejecutar({
                capacidad: 'consultar_disponibilidad',
                principal: principalDemo,
                idNegocio: negocioDemo,
                args: { id_servicio: 'el primero', fecha: '2026-08-10' },
            })
        ).rejects.toMatchObject({ code: 'ARGUMENTOS_INVALIDOS' });
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('Dry-run (criterio 5)', () => {
    it('una mutación en seco NO deja rastro en el dominio', async () => {
        const nombre = `DRY-RUN ${Date.now()}`;

        const { dry_run, resultado } = await policyGate.ejecutar({
            capacidad: MUTACION_FALSA,
            principal: principalDemo,
            idNegocio: negocioDemo,
            args: { nombre },
            dryRun: true,
        });

        expect(dry_run).toBe(true);
        // La capacidad sí se ejecutó de verdad: devolvió el id que la secuencia le asignó.
        // Eso es lo que hace útil al dry-run — no simula, ejecuta y deshace.
        expect(resultado.id_servicio).toEqual(expect.any(Number));

        const fila = await unaFila(`SELECT id_servicio FROM reserva.reserva_servicio WHERE nombre = :nombre;`, { nombre });
        expect(fila).toBeNull();
    });

    it('la misma mutación sin dry-run SÍ deja rastro (si no, el test anterior no prueba nada)', async () => {
        const nombre = `DRY-RUN real ${Date.now()}`;

        await policyGate.ejecutar({
            capacidad: MUTACION_FALSA,
            principal: principalDemo,
            idNegocio: negocioDemo,
            args: { nombre },
        });

        const fila = await unaFila(`SELECT id_servicio FROM reserva.reserva_servicio WHERE nombre = :nombre;`, { nombre });
        expect(fila).not.toBeNull();
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('Auditoría (criterio 4)', () => {
    it('toda invocación correcta queda auditada, con sus argumentos', async () => {
        await policyGate.ejecutar({
            capacidad: CAPACIDAD_FALSA,
            principal: principalDemo,
            idNegocio: negocioDemo,
            args: { eco: 'hola' },
        });

        const fila = await ultimaAuditoria(CAPACIDAD_FALSA);
        expect(fila.resultado).toBe('ok');
        expect(fila.id_negocio).toBe(negocioDemo);
        expect(fila.id_usuario).toBe(idAdminDemo);
        expect(fila.detalle.argumentos).toEqual({ eco: 'hola' });
        expect(fila.detalle.dry_run).toBe(false);
    });

    it('el dry-run queda marcado como tal en la auditoría', async () => {
        await policyGate.ejecutar({
            capacidad: MUTACION_FALSA,
            principal: principalDemo,
            idNegocio: negocioDemo,
            args: { nombre: `DRY-RUN auditoria ${Date.now()}` },
            dryRun: true,
        });

        const fila = await ultimaAuditoria(MUTACION_FALSA);
        expect(fila.resultado).toBe('ok');
        expect(fila.detalle.dry_run).toBe(true);
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('Adaptador de reserva (ADR-009)', () => {
    it('consultar_servicios devuelve el catálogo del negocio', async () => {
        const { resultado } = await policyGate.ejecutar({
            capacidad: 'consultar_servicios',
            principal: principalDemo,
            idNegocio: negocioDemo,
            args: {},
        });

        expect(resultado.servicios.length).toBeGreaterThan(0);
        expect(resultado.servicios[0]).toHaveProperty('duracion_min');
    });

    it('consultar_disponibilidad funde las agendas sin pedir profesional', async () => {
        const servicio = await unaFila(
            `SELECT id_servicio FROM reserva.reserva_servicio WHERE id_negocio = :n AND nombre = 'Corte de cabello';`,
            { n: negocioDemo }
        );

        const { resultado } = await policyGate.ejecutar({
            capacidad: 'consultar_disponibilidad',
            principal: principalDemo,
            idNegocio: negocioDemo,
            args: { id_servicio: servicio.id_servicio, fecha: proximoLunes() },
        });

        expect(resultado.horas.length).toBeGreaterThan(0);
        // Cada hora viene con quién la atiende: es lo que evita que la capacidad de reserva
        // de F4-B tenga que recalcular la disponibilidad entera.
        expect(resultado.horas[0]).toHaveProperty('id_profesional');
    });

    it('un domingo no hay horas (el negocio no abre)', async () => {
        const servicio = await unaFila(
            `SELECT id_servicio FROM reserva.reserva_servicio WHERE id_negocio = :n AND nombre = 'Corte de cabello';`,
            { n: negocioDemo }
        );

        const { resultado } = await policyGate.ejecutar({
            capacidad: 'consultar_disponibilidad',
            principal: principalDemo,
            idNegocio: negocioDemo,
            args: { id_servicio: servicio.id_servicio, fecha: proximoDomingo() },
        });

        expect(resultado.horas).toEqual([]);
    });
});

/** Fechas futuras y estables: la anticipación mínima descarta las horas ya pasadas. */
function proximoDiaSemana(objetivo) {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    while (d.getDay() !== objetivo) d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function proximoLunes() {
    return proximoDiaSemana(1);
}
function proximoDomingo() {
    return proximoDiaSemana(0);
}

// ────────────────────────────────────────────────────────────────────────────────────────
describe('Una lista que el modelo manda como texto', () => {
    // Visto en producción el 2026-08-26, pidiendo comida. El modelo llamó a `tomar_pedido`
    // tres veces seguidas: la primera con `items: "106x1,109x1,111x2"` —el código compacto del
    // carrito, copiado tal cual—, la segunda con la lista correcta pero **serializada**, y solo
    // la tercera bien. Dos llamadas de más, ~2,5 s y sus tokens, por una comilla.
    //
    // Rechazar la primera es correcto: no es una lista, es otra cosa. Insistir en rechazar la
    // segunda era terquedad cara — los datos estaban completos y bien formados.
    const { validar } = require('../../intelligence/core/argumentos');

    const CAPACIDAD = {
        nombre: 'tomar_pedido',
        parametros: {
            items: {
                tipo: 'lista',
                requerido: true,
                min_items: 1,
                max_items: 20,
                elemento: {
                    id_producto: { tipo: 'entero', requerido: true, min: 1 },
                    cantidad: { tipo: 'entero', requerido: true, min: 1, max: 50 },
                },
            },
        },
    };

    const ESPERADO = [{ id_producto: 106, cantidad: 1 }, { id_producto: 111, cantidad: 2 }];

    it('la lista de verdad sigue valiendo', () => {
        expect(validar(CAPACIDAD, { items: ESPERADO }).items).toEqual(ESPERADO);
    });

    it('la misma lista serializada en JSON se acepta', () => {
        expect(validar(CAPACIDAD, { items: JSON.stringify(ESPERADO) }).items).toEqual(ESPERADO);
    });

    it('un texto que NO es una lista se sigue rechazando', () => {
        // El código compacto del carrito. Aceptar esto sería adivinar, y adivinar un pedido se
        // paga en la puerta del cliente.
        expect(() => validar(CAPACIDAD, { items: '106x1,109x1,111x2' })).toThrow(
            /debe ser una lista/
        );
    });

    it('un JSON que parsea pero no es una lista tampoco pasa', () => {
        expect(() => validar(CAPACIDAD, { items: '{"id_producto":106}' })).toThrow(
            /debe ser una lista/
        );
    });

    it('los elementos de la lista serializada se validan igual de estricto', () => {
        // La leniencia es sobre el envoltorio, no sobre el contenido: dentro, las mismas reglas.
        expect(() => validar(CAPACIDAD, { items: '[{"id_producto":"la primera","cantidad":1}]' })).toThrow(
            /entero/
        );
    });
});
