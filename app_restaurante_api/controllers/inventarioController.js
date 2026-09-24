const InventarioService = require('../services/inventarioService');
const Respuesta = require('../../app_core/helpers/respuesta');
const { validationResult } = require('express-validator');
const { usuarioTieneSubnivel } = require('../../app_core/helpers/permisoSubnivel');

/** GET /restaurante/inventario/resumen?id_negocio=N */
async function getResumenInventario(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const data = await InventarioService.getInventarioResumen(idNegocio);
        return Respuesta.success(res, 'Resumen de inventario', data);
    } catch (err) {
        console.error('[Inventario] Error getResumenInventario:', err.message);
        return Respuesta.error(res, 'Error al obtener el resumen de inventario.');
    }
}

/** PATCH /restaurante/inventario/ingredientes/:id/ajuste */
async function ajustarStockIngrediente(req, res) {
    try {
        const idIngrediente = Number(req.params.id);
        const idNegocio = Number(req.body.id_negocio || req.query.id_negocio);

        if (!idIngrediente || !idNegocio) {
            return Respuesta.error(res, 'id de ingrediente e id_negocio son requeridos', 400);
        }

        const data = await InventarioService.ajustarStockIngrediente(idNegocio, idIngrediente, req.body);
        return Respuesta.success(res, 'Stock actualizado', data);
    } catch (err) {
        console.error('[Inventario] Error ajustarStockIngrediente:', err.message);
        return Respuesta.error(res, err.message || 'Error al ajustar el stock.');
    }
}

/**
 * POST /restaurante/inventario/ingredientes/:id/restablecer — deja el stock en 0 como ajuste.
 * Mismo permiso que el ajuste rápido (`inventario_ajuste_rapido`); se comprueba aquí, no solo en la
 * pantalla.
 */
async function restablecerStockACero(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return Respuesta.error(res, 'Datos inválidos', 400, errors.array());
    try {
        const idIngrediente = Number(req.params.id);
        const idNegocio = Number(req.body.id_negocio);

        const permitido = await usuarioTieneSubnivel({
            idUsuario: req.usuario.id_usuario,
            idNegocio,
            codigo: 'inventario_ajuste_rapido',
        });
        if (!permitido) {
            return Respuesta.error(res, 'No tienes permiso para ajustar el inventario.', 403, { code: 'SIN_PERMISO' });
        }

        const data = await InventarioService.restablecerStockACero(idNegocio, idIngrediente, {
            idUsuario: req.usuario.id_usuario,
        });
        return Respuesta.success(
            res,
            data.cambio ? 'Stock restablecido a 0' : 'El stock ya estaba en 0',
            data
        );
    } catch (err) {
        if (err.statusCode) {
            return Respuesta.error(res, err.message, err.statusCode, { code: err.code });
        }
        console.error('[Inventario] Error restablecerStockACero:', err.message);
        return Respuesta.error(res, 'Error al restablecer el stock.');
    }
}

module.exports = {
    getResumenInventario,
    ajustarStockIngrediente,
    restablecerStockACero,
};
