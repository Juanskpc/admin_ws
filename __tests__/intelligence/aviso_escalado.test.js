/**
 * El aviso de escalado — que el negocio se entere de que le pasaron una conversación.
 *
 * Lo que esta suite tiene que dejar clavado son dos promesas, y ninguna es «se manda un correo»:
 *
 *   1. **Solo se avisa de escalados que ocurrieron de verdad.** El evento se escribe dentro del
 *      savepoint del turno, así que un turno que revienta no avisa; y se emite solo en la
 *      transición, así que una conversación ya escalada no vuelve a avisar.
 *   2. **Avisar no puede volverse ruido.** Si el negocio ya la atendió en los segundos que tarda
 *      el relay, el aviso no sale; y una ráfaga de escalados produce un aviso, no cinco. Esa
 *      segunda regla es además lo que hace idempotente al consumidor, que el outbox exige porque
 *      entrega al menos una vez (ADR-012).
 *
 * Corre contra la base de verdad: todo lo que importa aquí —la atomicidad del evento, la ventana
 * de la campanita— está en SQL, y con dobles se probaría la maqueta en vez del mecanismo.
 *
 * Correr con:  npx jest __tests__/intelligence/aviso_escalado.test.js
 */
'use strict';
require('dotenv').config();

jest.mock('../../app_admin_api/services/mailService', () => ({
    sendConversacionEscaladaEmail: jest.fn(async () => {}),
}));

const Models = require('../../app_core/models/conection');
const motor = require('../../intelligence/engine/motor');
const handoff = require('../../intelligence/engine/handoff');
const escalado = require('../../intelligence/avisos/escalado');
const relay = require('../../app_core/outbox/outboxRelay');
const mailService = require('../../app_admin_api/services/mailService');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };

/** Canal sintético: nada real usa este nombre, así que la limpieza es inequívoca. */
const CANAL = 'test_aviso';
const CORREO_FIXTURE = 'aviso.escalado@qa.local';

let idNegocio;
let contador = 0;

const consulta = (sql, replacements = {}) => sequelize.query(sql, { replacements, ...SELECT });
const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;
const nuevoInterlocutor = () => `esc_${Date.now()}_${contador++}`;

/** El manejador de esta suite: siempre escala. Es lo único que se quiere ejercitar. */
const manejadorQueEscala = async () =>
    handoff.decision({ pasos: [], invocaciones: [], variables: {} }, { atencion: null });

const manejadorQueRevienta = async () => {
    throw new Error('el manejador se cayó a propósito');
};

/** Lleva una conversación a `handoff_humano` por el camino de verdad: un turno del motor. */
async function escalarPorUnTurno(idExterno) {
    await motor.recibir({ idNegocio, canal: CANAL, idExterno, texto: 'algo que no sé', despertar: false });
    const conversacion = await conversacionDe(idExterno);
    await motor.procesarConversacion(conversacion.id_conversacion);
    return conversacionDe(idExterno);
}

const conversacionDe = (idExterno) =>
    unaFila(
        `SELECT * FROM intelligence.conversacion
          WHERE id_negocio = :idNegocio AND canal = :canal AND id_externo = :idExterno;`,
        { idNegocio, canal: CANAL, idExterno }
    );

const eventosDe = (idConversacion) =>
    consulta(
        `SELECT id_evento, tipo, id_negocio, payload FROM platform.outbox
          WHERE tipo = 'conversacion.escalada.v1' AND payload->>'id_conversacion' = :id;`,
        { id: idConversacion }
    );

const avisosDelNegocio = () =>
    consulta(
        `SELECT id_notificacion, titulo, mensaje, fecha_creacion
           FROM general.gener_notificacion
          WHERE id_negocio = :idNegocio AND tipo = :tipo
          ORDER BY fecha_creacion;`,
        { idNegocio, tipo: escalado.TIPO_NOTIFICACION }
    );

/** El sobre que entrega el relay, tal y como lo compone `outboxDao.reclamarPendientes`. */
const sobreDe = (conversacion) => ({
    id_evento: '00000000-0000-0000-0000-000000000000',
    tipo: escalado.EVENTO,
    id_negocio: idNegocio,
    payload: { id_conversacion: conversacion.id_conversacion, canal: CANAL },
});

