'use strict';
const notificacionDao = require('../../app_core/dao/notificacionDao');
const negocioDao = require('../../app_core/dao/negocioDao');

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

        const notificaciones = await notificacionDao.getNotificacionesMulti(idsNegocio, { soloNoLeidas, limit });

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
        const total = await notificacionDao.contarNoLeidasMulti(idsNegocio);

        res.json({ success: true, data: { total } });
    } catch (err) {
        console.error('Error contando mis notificaciones:', err);
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

module.exports = { getMisNotificaciones, contarMisNoLeidas, getNotificaciones, contarNoLeidas, marcarLeida, marcarTodasLeidas };
