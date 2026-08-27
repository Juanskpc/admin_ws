/**
 * Una tarea a medias no se retoma al día siguiente.
 *
 * ## De dónde sale esto
 *
 * De producción, el 2026-08-27. Alguien mandó un carrito del menú digital a las 21:11 y lo dejó
 * a medias; al día siguiente a las 16:56 escribió otra vez y el turno entró derecho por
 * `tarea_en_curso` —**19 h 45 min de hueco**— y le contestaron el paso siguiente del pedido de
 * la noche anterior. Otra conversación repitió la forma con 23 h 18 min. Y una tercera llevaba
 * `agendar_cita` abierta desde hacía **tres días**.
 *
 * La asimetría que lo hacía difícil de ver: la **confirmación** sí caducaba (diez minutos,
 * `confirmacion.js`, «caducar nunca ejecuta») y la **tarea que la contiene** no caducaba nunca.
 * Nadie ponía tampoco una conversación en `dormida`: el estado existe en el CHECK y ningún
 * código lo escribe.
 *
 * ## Qué se comprueba aquí
 *
 * Que el hilo viejo no secuestre el turno, que se diga en voz alta —callarlo es la versión
 * silenciosa del mismo fallo— y, sobre todo, **que la confirmación siga mandando sobre su propia
 * tarea**: dos relojes sobre lo mismo acaban ganando el más tonto.
 *
 * Correr con:  npx jest __tests__/intelligence/tarea_caducada.test.js
 */
// El bloque de extremo a extremo de abajo toca Postgres; el resto no necesita nada.
require('dotenv').config();
const {
    crearManejadorEscalera,
    tareaCaducada,
    TAREA_VIDA_MS,
} = require('../../intelligence/engine/manejadorEscalera');
const confirmacion = require('../../intelligence/engine/confirmacion');

const HORA = 60 * 60 * 1000;

function conversacion({ tarea = null, datos = {} } = {}) {
    return {
        id_conversacion: 'conv-1',
        id_negocio: 7,
        canal: 'whatsapp',
        id_externo: '573000000000',
        variables: {},
        tarea_actual: tarea,
        tarea_datos: datos,
    };
}

function entrada(texto, conv) {
    return {
        conversacion: conv,
        mensajes: [{ contenido: texto }],
        texto,
        turno: { id_turno: 't1' },
    };
}

const haceHoras = (h) => new Date(Date.now() - h * HORA).toISOString();

/** Un manejador de mentira que dice a qué paso del flujo entró. */
const flujoQueDice = (quien) => async (ctx) => ({
    respuestas: [`${quien}:${ctx.conversacion.tarea_actual || 'sin-tarea'}`],
    resultado: 'resuelto',
});

const escalera = () =>
    crearManejadorEscalera({
        determinista: flujoQueDice('fsm'),
        // Sin base de datos: el flujo por vertical no es lo que se prueba aquí.
        resolverNegocio: async () => null,
    });

const pasosPorDecision = (d) => (d.pasos || []).map((p) => p.decision);

// ── La regla, en seco ───────────────────────────────────────────────────────────────────────

describe('tareaCaducada', () => {
    test('una tarea recién tocada no ha caducado', () => {
        expect(tareaCaducada(conversacion({ tarea: 'pedido', datos: { _actualizada_en: haceHoras(0.5) } }))).toBe(false);
    });

    test('una tarea de anoche sí', () => {
        expect(tareaCaducada(conversacion({ tarea: 'pedido', datos: { _actualizada_en: haceHoras(19.75) } }))).toBe(true);
    });

    test('sin sello se considera caducada: fallar hacia empezar de cero', () => {
        // Es el caso de las tareas que ya estaban abiertas antes de que el sello existiera.
        expect(tareaCaducada(conversacion({ tarea: 'agendar_cita', datos: {} }))).toBe(true);
    });

    test('un sello ilegible también', () => {
        expect(tareaCaducada(conversacion({ tarea: 'pedido', datos: { _actualizada_en: 'ayer' } }))).toBe(true);
    });

    test('sin tarea no hay nada que caducar', () => {
        expect(tareaCaducada(conversacion())).toBe(false);
    });

    test('la confirmación tiene su propio reloj y este no la toca', () => {
        // Diez minutos y un mensaje mejor: el suyo dice que NO se ejecutó nada.
        const vieja = conversacion({ tarea: confirmacion.TAREA, datos: { preguntado_en: haceHoras(48) } });
        expect(tareaCaducada(vieja)).toBe(false);
    });

    test('el borde: justo por debajo de la vida no caduca, justo por encima sí', () => {
        const casi = new Date(Date.now() - TAREA_VIDA_MS + 60_000).toISOString();
        const pasado = new Date(Date.now() - TAREA_VIDA_MS - 60_000).toISOString();
        expect(tareaCaducada(conversacion({ tarea: 'pedido', datos: { _actualizada_en: casi } }))).toBe(false);
        expect(tareaCaducada(conversacion({ tarea: 'pedido', datos: { _actualizada_en: pasado } }))).toBe(true);
    });
});

// ── Lo que ve el cliente ────────────────────────────────────────────────────────────────────