beforeAll(async () => {
    // Un negocio propio, y no el primero que haya en la base. Dos razones, y las dos son de esta
    // suite en concreto: `contarEsperando` cuenta **todas** las conversaciones escaladas del
    // negocio —sobre un negocio compartido, lo que dejen otras suites convierte la cuenta en una
    // lotería— y el correo se manda al contacto del negocio, que aquí hay que conocer. Se borra
    // entero al terminar, así que tampoco le cambia nada a nadie.
    const negocio = await unaFila(
        `INSERT INTO general.gener_negocio (nombre, email_contacto, estado)
         VALUES ('QA Aviso Escalado', :correo, 'A')
         RETURNING id_negocio;`,
        { correo: CORREO_FIXTURE }
    );
    idNegocio = negocio.id_negocio;
});

beforeEach(async () => {
    motor._reiniciar();
    motor.registrarManejador(manejadorQueEscala);
    mailService.sendConversacionEscaladaEmail.mockClear();
    // La ventana anti-ruido es por negocio y dura quince minutos: sin esto, el primer test le
    // taparía el aviso a todos los demás.
    await sequelize.query(
        `DELETE FROM general.gener_notificacion WHERE id_negocio = :idNegocio AND tipo = :tipo;`,
        { replacements: { idNegocio, tipo: escalado.TIPO_NOTIFICACION }, logging: false }
    );
});

afterEach(() => {
    motor.detener();
    relay.limpiarConsumidores();
});

afterAll(async () => {
    const ids = (
        await consulta(`SELECT id_conversacion FROM intelligence.conversacion WHERE canal = :canal;`, {
            canal: CANAL,
        })
    ).map((f) => f.id_conversacion);

    if (ids.length > 0) {
        // `IN` y no `ANY()`: Sequelize expande un array de reemplazo a una lista separada por
        // comas, que es lo que `IN` espera y lo que `ANY()` rechaza con un error de sintaxis.
        await sequelize.query(
            `DELETE FROM platform.outbox
              WHERE tipo = 'conversacion.escalada.v1' AND payload->>'id_conversacion' IN (:ids);`,
            { replacements: { ids }, logging: false }
        );
        // El orden importa: los hijos antes que la conversación. `mensaje` y `turno` están
        // particionadas y no tienen FK hacia ella, así que no hay cascada que los arrastre.
        await sequelize.query(
            `DELETE FROM intelligence.paso WHERE id_turno IN
                (SELECT id_turno FROM intelligence.turno WHERE id_conversacion IN (:ids));`,
            { replacements: { ids }, logging: false }
        );
        await sequelize.query(`DELETE FROM intelligence.mensaje WHERE id_conversacion IN (:ids);`, {
            replacements: { ids },
            logging: false,
        });
        await sequelize.query(`DELETE FROM intelligence.turno WHERE id_conversacion IN (:ids);`, {
            replacements: { ids },
            logging: false,
        });
    }
    await sequelize.query(`DELETE FROM intelligence.conversacion WHERE canal = :canal;`, {
        replacements: { canal: CANAL },
        logging: false,
    });
    await sequelize.query(`DELETE FROM general.gener_notificacion WHERE id_negocio = :idNegocio;`, {
        replacements: { idNegocio },
        logging: false,
    });
    await sequelize.query(`DELETE FROM general.gener_negocio WHERE id_negocio = :idNegocio;`, {
        replacements: { idNegocio },
        logging: false,
    });
    await sequelize.close();
});

// ── El productor ────────────────────────────────────────────────────────────────────────

