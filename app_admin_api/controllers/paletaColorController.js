const { param, body, validationResult } = require('express-validator');
const PaletaDao = require('../../app_core/dao/paletaColorDao');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * paletaColorController — Endpoints para gestión de paletas de colores.
 *
 *   GET  /paletas                     → Lista todas las paletas activas
 *   GET  /paletas/:id                 → Detalle de una paleta
 *   GET  /negocios/:id/paleta         → Paleta asignada al negocio
 *   PATCH /negocios/:id/paleta        → Asignar paleta a un negocio
 */

// ============================================================
// Listar paletas
// ============================================================

/**
 * GET /paletas
 * Retorna todas las paletas activas del sistema.
 */
async function getListaPaletas(req, res) {
    try {
        const paletas = await PaletaDao.findAll();
        return Respuesta.success(res, 'Paletas obtenidas correctamente', paletas);
    } catch (err) {
        console.error('[PaletaColor] Error al listar:', err.message);
        return Respuesta.error(res, 'Error al obtener las paletas de colores.');
    }
}

// ============================================================
// Detalle de paleta
// ============================================================

/** Validaciones: ID de paleta */
const paletaIdValidators = [
    param('id').isInt({ min: 1 }).withMessage('ID de paleta inválido'),
];

/**
 * GET /paletas/:id
 */
async function getPaletaById(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos inválidos', 400, errors.array());
    }

    try {
        const paleta = await PaletaDao.findById(req.params.id);
        if (!paleta) {
            return Respuesta.error(res, 'Paleta no encontrada', 404);
        }
        return Respuesta.success(res, 'Paleta obtenida', paleta);
    } catch (err) {
        console.error('[PaletaColor] Error al obtener:', err.message);
        return Respuesta.error(res, 'Error al obtener la paleta.');
    }
}

// ============================================================
// Paleta de un negocio
// ============================================================

/** Validaciones: ID de negocio */
const negocioIdValidators = [
    param('id').isInt({ min: 1 }).withMessage('ID de negocio inválido'),
];

/**
 * GET /negocios/:id/paleta
 * Retorna la paleta del negocio (o la default si no tiene asignada).
 */
async function getPaletaNegocio(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos inválidos', 400, errors.array());
    }

    try {
        const paleta = await PaletaDao.findByNegocio(req.params.id);
        if (!paleta) {
            return Respuesta.error(res, 'No se encontró paleta para este negocio', 404);
        }
        return Respuesta.success(res, 'Paleta del negocio obtenida', paleta);
    } catch (err) {
        console.error('[PaletaColor] Error al obtener paleta del negocio:', err.message);
        return Respuesta.error(res, 'Error al obtener la paleta del negocio.');
    }
}

// ============================================================
// Asignar paleta a un negocio
// ============================================================

/** Validaciones: asignar paleta */
const assignPaletaValidators = [
    param('id').isInt({ min: 1 }).withMessage('ID de negocio inválido'),
    body('id_paleta').isInt({ min: 1 }).withMessage('ID de paleta inválido'),
];

/**
 * PATCH /negocios/:id/paleta
 * Body: { id_paleta }
 */
async function assignPaletaNegocio(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos inválidos', 400, errors.array());
    }

    const { id } = req.params;
    const { id_paleta } = req.body;

    try {
        // Verificar que la paleta exista
        const paleta = await PaletaDao.findById(id_paleta);
        if (!paleta) {
            return Respuesta.error(res, 'La paleta seleccionada no existe o no está activa.', 404);
        }

        await PaletaDao.assignToNegocio(id, id_paleta);
        return Respuesta.success(res, `Paleta "${paleta.nombre}" asignada correctamente al negocio.`);
    } catch (err) {
        console.error('[PaletaColor] Error al asignar paleta:', err.message);
        return Respuesta.error(res, 'Error al asignar la paleta al negocio.');
    }
}

module.exports = {
    getListaPaletas,
    getPaletaById,
    paletaIdValidators,
    getPaletaNegocio,
    negocioIdValidators,
    assignPaletaNegocio,
    assignPaletaValidators,
};