describe('la escalera con una tarea rancia', () => {
    test('no la retoma, avisa, y deja la tarea cerrada', async () => {
        const conv = conversacion({
            tarea: 'pedido',
            datos: { paso: 'direccion', _actualizada_en: haceHoras(19.75) },
        });

        const d = await escalera()(entrada('hola', conv));

        // El aviso va primero y en el MISMO turno: no se le hace repetir al cliente.
        expect(d.respuestas[0]).toBe('Pasó un buen rato desde la última vez, así que empiezo de cero.');
        expect(d.respuestas).toHaveLength(2);

        // Y el flujo se atendió sin la tarea vieja encima.
        expect(d.respuestas[1]).toBe('fsm:sin-tarea');

        // El motor guarda el estado leyendo este mismo objeto: vaciarlo es lo que cierra la
        // tarea en la base.
        expect(conv.tarea_actual).toBeNull();
        expect(conv.tarea_datos).toEqual({});

        // ADR-022: si no queda rastro, no ocurrió.
        expect(pasosPorDecision(d)).toContain('tarea_caducada');
        const paso = d.pasos.find((p) => p.decision === 'tarea_caducada');
        expect(paso.motivo).toMatchObject({ tarea: 'pedido', vida_ms: TAREA_VIDA_MS });
    });

    test('una tarea fresca se retoma como siempre, y sin aviso', async () => {
        const conv = conversacion({
            tarea: 'pedido',
            datos: { paso: 'direccion', _actualizada_en: haceHoras(0.2) },
        });

        // Con Nivel 4 disponible, para que la tabla se recorra igual que en producción:
        // sin él, gana `nivel4_no_disponible` (fila 2) antes que `tarea_en_curso` (fila 3).
        const manejar = crearManejadorEscalera({
            determinista: flujoQueDice('fsm'),
            llm: async () => ({ respuestas: ['el modelo NO debería entrar aqui'] }),
            resolverNegocio: async () => null,
        });
        const d = await manejar(entrada('calle 5 #3-20', conv));

        expect(d.respuestas).toEqual(['fsm:pedido']);
        expect(conv.tarea_actual).toBe('pedido');
        expect(pasosPorDecision(d)).toContain('tarea_en_curso');
        expect(pasosPorDecision(d)).not.toContain('tarea_caducada');
    });

    test('sin tarea abierta no cambia nada', async () => {
        const conv = conversacion();
        const d = await escalera()(entrada('hola', conv));

        expect(d.respuestas).toEqual(['fsm:sin-tarea']);
        expect(pasosPorDecision(d)).not.toContain('tarea_caducada');
    });

    test('la baja manda por encima de todo, también de esto', async () => {
        // `optout` va antes de enrutar por obligación legal: una tarea rancia no puede
        // interponerse en un STOP.
        const conv = conversacion({ tarea: 'pedido', datos: { _actualizada_en: haceHoras(30) } });
        const d = await escalera()(entrada('STOP', conv));

        expect(pasosPorDecision(d)).not.toContain('tarea_caducada');
        expect(conv.tarea_actual).toBe('pedido');
    });

    test('el aviso también se antepone cuando el turno lo resuelve el modelo', async () => {
        const manejar = crearManejadorEscalera({
            determinista: flujoQueDice('fsm'),
            llm: async () => ({ respuestas: ['lo que dijo el modelo'], resultado: 'resuelto' }),
            resolverNegocio: async () => null,
        });

        const conv = conversacion({ tarea: 'pedido', datos: { _actualizada_en: haceHoras(30) } });
        // Sin tarea y sin comando, cae por el comodín `pregunta_libre` al Nivel 4.
        const d = await manejar(entrada('¿ustedes abren los domingos?', conv));

        expect(d.respuestas).toEqual([
            'Pasó un buen rato desde la última vez, así que empiezo de cero.',
            'lo que dijo el modelo',
        ]);
        expect(pasosPorDecision(d)).toContain('tarea_caducada');
    });

    test('si el Nivel 4 se cae, el aviso sigue saliendo con la respuesta de respaldo', async () => {
        const manejar = crearManejadorEscalera({
            determinista: flujoQueDice('fsm'),
            llm: async () => {
                throw new Error('proveedor caído');
            },
            resolverNegocio: async () => null,
        });

        const conv = conversacion({ tarea: 'pedido', datos: { _actualizada_en: haceHoras(30) } });
        const d = await manejar(entrada('¿ustedes abren los domingos?', conv));

        expect(d.respuestas[0]).toBe('Pasó un buen rato desde la última vez, así que empiezo de cero.');
        expect(pasosPorDecision(d)).toEqual(
            expect.arrayContaining(['tarea_caducada', 'pregunta_libre'])
        );
    });
});

// ── Y que de verdad quede cerrada EN LA BASE ────────────────────────────────────────────────

/**
 * Los de arriba comprueban que se vacía el objeto en memoria. Éste comprueba lo único que le
 * importa al cliente de mañana: que **la fila** quede sin tarea. Es donde vivía el fallo — el
 * estado sobrevivía al proceso, que es justo la virtud que ADR-014 le pedía a la tarea.
 */
