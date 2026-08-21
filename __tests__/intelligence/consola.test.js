/**
 * Intelligence Console (F5-E) — la Observabilidad vista desde el panel.
 *
 * ⚠️ **Prohibido construirla con datos simulados** (ADR-022, `revision-01.md` §2). Por eso esta
 * suite no inserta filas a mano en `intelligence.*`: **conversa de verdad** con el bot por el
 * WebChat, con la FSM de F5-D y el Policy Gate reales, y después comprueba que la consola
 * enseña exactamente eso. Si algún día la consola dejara de reflejar lo que pasó, este test
 * falla; con filas inventadas seguiría pasando y no probaría nada.
 *
 * Los controladores se invocan con `req`/`res` de mentira porque el proyecto no tiene
 * supertest: lo que se prueba es la consulta y la forma de la respuesta, no Express.
 *
 * Correr con:  npx jest __tests__/intelligence/ --runInBand
 * ⚠️ Contra la base LOCAL (DB_PORT=5432).
 */
process.env.FEATURES_FORZADAS = process.env.FEATURES_FORZADAS || 'asistente_ia';

require('dotenv').config();
const Models = require('../../app_core/models/conection');
const motor = require('../../intelligence/engine/motor');
const gateway = require('../../intelligence/channels/gateway');
const adaptador = require('../../intelligence/channels/webchat/adaptador');
const { CONFIG: COLA_CONFIG } = require('../../intelligence/engine/cola');
const { manejarDeterminista } = require('../../intelligence/engine/manejadorDeterminista');
const intelligence = require('../../intelligence');
const Consola = require('../../app_admin_api/controllers/intelligenceConsolaController');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };
const CANAL = adaptador.NOMBRE;

let idNegocio;
let idSesion;
let idConversacion;
let contador = 0;
/**
 * Cuándo empezó esta suite. Acota la ventana de las métricas a **sus** turnos.
 *
 * Hizo falta en F7: desde que el asistente puede mutar, una base de desarrollo tiene turnos de
 * Nivel 4 legítimos —los deja cualquiera que pruebe el asistente a mano, o el arnés— y las
 * afirmaciones «ratio determinista = 1, costo = 0» son de **esta** conversación, no del negocio
 * entero. Sin la ventana, el test castigaba a quien hubiera usado el bot antes de correrlo.
 */
const arranque = new Date();

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const consulta = (sql, r = {}) => sequelize.query(sql, { replacements: r, ...SELECT });
const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;

/** Doble de `res` que captura lo que el controlador respondió. */
function resFalso() {
    const capturado = { statusCode: null, cuerpo: null };
    return {
        capturado,
        status(code) {
            capturado.statusCode = code;
            return this;
        },
        json(payload) {
            capturado.cuerpo = payload;
            return this;
        },
    };
}

async function llamar(controlador, { query = {}, params = {} } = {}) {
    const res = resFalso();
    await controlador({ query, params }, res);
    return res.capturado;
}

