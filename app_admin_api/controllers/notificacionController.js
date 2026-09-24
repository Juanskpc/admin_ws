'use strict';
const notificacionDao = require('../../app_core/dao/notificacionDao');
const negocioDao = require('../../app_core/dao/negocioDao');
const Models = require('../../app_core/models/conection');

/**
 * Tipos que la campana NO lista como notificación porque se derivan en la lectura.
 *
 * `CONVERSACION_ESCALADA` es una foto de un instante («había 3 esperando a las 4:10») y seguía
 * «sin leer» después de contestar, o no se creaba porque el aviso se limita a uno cada quince
 * minutos. Lo que la campana enseña de esto es ahora la lista VIVA de conversaciones que esperan
 * (`getConversacionesEsperando`). Las filas se siguen escribiendo —`intelligence/avisos/escalado.js`
 * las usa para no mandar más de un correo por cuarto de hora—, solo que ya no se pintan.
 */
const TIPOS_DERIVADOS = ['CONVERSACION_ESCALADA'];

/** Mismo estado que usa la Bandeja: `intelligence/` no se importa desde aquí (ADR-005). */
const ESTADO_HANDOFF = 'handoff_humano';
const LIMITE_ESPERANDO = 20;

/**
 * Extrae los IDs de negocio del usuario autenticado.
 */
async function getIdsNegocioUsuario(req) {
    const idUsuario = req.usuario.id_usuario;
    const negocios = await negocioDao.getNegociosByUsuario(idUsuario);
    return negocios.map((n) => n.id_negocio);
}

/**
 * GET /mis-notificaciones
 * Lista notificaciones de todos los negocios del usuario autenticado.
 */
