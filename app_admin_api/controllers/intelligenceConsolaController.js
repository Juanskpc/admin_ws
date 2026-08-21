'use strict';
const { validationResult } = require('express-validator');
const Respuesta = require('../../app_core/helpers/respuesta');
const Models = require('../../app_core/models/conection');
const Audit = require('../../app_core/helpers/auditHelper');

/**
 * Intelligence Console — F5-E, la superficie de visualización de la Observabilidad.
 *
 * ADR-022 y `revision-01.md` §2 son tajantes en dos cosas, y las dos mandan sobre este archivo:
 *
 *   1. **La Consola no es una fase, es la Observabilidad vista desde el otro lado.** No se
 *      inventa nada aquí: se muestra lo que el Ledger ya registra, ni más ni menos. Si una
 *      pregunta no se puede responder, el arreglo está en el Ledger, no en un `JOIN` creativo.
 *   2. **Prohibido construirla con datos simulados.** Nace ahora y no antes porque hasta F5-D
 *      no había conversaciones reales que mirar. Una consola bonita sobre datos falsos no mide
 *      el avance: lo simula, que es justo el fallo que se quería evitar.
 *
 * Y es, sobre todo, **la herramienta de depuración principal del desarrollador**: sin ella,
 * depurar una conversación fallida es leer logs; con ella, es mirar una pantalla.
 *
 * ## Por qué vive aquí y no en `intelligence/`
 *
 * Sigue el patrón de la Ficha 360 ([`fichaPersonaController`](./fichaPersonaController.js)):
 * lee el esquema con SQL y **no importa `intelligence/`**. Eso mantiene literal el test del
 * apagón de ADR-005 — se borra el directorio `intelligence/` y el backend arranca igual,
 * incluida esta consola, que simplemente dejará de tener conversaciones nuevas que enseñar.
 *
 * Si el esquema todavía no está migrado, responde diciéndolo en vez de reventar con un error
 * de SQL: un panel que se cae porque una fase no está desplegada es un panel que nadie abre.
 *
 * ## Qué se ve hoy y qué se verá después
 *
 * En F5 no hay IA, así que **el costo es $0.00 — y eso también se muestra**, porque es un
 * resultado, no un hueco. Las columnas de modelo, tokens y caché existen en el Ledger desde
 * F5-A y se llenarán solas en F6; esta consola ya las lee, así que crecerá sin reescribirse.
 *
 * Solo super admin, como la Ficha 360 y la Auditoría. Un panel por inquilino es otra
 * conversación (y otra decisión de producto).
 *
 * ## La única escritura, y por qué existe (F8-B)
 *
 * Nació de solo lectura y casi lo sigue siendo. La excepción es `desbloquearConversacion`, y no
 * es una grieta: un `STOP` es **irrevocable por el cliente** a propósito (ADR-023, `optout.js`),
 * así que escribir de nuevo no reactiva nada y hace falta un humano. Sin este botón, deshacer una
 * baja puesta por error es un `UPDATE` a mano en producción.
 *
 * Por eso pide **motivo** y se **audita con el usuario que la hizo**: volver a escribirle a alguien
 * que pidió que no le escribieran es exactamente lo que hay que poder justificar después. Un botón
 * sin rastro sería peor que no tenerlo.
 */

const LIMITE_POR_DEFECTO = 25;
const LIMITE_MAXIMO = 100;

/**
 * Ventana por defecto, en días.
 *
 * No es cosmética: `turno`, `paso`, `mensaje`, `costo` e `invocacion_capacidad` están
 * **particionadas por mes** (ADR-022 §7). Una consulta sin filtro de fecha las recorre todas,
 * y eso empeora cada mes que pasa. Con ventana, Postgres poda particiones.
 */
const VENTANA_DIAS = 30;

/** Cache del chequeo de esquema: no hace falta preguntarlo en cada request. */
let esquemaPresente = null;