describe('el motor emite conversacion.escalada.v1', () => {
    test('escalar deja el evento en el outbox, delgado y con su negocio', async () => {
        const quien = nuevoInterlocutor();
        const conversacion = await escalarPorUnTurno(quien);

        expect(conversacion.estado).toBe('handoff_humano');

        const eventos = await eventosDe(conversacion.id_conversacion);
        expect(eventos).toHaveLength(1);
        expect(eventos[0].id_negocio).toBe(idNegocio);
        // Delgado (ADR-013, regla 2): identificadores y el hecho, nada del cliente ni del texto.
        expect(Object.keys(eventos[0].payload).sort()).toEqual(['canal', 'id_conversacion']);
        expect(eventos[0].payload.canal).toBe(CANAL);
    }, 20000);

    test('un turno que revienta NO avisa: el evento se deshace con el savepoint', async () => {
        // Es el punto entero de emitir dentro de la transacción del turno. Si el evento se
        // escribiera fuera, el negocio recibiría un aviso de un escalado que nunca ocurrió.
        motor.registrarManejador(manejadorQueRevienta);

        const quien = nuevoInterlocutor();
        await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto: 'hola', despertar: false });
        const antes = await conversacionDe(quien);
        await motor.procesarConversacion(antes.id_conversacion);

        const despues = await conversacionDe(quien);
        expect(despues.estado).toBe('activa');
        expect(await eventosDe(antes.id_conversacion)).toHaveLength(0);
    }, 20000);

    test('una conversación YA escalada no vuelve a emitir el evento', async () => {
        // «Escalada» es un hecho que pasa una vez. Un mensaje más del cliente sobre una
        // conversación que ya está en manos de una persona no es una noticia nueva.
        const quien = nuevoInterlocutor();
        const conversacion = await escalarPorUnTurno(quien);
        expect(await eventosDe(conversacion.id_conversacion)).toHaveLength(1);

        await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto: 'sigo aquí', despertar: false });
        const resultado = await motor.procesarConversacion(conversacion.id_conversacion);

        expect(resultado.omitido).toBe(motor.OMITIDO.ESTADO_NO_PROCESABLE);
        expect(await eventosDe(conversacion.id_conversacion)).toHaveLength(1);
    }, 20000);
});

// ── El consumidor ───────────────────────────────────────────────────────────────────────