async function getMisNotificaciones(req, res) {
    try {
        const idsNegocio = await getIdsNegocioUsuario(req);
        const soloNoLeidas = req.query.no_leidas === 'true';
        const limit = parseInt(req.query.limit) || 50;

        const notificaciones = await notificacionDao.getNotificacionesMulti(idsNegocio, {
            soloNoLeidas,
            limit,
            excluirTipos: TIPOS_DERIVADOS,
        });

        res.json({
            success: true,
            data: notificaciones.map(n => ({
                id_notificacion: n.id_notificacion,
                id_negocio: n.id_negocio,
                tipo: n.tipo,
                titulo: n.titulo,
                mensaje: n.mensaje,
                leida: n.leida,
                fecha_creacion: n.fecha_creacion,
                fecha_lectura: n.fecha_lectura
            }))
        });
    } catch (err) {
        console.error('Error obteniendo mis notificaciones:', err);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
}

/**
 * GET /mis-notificaciones/no-leidas
 * Cuenta notificaciones no leídas de todos los negocios del usuario.
 */
async function contarMisNoLeidas(req, res) {
    try {
        const idsNegocio = await getIdsNegocioUsuario(req);
        const total = await notificacionDao.contarNoLeidasMulti(idsNegocio, {
            excluirTipos: TIPOS_DERIVADOS,
        });

        res.json({ success: true, data: { total } });
    } catch (err) {
        console.error('Error contando mis notificaciones:', err);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
}

/**
 * GET /mis-notificaciones/esperando-respuesta
 *
 * Las conversaciones de los negocios DEL USUARIO que esperan a una persona: escaladas y sin
 * atender (la misma definición que la columna «escalada» de la Bandeja). Se calcula al leer, no
 * se escribe: no hay fila que pueda quedarse vieja cuando alguien contesta o la marca atendida.
 *
 * Multi-tenant: el alcance son los negocios que `getIdsNegocioUsuario` devuelve para el token —
 * los mismos que las demás notificaciones—, nunca un `id_negocio` de la petición. Un super admin
 * ve aquí los suyos, no los de todos los clientes: la campana es personal, la Consola es global.
 *
 * Sin el esquema `intelligence` migrado no es un error: es «no hay nadie esperando».
 */
async function getConversacionesEsperando(req, res) {
    try {
        const idsNegocio = await getIdsNegocioUsuario(req);
        const vacio = { total: 0, conversaciones: [] };
        if (idsNegocio.length === 0) return res.json({ success: true, data: vacio });

        const SELECT = { type: Models.sequelize.QueryTypes.SELECT };
        const hay = await Models.sequelize.query(
            `SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'intelligence' AND table_name = 'conversacion' LIMIT 1;`,
            SELECT
        );
        if (hay.length === 0) return res.json({ success: true, data: vacio });

        const replacements = { ids: idsNegocio, handoff: ESTADO_HANDOFF, limite: LIMITE_ESPERANDO };
        const [conteo] = await Models.sequelize.query(
            `SELECT count(*)::int AS total
               FROM intelligence.conversacion c
              WHERE c.id_negocio IN (:ids) AND c.estado = :handoff AND c.atendida_en IS NULL;`,
            { replacements, ...SELECT }
        );
        const conversaciones = await Models.sequelize.query(
            `SELECT c.id_conversacion, c.id_negocio, n.nombre AS negocio,
                    pn.nombre_mostrado AS persona, pn.telefono_e164, c.id_externo,
                    COALESCE(c.ultimo_mensaje_en, c.creado_en) AS ultimo_mensaje_en,
                    (SELECT m.contenido FROM intelligence.mensaje m
                      WHERE m.id_conversacion = c.id_conversacion
                      ORDER BY m.creado_en DESC LIMIT 1) AS ultimo_texto
               FROM intelligence.conversacion c
               LEFT JOIN general.gener_negocio n ON n.id_negocio = c.id_negocio
               LEFT JOIN platform.persona_negocio pn ON pn.id_persona_negocio = c.id_persona_negocio
              WHERE c.id_negocio IN (:ids) AND c.estado = :handoff AND c.atendida_en IS NULL
              ORDER BY COALESCE(c.ultimo_mensaje_en, c.creado_en) DESC
              LIMIT :limite;`,
            { replacements, ...SELECT }
        );

        res.json({ success: true, data: { total: conteo?.total ?? 0, conversaciones } });
    } catch (err) {
        console.error('Error consultando conversaciones que esperan respuesta:', err);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
}

/**
 * GET /notificaciones?id_negocio=X&no_leidas=true
 * Lista notificaciones de un negocio.
 */
async function getNotificaciones(req, res) {
    try {
        const id_negocio = parseInt(req.query.id_negocio || req.params.id_negocio);
        if (!id_negocio || isNaN(id_negocio)) {
            return res.status(400).json({ success: false, message: 'id_negocio es requerido' });
        }

        const soloNoLeidas = req.query.no_leidas === 'true';
        const limit = parseInt(req.query.limit) || 50;

        const notificaciones = await notificacionDao.getNotificaciones(id_negocio, { soloNoLeidas, limit });

        res.json({
            success: true,
            data: notificaciones.map(n => ({
                id_notificacion: n.id_notificacion,
                tipo: n.tipo,
                titulo: n.titulo,
                mensaje: n.mensaje,
                leida: n.leida,
                fecha_creacion: n.fecha_creacion,
                fecha_lectura: n.fecha_lectura
            }))
        });
    } catch (err) {
        console.error('Error obteniendo notificaciones:', err);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
}

/**
 * GET /notificaciones/no-leidas/:id_negocio
 * Cuenta notificaciones no leídas.
 */
async function contarNoLeidas(req, res) {
    try {
        const id_negocio = parseInt(req.params.id_negocio);
        if (!id_negocio || isNaN(id_negocio)) {
            return res.status(400).json({ success: false, message: 'id_negocio es requerido' });
        }

        const total = await notificacionDao.contarNoLeidas(id_negocio);

        res.json({ success: true, data: { total } });
    } catch (err) {
        console.error('Error contando notificaciones:', err);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
}

/**
 * PUT /notificaciones/:id_notificacion/leida
 * Marca una notificación como leída.
 */
async function marcarLeida(req, res) {
    try {
        const id_notificacion = parseInt(req.params.id_notificacion);
        const id_negocio = parseInt(req.body.id_negocio || req.query.id_negocio);

        if (!id_notificacion || isNaN(id_notificacion)) {
            return res.status(400).json({ success: false, message: 'id_notificacion es requerido' });
        }
        if (!id_negocio || isNaN(id_negocio)) {
            return res.status(400).json({ success: false, message: 'id_negocio es requerido' });
        }

        const actualizada = await notificacionDao.marcarLeida(id_notificacion, id_negocio);

        res.json({
            success: actualizada,
            message: actualizada ? 'Notificación marcada como leída' : 'Notificación no encontrada'
        });
    } catch (err) {
        console.error('Error marcando notificación:', err);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
}

/**
 * PUT /notificaciones/leer-todas/:id_negocio
 * Marca todas las notificaciones de un negocio como leídas.
 */
async function marcarTodasLeidas(req, res) {
    try {
        const id_negocio = parseInt(req.params.id_negocio);
        if (!id_negocio || isNaN(id_negocio)) {
            return res.status(400).json({ success: false, message: 'id_negocio es requerido' });
        }

        const actualizadas = await notificacionDao.marcarTodasLeidas(id_negocio);

        res.json({
            success: true,
            message: `${actualizadas} notificacion(es) marcada(s) como leída(s)`
        });
    } catch (err) {
        console.error('Error marcando todas las notificaciones:', err);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
}

module.exports = { getMisNotificaciones, contarMisNoLeidas, getConversacionesEsperando, getNotificaciones, contarNoLeidas, marcarLeida, marcarTodasLeidas };