describe('de extremo a extremo, contra Postgres', () => {
    const Models = require('../../app_core/models/conection');
    const motor = require('../../intelligence/engine/motor');
    const sequelize = Models.sequelize;
    const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };
    const CANAL = 'test_caducidad';

    const consulta = (sql, r = {}) => sequelize.query(sql, { replacements: r, ...SELECT });
    const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;

    let idNegocio;

    beforeAll(async () => {
        const negocio = await unaFila(
            `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A'
              ORDER BY id_negocio LIMIT 1;`
        );
        if (!negocio) throw new Error('No hay negocio activo. Corre scripts/seed_dev_local.js.');
        idNegocio = negocio.id_negocio;
    });

    afterEach(() => {
        motor._reiniciar();
        motor.detener();
    });

    afterAll(async () => {
        const ids = (
            await consulta(
                `SELECT id_conversacion FROM intelligence.conversacion WHERE canal = :canal;`,
                { canal: CANAL }
            )
        ).map((f) => f.id_conversacion);

        if (ids.length > 0) {
            await sequelize.query(
                `DELETE FROM intelligence.paso WHERE id_turno IN
                    (SELECT id_turno FROM intelligence.turno WHERE id_conversacion IN (:ids));`,
                { replacements: { ids }, logging: false }
            );
            for (const tabla of ['mensaje', 'turno']) {
                await sequelize.query(
                    `DELETE FROM intelligence.${tabla} WHERE id_conversacion IN (:ids);`,
                    { replacements: { ids }, logging: false }
                );
            }
        }
        await sequelize.query(`DELETE FROM intelligence.ingesta_recibida WHERE canal = :canal;`, {
            replacements: { canal: CANAL },
            logging: false,
        });
        await sequelize.query(`DELETE FROM intelligence.conversacion WHERE canal = :canal;`, {
            replacements: { canal: CANAL },
            logging: false,
        });
        await sequelize.close();
    });

    async function conversacionConTareaDe(horas) {
        const idExterno = `caduca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await motor.recibir({ idNegocio, canal: CANAL, idExterno, texto: 'hola', despertar: false });

        const conv = await unaFila(
            `SELECT id_conversacion FROM intelligence.conversacion
              WHERE id_negocio = :idNegocio AND canal = :canal AND id_externo = :idExterno;`,
            { idNegocio, canal: CANAL, idExterno }
        );

        // Se planta una tarea con la edad que se quiera, como la habría dejado un turno anterior.
        await sequelize.query(
            `UPDATE intelligence.conversacion
                SET tarea_actual = 'pedido', tarea_datos = :datos
              WHERE id_conversacion = :id;`,
            {
                replacements: {
                    id: conv.id_conversacion,
                    datos: JSON.stringify({
                        paso: 'direccion',
                        _actualizada_en: new Date(Date.now() - horas * 3600_000).toISOString(),
                    }),
                },
                logging: false,
            }
        );
        return conv.id_conversacion;
    }

    const tareaDe = (id) =>
        unaFila(
            `SELECT tarea_actual, tarea_datos FROM intelligence.conversacion
              WHERE id_conversacion = :id;`,
            { id }
        );

    test('una tarea de anoche queda cerrada en la fila, y el cliente recibe el aviso', async () => {
        motor.registrarManejador(
            crearManejadorEscalera({
                determinista: flujoQueDice('fsm'),
                resolverNegocio: async () => null,
            })
        );

        const idConversacion = await conversacionConTareaDe(19.75);
        const resultado = await motor.procesarConversacion(idConversacion);

        expect(resultado.respuestas[0].texto).toBe(
            'Pasó un buen rato desde la última vez, así que empiezo de cero.'
        );

        // Lo que importa: la fila.
        const despues = await tareaDe(idConversacion);
        expect(despues.tarea_actual).toBeNull();
        expect(despues.tarea_datos).toEqual({});

        const pasos = await consulta(
            `SELECT decision FROM intelligence.paso WHERE id_turno = :id;`,
            { id: resultado.id_turno }
        );
        expect(pasos.map((p) => p.decision)).toContain('tarea_caducada');
    });

    test('una tarea reciente sigue ahí después del turno, y con el sello renovado', async () => {
        motor.registrarManejador(
            crearManejadorEscalera({
                determinista: async () => ({
                    respuestas: ['sigo contigo'],
                    resultado: 'resuelto',
                    tarea: { nombre: 'pedido', datos: { paso: 'pago' } },
                }),
                resolverNegocio: async () => null,
            })
        );

        const idConversacion = await conversacionConTareaDe(0.1);
        await motor.procesarConversacion(idConversacion);

        const despues = await tareaDe(idConversacion);
        expect(despues.tarea_actual).toBe('pedido');
        expect(despues.tarea_datos.paso).toBe('pago');
        // El sello lo pone el motor en cada guardado: por eso la vida se cuenta desde el
        // último turno que tocó la tarea y no desde que se abrió.
        const edadMs = Date.now() - Date.parse(despues.tarea_datos._actualizada_en);
        expect(edadMs).toBeLessThan(60_000);
    });
});