describe('el consumidor avisa al negocio', () => {
    test('deja la notificación de la campanita y manda el correo', async () => {
        const conversacion = await escalarPorUnTurno(nuevoInterlocutor());

        const resultado = await escalado.alEscalarse(sobreDe(conversacion));
        expect(resultado.avisado).toBe(true);
        expect(resultado.esperando).toBeGreaterThanOrEqual(1);

        const avisos = await avisosDelNegocio();
        expect(avisos).toHaveLength(1);
        // Ni el texto del cliente ni su número: eso se lee en la Bandeja (ADR-024).
        expect(avisos[0].mensaje).toMatch(/Conversaciones/);

        expect(mailService.sendConversacionEscaladaEmail).toHaveBeenCalled();
        const [destino] = mailService.sendConversacionEscaladaEmail.mock.calls[0];
        expect(destino).toBe(CORREO_FIXTURE);
    }, 20000);

    test('no avisa si el negocio ya la atendió mientras el evento viajaba', async () => {
        const conversacion = await escalarPorUnTurno(nuevoInterlocutor());
        await sequelize.query(
            `UPDATE intelligence.conversacion SET atendida_en = now() WHERE id_conversacion = :id;`,
            { replacements: { id: conversacion.id_conversacion }, logging: false }
        );

        const resultado = await escalado.alEscalarse(sobreDe(conversacion));
        expect(resultado.avisado).toBe(false);
        expect(resultado.motivo).toMatch(/atendieron/);
        expect(await avisosDelNegocio()).toHaveLength(0);
        expect(mailService.sendConversacionEscaladaEmail).not.toHaveBeenCalled();
    }, 20000);

    test('no avisa si la conversación volvió al asistente', async () => {
        // ADR-023 Enmienda 1: el negocio puede devolverla. Un aviso después de eso mandaría a
        // mirar una conversación que ya no le toca a nadie.
        const conversacion = await escalarPorUnTurno(nuevoInterlocutor());
        await sequelize.query(
            `UPDATE intelligence.conversacion SET estado = 'activa' WHERE id_conversacion = :id;`,
            { replacements: { id: conversacion.id_conversacion }, logging: false }
        );

        const resultado = await escalado.alEscalarse(sobreDe(conversacion));
        expect(resultado.avisado).toBe(false);
        expect(await avisosDelNegocio()).toHaveLength(0);
    }, 20000);

    test('una reentrega del mismo evento NO produce un segundo aviso', async () => {
        // El outbox entrega al menos una vez (ADR-012). Sin esto, cada reintento sería otro
        // correo por el mismo escalado.
        const conversacion = await escalarPorUnTurno(nuevoInterlocutor());

        expect((await escalado.alEscalarse(sobreDe(conversacion))).avisado).toBe(true);
        const segundo = await escalado.alEscalarse(sobreDe(conversacion));

        expect(segundo.avisado).toBe(false);
        expect(segundo.motivo).toMatch(/ventana/);
        expect(await avisosDelNegocio()).toHaveLength(1);
        expect(mailService.sendConversacionEscaladaEmail).toHaveBeenCalledTimes(1);
    }, 20000);

    test('una ráfaga de escalados es UN aviso, y cuenta cuántas esperan', async () => {
        const antes = await escalado.contarEsperando(idNegocio);

        const primera = await escalarPorUnTurno(nuevoInterlocutor());
        const segunda = await escalarPorUnTurno(nuevoInterlocutor());

        expect(await escalado.contarEsperando(idNegocio)).toBe(antes + 2);

        await escalado.alEscalarse(sobreDe(primera));
        await escalado.alEscalarse(sobreDe(segunda));

        expect(await avisosDelNegocio()).toHaveLength(1);
        expect(mailService.sendConversacionEscaladaEmail).toHaveBeenCalledTimes(1);
    }, 30000);

    test('un correo que falla no tumba el aviso ni el relay', async () => {
        // La campanita ya está puesta. Hacer fallar el evento reintentaría la parte que salió
        // bien y acabaría mandando a dead letter un escalado real.
        mailService.sendConversacionEscaladaEmail.mockRejectedValue(new Error('SMTP caído'));
        const conversacion = await escalarPorUnTurno(nuevoInterlocutor());

        const resultado = await escalado.alEscalarse(sobreDe(conversacion));

        expect(resultado.avisado).toBe(true);
        expect(resultado.correos).toBe(0);
        expect(await avisosDelNegocio()).toHaveLength(1);
        mailService.sendConversacionEscaladaEmail.mockResolvedValue(undefined);
    }, 20000);

    test('un evento sin id_conversacion se descarta sin lanzar', async () => {
        const resultado = await escalado.alEscalarse({ tipo: escalado.EVENTO, id_negocio: idNegocio, payload: {} });
        expect(resultado.avisado).toBe(false);
        expect(await avisosDelNegocio()).toHaveLength(0);
    });
});

// ── El camino entero ────────────────────────────────────────────────────────────────────

describe('de punta a punta: el turno escala y el negocio se entera', () => {
    test('el relay lleva el evento del motor al consumidor sin que nadie lo empuje', async () => {
        // Es la pieza que ninguna de las dos mitades anteriores prueba: que el consumidor esté
        // enganchado al tipo correcto. Este repositorio ya pagó dos veces la misma trampa —F5-D
        // con el manejador de eco, F8-B con los recordatorios—: las mitades verdes y el cable
        // suelto. Aquí nadie emite a mano; el evento lo escribe el turno.
        relay.limpiarConsumidores();
        escalado.registrar({ relay });

        const conversacion = await escalarPorUnTurno(nuevoInterlocutor());
        expect(await eventosDe(conversacion.id_conversacion)).toHaveLength(1);

        await relay.drenarUnaVez();

        expect(await avisosDelNegocio()).toHaveLength(1);
        expect(mailService.sendConversacionEscaladaEmail).toHaveBeenCalledTimes(1);

        const entregado = await unaFila(
            `SELECT estado FROM platform.outbox WHERE payload->>'id_conversacion' = :id
              AND tipo = 'conversacion.escalada.v1';`,
            { id: conversacion.id_conversacion }
        );
        expect(entregado.estado).toBe('entregado');
    }, 30000);
});

// ── El texto ────────────────────────────────────────────────────────────────────────────

describe('cómo se dice', () => {
    test('una es un cliente; varias, un número', () => {
        expect(escalado.comoSeDice(1)).toMatch(/Un cliente/);
        expect(escalado.comoSeDice(3)).toMatch(/^3 conversaciones/);
    });
});