beforeAll(async () => {
    const negocio = await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 1;`
    );
    if (!negocio) throw new Error('No hay negocio activo. Corre scripts/seed_dev_local.js.');
    idNegocio = negocio.id_negocio;

    intelligence.arrancar();
    COLA_CONFIG.debounceMs = 150;
    COLA_CONFIG.debounceMaxMs = 900;

    motor._reiniciar();
    motor.registrarManejador(manejarDeterminista);
    gateway.limpiar();
    gateway.registrar(adaptador);
    adaptador.limpiarBuzones();

    // ── Se conversa de verdad: dos turnos, con invocación real de capacidades ──────────
    idSesion = `test_consola_${Date.now()}_${contador++}`;
    for (const texto of ['hola', '1']) {
        await adaptador.recibirDelWidget({
            idNegocio,
            idSesion,
            texto,
            idMensajeCliente: `cli_${idSesion}_${contador++}`,
            enviadoEn: new Date(),
        });
        // Se espera a que el turno cierre antes del siguiente: la consola debe ver dos
        // turnos distintos, no una ráfaga agrupada en uno.
        for (let i = 0; i < 60; i++) {
            const conv = await unaFila(
                `SELECT id_conversacion FROM intelligence.conversacion
                  WHERE canal = :canal AND id_externo = :s;`,
                { canal: CANAL, s: idSesion }
            );
            if (conv) {
                idConversacion = conv.id_conversacion;
                const [t] = await consulta(
                    `SELECT COUNT(*)::int n FROM intelligence.turno
                      WHERE id_conversacion = :id AND estado = 'terminado';`,
                    { id: idConversacion }
                );
                if (t.n >= (texto === 'hola' ? 1 : 2)) break;
            }
            await dormir(80);
        }
    }

    if (!idConversacion) throw new Error('No se creó la conversación de prueba.');
}, 60000);

afterAll(async () => {
    motor.detener();
    gateway.detener();

    if (idConversacion) {
        await sequelize.query(
            `DELETE FROM intelligence.paso WHERE id_turno IN
                (SELECT id_turno FROM intelligence.turno WHERE id_conversacion = :id);`,
            { replacements: { id: idConversacion }, logging: false }
        );
        for (const tabla of ['invocacion_capacidad', 'mensaje', 'turno']) {
            await sequelize.query(`DELETE FROM intelligence.${tabla} WHERE id_conversacion = :id;`, {
                replacements: { id: idConversacion },
                logging: false,
            });
        }
        await sequelize.query(`DELETE FROM intelligence.conversacion WHERE id_conversacion = :id;`, {
            replacements: { id: idConversacion },
            logging: false,
        });
    }
    await sequelize.query(
        `DELETE FROM intelligence.ingesta_recibida WHERE canal = :canal AND id_externo LIKE 'cli_test_consola_%';`,
        { replacements: { canal: CANAL }, logging: false }
    );
    await sequelize.close();
}, 30000);

// ── El listado ──────────────────────────────────────────────────────────────────────────

describe('GET /admin/intelligence/conversaciones', () => {
    test('la conversación real aparece, con sus turnos contados', async () => {
        const { statusCode, cuerpo } = await llamar(Consola.listarConversaciones, {
            query: { id_negocio: String(idNegocio) },
        });

        expect(statusCode).toBe(200);
        const mia = cuerpo.data.conversaciones.find((c) => c.id_conversacion === idConversacion);
        expect(mia).toBeDefined();
        expect(mia.canal).toBe(CANAL);
        expect(Number(mia.turnos)).toBeGreaterThanOrEqual(2);
        expect(Number(mia.mensajes)).toBeGreaterThanOrEqual(4); // 2 entrantes + 2 salientes
        expect(mia.negocio).toBeTruthy(); // el JOIN con gener_negocio resuelve el nombre
    });

    test('en F5 el costo es 0, y se muestra: no es un hueco, es el resultado', async () => {
        const { cuerpo } = await llamar(Consola.listarConversaciones, {
            query: { id_negocio: String(idNegocio) },
        });
        const mia = cuerpo.data.conversaciones.find((c) => c.id_conversacion === idConversacion);

        expect(Number(mia.costo_usd)).toBe(0);
        expect(mia.nivel).toBe('determinista');
    });

    test('el filtro con_error deja fuera una conversación sana', async () => {
        // Es el filtro que más se usa depurando: lleva directo a lo que falló.
        const { cuerpo } = await llamar(Consola.listarConversaciones, {
            query: { id_negocio: String(idNegocio), con_error: 'true' },
        });

        expect(cuerpo.data.conversaciones.some((c) => c.id_conversacion === idConversacion)).toBe(false);
    });

    test('respeta la paginación y devuelve el total', async () => {
        const { cuerpo } = await llamar(Consola.listarConversaciones, { query: { limit: '1' } });

        expect(cuerpo.data.conversaciones.length).toBeLessThanOrEqual(1);
        expect(typeof cuerpo.data.total).toBe('number');
        expect(cuerpo.data.limit).toBe(1);
    });

    test('un filtro de negocio ajeno no devuelve nada de este negocio', async () => {
        const { cuerpo } = await llamar(Consola.listarConversaciones, {
            query: { id_negocio: '999999' },
        });
        expect(cuerpo.data.conversaciones).toHaveLength(0);
    });
});

// ── El detalle, que es la pantalla que sustituye a leer logs ─────────────────────────────

describe('GET /admin/intelligence/conversaciones/:id', () => {
    test('trae el rastro completo: mensajes, turnos, pasos e invocaciones reales', async () => {
        const { statusCode, cuerpo } = await llamar(Consola.detalleConversacion, {
            params: { id: idConversacion },
        });

        expect(statusCode).toBe(200);
        const { conversacion, mensajes, turnos } = cuerpo.data;

        expect(conversacion.id_conversacion).toBe(idConversacion);
        expect(mensajes.length).toBeGreaterThanOrEqual(4);
        expect(mensajes.some((m) => m.direccion === 'entrante')).toBe(true);
        expect(mensajes.some((m) => m.direccion === 'saliente')).toBe(true);

        // El «por qué»: los pasos que registró la FSM.
        const conPasos = turnos.find((t) => (t.pasos || []).length > 0);
        expect(conPasos).toBeDefined();
        expect(conPasos.pasos[0]).toHaveProperty('decision');

        // El «qué hizo»: la invocación real de una capacidad, con sus argumentos.
        const conInvocacion = turnos.find((t) => (t.invocaciones || []).length > 0);
        expect(conInvocacion).toBeDefined();
        expect(conInvocacion.invocaciones[0].capacidad).toBe('consultar_servicios');
        expect(conInvocacion.invocaciones[0].vertical).toBe('reserva');
    });

    test('los menús viajan en opciones, no incrustados en el texto', async () => {
        // Lo mismo que vigila ADR-017 en el canal, comprobado desde el panel: si un día
        // alguien numerara el menú dentro del contenido, aquí se vería.
        const { cuerpo } = await llamar(Consola.detalleConversacion, {
            params: { id: idConversacion },
        });
        const conOpciones = cuerpo.data.mensajes.find((m) => m.direccion === 'saliente' && m.opciones);

        expect(conOpciones).toBeDefined();
        expect(conOpciones.contenido).not.toMatch(/^\s*\d\s*[).-]/m);
    });

    test('una conversación inexistente da 404, no un 500', async () => {
        const { statusCode, cuerpo } = await llamar(Consola.detalleConversacion, {
            params: { id: '00000000-0000-4000-8000-000000000000' },
        });

        expect(statusCode).toBe(404);
        expect(cuerpo.success).toBe(false);
    });
});

// ── Las doce preguntas de ADR-022, hasta donde F5 llega ─────────────────────────────────

describe('GET /admin/intelligence/metricas', () => {
    test('el ratio determinista es 1 y el costo total es 0 — criterios de F5', async () => {
        // No son columnas vacías esperando a llenarse: son el resultado que F5 promete. La ventana
        // acota a los turnos de esta suite: ver el comentario de `arranque`.
        const { statusCode, cuerpo } = await llamar(Consola.metricas, {
            query: { id_negocio: String(idNegocio), desde: arranque.toISOString() },
        });

        expect(statusCode).toBe(200);
        expect(cuerpo.data.ratio_determinista).toBe(1);
        expect(cuerpo.data.costo_total_usd).toBe(0);
        expect(cuerpo.data.turnos.con_llm).toBe(0);
    });

    test('cuenta turnos, resueltos, errores, reintentos y latencias', async () => {
        const { cuerpo } = await llamar(Consola.metricas, { query: { id_negocio: String(idNegocio) } });
        const t = cuerpo.data.turnos;

        expect(t.turnos).toBeGreaterThanOrEqual(2);
        expect(t.resueltos).toBeGreaterThanOrEqual(2);
        expect(t.reintentos).toBeGreaterThanOrEqual(0);
        expect(t.latencia_media_ms).toBeGreaterThan(0);
        expect(cuerpo.data.tasa_resolucion).toBeGreaterThan(0);
    });

    test('lista las capacidades ejecutadas de verdad', async () => {
        const { cuerpo } = await llamar(Consola.metricas, { query: { id_negocio: String(idNegocio) } });
        const servicios = cuerpo.data.capacidades.find((c) => c.capacidad === 'consultar_servicios');

        expect(servicios).toBeDefined();
        expect(servicios.invocaciones).toBeGreaterThanOrEqual(1);
        expect(servicios.vertical).toBe('reserva');
    });

    test('sin turnos en la ventana, los ratios son null en vez de NaN', async () => {
        // Dividir por cero en un panel produce "NaN%" y hace dudar de todo lo demás.
        const { cuerpo } = await llamar(Consola.metricas, { query: { id_negocio: '999999' } });

        expect(cuerpo.data.turnos.turnos).toBe(0);
        expect(cuerpo.data.tasa_resolucion).toBeNull();
        expect(cuerpo.data.ratio_determinista).toBeNull();
    });
});

// ── La única escritura de la Consola (F8-B) ─────────────────────────────────────────────

describe('deshacer una baja', () => {
    /**
     * Un `STOP` es irrevocable **por el cliente** a propósito: escribir de nuevo no reactiva la
     * conversación (`optout.js`). Eso deja un caso real que solo un humano puede resolver — la
     * baja puesta por error—, y hasta F8-B se resolvía con un `UPDATE` a mano en producción.
     */
    test('una conversación bloqueada vuelve a activa, y queda auditado quién y por qué', async () => {
        await sequelize.query(
            `UPDATE intelligence.conversacion SET estado = 'bloqueada' WHERE id_conversacion = :id;`,
            { replacements: { id: idConversacion }, logging: false }
        );

        const res = resFalso();
        await Consola.desbloquearConversacion(
            {
                params: { id: idConversacion },
                body: { motivo: 'el cliente llamó: puso STOP sin querer' },
                usuario: { id_usuario: 1 },
                ip: '127.0.0.1',
            },
            res
        );

        expect(res.capturado.cuerpo.success).toBe(true);
        expect(res.capturado.cuerpo.data.estado).toBe('activa');

        const auditoria = await unaFila(
            `SELECT accion, detalle FROM auditoria.audit_evento
              WHERE modulo = 'intelligence_consola'
                AND detalle->>'id_conversacion' = :id
              ORDER BY fecha DESC LIMIT 1;`,
            { id: idConversacion }
        );
        // Volver a escribirle a quien pidió que no le escribieran es justo lo que hay que poder
        // justificar después. Un botón sin rastro sería peor que no tenerlo.
        expect(auditoria).not.toBeNull();
        expect(auditoria.detalle.motivo).toMatch(/sin querer/);
    });

    test('sobre una que no está bloqueada responde 409, no la toca', async () => {
        const res = resFalso();
        await Consola.desbloquearConversacion(
            {
                params: { id: idConversacion },
                body: { motivo: 'probando dos veces' },
                usuario: { id_usuario: 1 },
            },
            res
        );
        expect(res.capturado.statusCode).toBe(409);
    });
});