async function hayEsquemaIntelligence() {
    if (esquemaPresente !== null) return esquemaPresente;
    const filas = await Models.sequelize.query(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'intelligence' LIMIT 1;`,
        { type: Models.sequelize.QueryTypes.SELECT }
    );
    esquemaPresente = filas.length > 0;
    return esquemaPresente;
}

function sinEsquema(res) {
    return Respuesta.error(
        res,
        'EscalApp Intelligence no está migrado en este entorno. Corre migrate:intelligence-ledger.',
        503
    );
}

function paginacion(req) {
    return {
        limit: Math.min(Number(req.query.limit) || LIMITE_POR_DEFECTO, LIMITE_MAXIMO),
        offset: Number(req.query.offset) || 0,
    };
}

function ventana(req) {
    return {
        desde: req.query.desde || null,
        hasta: req.query.hasta || null,
        dias: VENTANA_DIAS,
    };
}

/**
 * GET /admin/intelligence/conversaciones
 *
 * La tabla de entrada: una fila por conversación con lo justo para decidir cuál abrir.
 * Query: ?id_negocio= &canal= &estado= &con_error=true &desde= &hasta= &q= &limit= &offset=
 *
 * `con_error=true` es el filtro que más se usa depurando, así que existe de primera: lleva
 * directo a las conversaciones donde algún turno falló.
 */
async function listarConversaciones(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }
        if (!(await hayEsquemaIntelligence())) return sinEsquema(res);

        const { limit, offset } = paginacion(req);
        const { desde, hasta, dias } = ventana(req);
        const repl = {
            idNegocio: req.query.id_negocio ? Number(req.query.id_negocio) : null,
            canal: req.query.canal || null,
            estado: req.query.estado || null,
            conError: req.query.con_error === 'true',
            desde,
            hasta,
            dias,
            q: (req.query.q || '').trim(),
            limit,
            offset,
        };

        const filtros = `
            WHERE c.creado_en >= COALESCE(:desde::timestamptz, now() - (:dias || ' days')::interval)
              AND (:hasta::timestamptz IS NULL OR c.creado_en <= :hasta::timestamptz)
              AND (:idNegocio::int IS NULL OR c.id_negocio = :idNegocio)
              AND (:canal::text  IS NULL OR c.canal  = :canal)
              AND (:estado::text IS NULL OR c.estado = :estado)
              AND (:q = '' OR c.id_externo ILIKE '%' || :q || '%')
              AND (NOT :conError OR EXISTS (
                    SELECT 1 FROM intelligence.turno t
                     WHERE t.id_conversacion = c.id_conversacion AND t.resultado = 'error'
              ))
        `;

        const filas = await Models.sequelize.query(
            `
            SELECT
                c.id_conversacion,
                c.id_negocio,
                n.nombre                                   AS negocio,
                c.canal,
                c.id_externo,
                c.estado,
                c.tarea_actual,
                c.creado_en,
                c.ultimo_mensaje_en,
                COALESCE(t.turnos, 0)                      AS turnos,
                COALESCE(t.con_error, 0)                   AS turnos_con_error,
                COALESCE(t.reintentos, 0)                  AS reintentos,
                t.ultimo_nivel                             AS nivel,
                COALESCE(m.mensajes, 0)                    AS mensajes,
                -- En F5 esto es siempre 0. Se muestra igual: es un resultado, no un hueco.
                COALESCE(k.costo_usd, 0)                   AS costo_usd
              FROM intelligence.conversacion c
              LEFT JOIN general.gener_negocio n ON n.id_negocio = c.id_negocio
              LEFT JOIN LATERAL (
                    SELECT COUNT(*)::int                                        AS turnos,
                           COUNT(*) FILTER (WHERE resultado = 'error')::int     AS con_error,
                           COALESCE(SUM(GREATEST(intentos - 1, 0)), 0)::int     AS reintentos,
                           (ARRAY_AGG(nivel ORDER BY secuencia DESC))[1]        AS ultimo_nivel
                      FROM intelligence.turno
                     WHERE id_conversacion = c.id_conversacion
              ) t ON TRUE
              LEFT JOIN LATERAL (
                    SELECT COUNT(*)::int AS mensajes
                      FROM intelligence.mensaje WHERE id_conversacion = c.id_conversacion
              ) m ON TRUE
              LEFT JOIN LATERAL (
                    SELECT COALESCE(SUM(costo_usd), 0) AS costo_usd
                      FROM intelligence.costo WHERE id_conversacion = c.id_conversacion
              ) k ON TRUE
            ${filtros}
             ORDER BY c.ultimo_mensaje_en DESC NULLS LAST, c.creado_en DESC
             LIMIT :limit OFFSET :offset;
            `,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT }
        );

        const [{ total }] = await Models.sequelize.query(
            `SELECT COUNT(*)::int AS total FROM intelligence.conversacion c ${filtros};`,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT }
        );

        return Respuesta.success(res, 'Conversaciones obtenidas', {
            conversaciones: filas,
            total,
            limit,
            offset,
        });
    } catch (error) {
        return Respuesta.error(res, `Error al listar conversaciones: ${error.message}`, 500);
    }
}

/**
 * GET /admin/intelligence/conversaciones/:id
 *
 * El rastro completo de una conversación: sus mensajes, sus turnos, y dentro de cada turno los
 * **pasos** (por qué decidió lo que decidió) y las **invocaciones de capacidad** (qué hizo de
 * verdad, con qué argumentos y con qué resultado).
 *
 * Es la pantalla que sustituye a leer logs. Por eso el turno trae `error_detalle` completo y
 * los argumentos de cada invocación: después de un incidente, la única pregunta que importa es
 * qué se pidió exactamente.
 */
async function detalleConversacion(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }
        if (!(await hayEsquemaIntelligence())) return sinEsquema(res);

        const repl = { id: req.params.id };

        const [conversacion] = await Models.sequelize.query(
            `
            SELECT c.*, n.nombre AS negocio, pn.nombre_mostrado AS persona, pn.telefono_e164
              FROM intelligence.conversacion c
              LEFT JOIN general.gener_negocio n         ON n.id_negocio = c.id_negocio
              LEFT JOIN platform.persona_negocio pn     ON pn.id_persona_negocio = c.id_persona_negocio
             WHERE c.id_conversacion = :id;
            `,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT }
        );

        if (!conversacion) {
            return Respuesta.error(res, 'Conversación no encontrada', 404);
        }

        const mensajes = await Models.sequelize.query(
            `
            SELECT id_mensaje, id_turno, direccion, canal, contenido, opciones,
                   estado_entrega, intentos_entrega, enviado_en, entregado_en, creado_en
              FROM intelligence.mensaje
             WHERE id_conversacion = :id
             ORDER BY creado_en, id_mensaje;
            `,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT }
        );

        const turnos = await Models.sequelize.query(
            `
            SELECT t.id_turno, t.secuencia, t.nivel, t.estado, t.resultado,
                   t.error_codigo, t.error_detalle, t.intentos, t.latencia_ms,
                   t.creado_en, t.terminado_en,
                   COALESCE(p.pasos, '[]'::json)         AS pasos,
                   COALESCE(i.invocaciones, '[]'::json)  AS invocaciones,
                   COALESCE(k.costo_usd, 0)              AS costo_usd
              FROM intelligence.turno t
              LEFT JOIN LATERAL (
                    SELECT json_agg(json_build_object(
                               'secuencia', secuencia, 'tipo', tipo, 'decision', decision,
                               'motivo', motivo, 'latencia_ms', latencia_ms
                           ) ORDER BY secuencia) AS pasos
                      FROM intelligence.paso WHERE id_turno = t.id_turno
              ) p ON TRUE
              LEFT JOIN LATERAL (
                    SELECT json_agg(json_build_object(
                               'capacidad', capacidad, 'vertical', vertical,
                               'argumentos', argumentos, 'resultado', resultado,
                               'error_codigo', error_codigo, 'dry_run', dry_run,
                               'latencia_ms', latencia_ms
                           ) ORDER BY creado_en) AS invocaciones
                      FROM intelligence.invocacion_capacidad WHERE id_turno = t.id_turno
              ) i ON TRUE
              LEFT JOIN LATERAL (
                    SELECT COALESCE(SUM(costo_usd), 0) AS costo_usd
                      FROM intelligence.costo WHERE id_turno = t.id_turno
              ) k ON TRUE
             WHERE t.id_conversacion = :id
             ORDER BY t.secuencia;
            `,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT }
        );

        return Respuesta.success(res, 'Conversación obtenida', { conversacion, mensajes, turnos });
    } catch (error) {
        return Respuesta.error(res, `Error al obtener la conversación: ${error.message}`, 500);
    }
}

/**
 * GET /admin/intelligence/metricas
 *
 * Las doce preguntas de ADR-022, hasta donde F5 puede responderlas.
 *
 * Las de IA —modelo, tokens, aciertos de caché— salen en cero porque **no hay IA**, y ése es
 * justamente el dato: el ratio determinista-vs-IA en 100/0 y el costo en $0.00 son criterios
 * de aceptación de F5, no columnas vacías esperando a llenarse.
 *
 * Query: ?id_negocio= &desde= &hasta=
 */
async function metricas(req, res) {
    try {
        if (!(await hayEsquemaIntelligence())) return sinEsquema(res);

        const { desde, hasta, dias } = ventana(req);
        const repl = {
            idNegocio: req.query.id_negocio ? Number(req.query.id_negocio) : null,
            desde,
            hasta,
            dias,
        };

        const rango = `
            t.creado_en >= COALESCE(:desde::timestamptz, now() - (:dias || ' days')::interval)
            AND (:hasta::timestamptz IS NULL OR t.creado_en <= :hasta::timestamptz)
            AND (:idNegocio::int IS NULL OR t.id_negocio = :idNegocio)
        `;

        const [turnos] = await Models.sequelize.query(
            `
            SELECT
                COUNT(*)::int                                                AS turnos,
                COUNT(*) FILTER (WHERE t.resultado = 'resuelto')::int        AS resueltos,
                COUNT(*) FILTER (WHERE t.resultado = 'error')::int           AS con_error,
                COUNT(*) FILTER (WHERE t.resultado = 'handoff')::int         AS handoff,
                COUNT(*) FILTER (WHERE t.nivel = 'determinista')::int        AS deterministas,
                COUNT(*) FILTER (WHERE t.nivel = 'llm')::int                 AS con_llm,
                COALESCE(SUM(GREATEST(t.intentos - 1, 0)), 0)::int           AS reintentos,
                COALESCE(ROUND(AVG(t.latencia_ms))::int, 0)                  AS latencia_media_ms,
                COALESCE(
                    PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY t.latencia_ms)::int, 0
                )                                                            AS latencia_p95_ms
              FROM intelligence.turno t
             WHERE ${rango};
            `,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT }
        );

        const capacidades = await Models.sequelize.query(
            `
            SELECT i.capacidad, i.vertical,
                   COUNT(*)::int                                          AS invocaciones,
                   COUNT(*) FILTER (WHERE i.resultado = 'error')::int      AS errores,
                   COALESCE(ROUND(AVG(i.latencia_ms))::int, 0)            AS latencia_media_ms
              FROM intelligence.invocacion_capacidad i
             WHERE i.creado_en >= COALESCE(:desde::timestamptz, now() - (:dias || ' days')::interval)
               AND (:hasta::timestamptz IS NULL OR i.creado_en <= :hasta::timestamptz)
               AND (:idNegocio::int IS NULL OR i.id_negocio = :idNegocio)
             GROUP BY i.capacidad, i.vertical
             ORDER BY invocaciones DESC;
            `,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT }
        );

        const costos = await Models.sequelize.query(
            `
            SELECT k.id_negocio, n.nombre AS negocio, k.modelo, k.proveedor,
                   COALESCE(SUM(k.costo_usd), 0)                AS costo_usd,
                   COALESCE(SUM(k.tokens_entrada), 0)::bigint   AS tokens_entrada,
                   COALESCE(SUM(k.tokens_salida), 0)::bigint    AS tokens_salida
              FROM intelligence.costo k
              LEFT JOIN general.gener_negocio n ON n.id_negocio = k.id_negocio
             WHERE k.creado_en >= COALESCE(:desde::timestamptz, now() - (:dias || ' days')::interval)
               AND (:hasta::timestamptz IS NULL OR k.creado_en <= :hasta::timestamptz)
               AND (:idNegocio::int IS NULL OR k.id_negocio = :idNegocio)
             GROUP BY k.id_negocio, n.nombre, k.modelo, k.proveedor
             ORDER BY costo_usd DESC;
            `,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT }
        );

        const [conversaciones] = await Models.sequelize.query(
            `
            SELECT COUNT(*)::int                                        AS conversaciones,
                   COUNT(*) FILTER (WHERE c.estado = 'activa')::int     AS activas,
                   COUNT(DISTINCT c.id_negocio)::int                    AS negocios
              FROM intelligence.conversacion c
             WHERE c.creado_en >= COALESCE(:desde::timestamptz, now() - (:dias || ' days')::interval)
               AND (:hasta::timestamptz IS NULL OR c.creado_en <= :hasta::timestamptz)
               AND (:idNegocio::int IS NULL OR c.id_negocio = :idNegocio);
            `,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT }
        );

        const total = turnos.turnos || 0;
        return Respuesta.success(res, 'Métricas obtenidas', {
            ventana_dias: desde ? null : dias,
            conversaciones,
            turnos,
            // Se calculan aquí y no en el cliente para que la Consola y cualquier informe
            // futuro respondan exactamente el mismo número.
            tasa_resolucion: total ? Number((turnos.resueltos / total).toFixed(4)) : null,
            ratio_determinista: total ? Number((turnos.deterministas / total).toFixed(4)) : null,
            capacidades,
            costos,
            costo_total_usd: costos.reduce((suma, c) => suma + Number(c.costo_usd || 0), 0),
        });
    } catch (error) {
        return Respuesta.error(res, `Error al obtener métricas: ${error.message}`, 500);
    }
}

/**
 * Deshace una baja: `bloqueada` → `activa`.
 *
 * Deliberadamente estrecho. Solo actúa sobre una conversación **bloqueada** —no es un cambiador
 * de estados de propósito general— y exige un motivo que queda en la auditoría junto al id del
 * super admin que lo pulsó.
 *
 * El `WHERE ... estado = 'bloqueada'` no es solo una guarda: hace la operación idempotente y
 * distingue «no existe» de «no estaba bloqueada», que son dos respuestas distintas para quien
 * mira la pantalla.
 */
async function desbloquearConversacion(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }
        if (!(await hayEsquemaIntelligence())) return sinEsquema(res);

        const motivo = String(req.body?.motivo || '').trim();

        const [fila] = await Models.sequelize.query(
            `
            UPDATE intelligence.conversacion
               SET estado = 'activa'
             WHERE id_conversacion = :id AND estado = 'bloqueada'
            RETURNING id_conversacion, id_negocio, canal, id_externo, estado;
            `,
            { replacements: { id: req.params.id }, type: Models.sequelize.QueryTypes.SELECT }
        );

        if (!fila) {
            const [existe] = await Models.sequelize.query(
                `SELECT estado FROM intelligence.conversacion WHERE id_conversacion = :id;`,
                { replacements: { id: req.params.id }, type: Models.sequelize.QueryTypes.SELECT }
            );
            return existe
                ? Respuesta.error(res, `La conversación no está bloqueada (está "${existe.estado}")`, 409)
                : Respuesta.error(res, 'Conversación no encontrada', 404);
        }

        await Audit.registrarEvento({
            modulo: 'intelligence_consola',
            accion: 'desbloquear_conversacion',
            resultado: 'ok',
            idUsuario: req.usuario?.id_usuario ?? null,
            idNegocio: fila.id_negocio,
            ip: req.ip,
            detalle: { id_conversacion: fila.id_conversacion, canal: fila.canal, motivo },
        });

        return Respuesta.success(res, 'Conversación desbloqueada', fila);
    } catch (error) {
        return Respuesta.error(res, `Error al desbloquear la conversación: ${error.message}`, 500);
    }
}

module.exports = {
    listarConversaciones,
    detalleConversacion,
    metricas,
    desbloquearConversacion,
    /** Solo para tests: obliga a volver a comprobar si el esquema existe. */
    _olvidarEsquema: () => {
        esquemaPresente = null;
    },
};
