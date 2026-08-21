/**
 * Baja de la lista — `STOP` / `BAJA` (F8-A).
 *
 * Es una obligación legal, así que lo que hay que probar no es que funcione el camino feliz: es
 * que **no exista ninguna forma de que un mensaje salga después**. Por eso la mitad de esta suite
 * corre contra la base de verdad: la regla que impide entregar vive en una consulta SQL, y una
 * regla en SQL que solo se prueba con dobles no está probada.
 *
 * Y la trampa que más importa está en el otro sentido: **«cancelar» no puede ser una baja.** En
 * Nivel 1 esa palabra significa «sal de este flujo» y en F7 «no ejecutes la mutación que estás
 * confirmando». Si además diera de baja para siempre, salir de un menú tendría consecuencias
 * irreversibles.
 */
'use strict';

require('dotenv').config();
const Models = require('../../app_core/models/conection');
const optout = require('../../intelligence/engine/optout');
const repositorio = require('../../intelligence/engine/repositorio');
const { crearManejadorEscalera } = require('../../intelligence/engine/manejadorEscalera');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };
const consulta = (sql, replacements = {}) => sequelize.query(sql, { replacements, ...SELECT });
const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;

const CANAL = 'test_optout';
let idNegocio;
const creadas = [];

beforeAll(async () => {
    const negocio = await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 1;`
    );
    if (!negocio) throw new Error('No hay negocio activo. Corre scripts/seed_dev_local.js.');
    idNegocio = negocio.id_negocio;
});

afterAll(async () => {
    if (creadas.length > 0) {
        await sequelize.query(`DELETE FROM intelligence.mensaje WHERE id_conversacion IN (:ids);`, {
            replacements: { ids: creadas },
            logging: false,
        });
        await sequelize.query(`DELETE FROM intelligence.conversacion WHERE id_conversacion IN (:ids);`, {
            replacements: { ids: creadas },
            logging: false,
        });
    }
    await sequelize.close();
});

// ── Las palabras ────────────────────────────────────────────────────────────────────────

describe('qué cuenta como baja', () => {
    test.each(['STOP', 'stop', 'Baja', 'BAJA', 'unsubscribe', 'no más mensajes'])(
        '«%s» es una baja',
        (texto) => {
            expect(optout.pedida(texto)).toBe(true);
        }
    );

    test('«cancelar» NO es una baja, y es lo más importante de esta suite', () => {
        // Salir de un menú no puede darte de baja para siempre. En F7 esa misma palabra significa
        // además «no ejecutes la cancelación que estás confirmando».
        expect(optout.pedida('cancelar')).toBe(false);
        expect(optout.pedida('cancelar cita')).toBe(false);
    });

    test('una frase larga tampoco: eso lo entiende el Nivel 4, no una lista de palabras', () => {
        expect(optout.pedida('oye ya no quiero que me escriban más por favor')).toBe(false);
    });

    test('en una ráfaga vale la última línea, igual que un «sí»', () => {
        // El debounce agrupa, así que aquí no llega «stop» sino «hola\nstop».
        expect(optout.pedida('hola\nSTOP')).toBe(true);
        expect(optout.pedida('STOP\nno, espera, sigue')).toBe(false);
    });
});

// ── La decisión: silencio ───────────────────────────────────────────────────────────────

describe('la decisión del turno', () => {
    test('bloquea, no contesta nada y tira la tarea a medias', () => {
        const d = optout.decision({ variables: { nombre: 'Nico' }, tarea_actual: 'agendar_cita' });

        expect(d.estado).toBe('bloqueada');
        expect(d.respuestas).toEqual([]);
        expect(d.tarea).toBeNull();
        // `sin_respuesta` y no `resuelto`: desde fuera no hubo respuesta, y contarlo como resuelto
        // inflaría la pregunta 11 del Ledger con turnos que no resolvieron nada.
        expect(d.resultado).toBe('sin_respuesta');
        expect(d.pasos[0].decision).toBe('baja_solicitada');
    });

    test('se atiende ANTES de la tabla de enrutado y sin tocar el modelo', async () => {
        // No es una fila más de la política: es una obligación legal, y ninguna regla puede
        // ganarle. Si el LLM se llegara a llamar aquí, este test falla.
        let llmLlamado = false;
        const escalera = crearManejadorEscalera({
            determinista: async () => {
                throw new Error('el Nivel 1 tampoco debería decidir esto');
            },
            llm: async () => {
                llmLlamado = true;
                return {};
            },
        });

        const d = await escalera({
            conversacion: { variables: {}, tarea_actual: null },
            texto: 'STOP',
        });

        expect(llmLlamado).toBe(false);
        expect(d.estado).toBe('bloqueada');
        // Ni siquiera hay paso de ruta: no se enrutó nada.
        expect(d.pasos.map((p) => p.decision)).toEqual(['baja_solicitada']);
    });
});

// ── Y ya no sale nada: la regla vive en SQL ─────────────────────────────────────────────

describe('a una conversación bloqueada no se le entrega nada', () => {
    async function conversacionCon({ estado, contenido }) {
        const conv = await repositorio.asegurarConversacion(
            { idNegocio, canal: CANAL, idExterno: `optout_${Date.now()}_${Math.random()}` },
            { transaction: null }
        );
        creadas.push(conv.id_conversacion);

        await sequelize.query(
            `
            INSERT INTO intelligence.mensaje
                (id_conversacion, id_negocio, canal, direccion, contenido, estado_entrega)
            VALUES (:id, :negocio, :canal, 'saliente', :contenido, 'pendiente');
            `,
            {
                replacements: { id: conv.id_conversacion, negocio: idNegocio, canal: CANAL, contenido },
                logging: false,
            }
        );

        if (estado !== 'activa') {
            await repositorio.cambiarEstadoConversacion(conv.id_conversacion, estado);
        }
        return conv;
    }

    test('el saliente que quedó en la cola NO se reclama tras la baja', async () => {
        // El caso real: el cliente escribe STOP mientras el turno anterior tenía una respuesta
        // encolada. Sin este filtro, el bot manda un mensaje más justo después de la baja.
        const bloqueada = await conversacionCon({ estado: 'bloqueada', contenido: 'no debería salir' });
        const activa = await conversacionCon({ estado: 'activa', contenido: 'esta sí' });

        const t = await sequelize.transaction();
        try {
            const reclamados = await repositorio.reclamarSalientesPendientes({
                lote: 100,
                ventanaHoras: 24,
                transaction: t,
            });
            const ids = reclamados.map((m) => m.id_conversacion);

            expect(ids).toContain(activa.id_conversacion);
            expect(ids).not.toContain(bloqueada.id_conversacion);
        } finally {
            // Rollback siempre: la trampa ya pagada de §8 es dejar una transacción abierta y
            // bloquear la suite entera con «idle in transaction».
            await t.rollback();
        }
    });

    test('y el mensaje se queda pendiente en el Ledger, no se borra', async () => {
        // Conservar que se decidió y que no se entregó es mejor que borrarlo: caduca solo al salir
        // de la ventana de horas del entregador.
        const conv = await conversacionCon({ estado: 'bloqueada', contenido: 'queda como rastro' });
        const fila = await unaFila(
            `SELECT estado_entrega FROM intelligence.mensaje WHERE id_conversacion = :id;`,
            { id: conv.id_conversacion }
        );
        expect(fila.estado_entrega).toBe('pendiente');
    });

    test('escribir otra vez NO reactiva una conversación bloqueada', async () => {
        // `asegurarConversacion` reactiva las dormidas y cerradas, no las bloqueadas. Es la parte
        // «irrevocable» del opt-out: para volver hace falta un humano (Consola, F8-B).
        const conv = await conversacionCon({ estado: 'bloqueada', contenido: 'x' });
        const otraVez = await repositorio.asegurarConversacion(
            { idNegocio, canal: CANAL, idExterno: conv.id_externo },
            { transaction: null }
        );
        expect(otraVez.estado).toBe('bloqueada');
    });

    test('un estado que no está en el CHECK se rechaza antes de tocar la base', async () => {
        // Un valor fuera de la lista aborta la transacción entera en Postgres, y el error que sale
        // no menciona el CHECK: se comprueba antes para que el mensaje sirva.
        await expect(repositorio.cambiarEstadoConversacion(creadas[0], 'inventado')).rejects.toThrow(/CHECK|admite/i);
    });
});
