const InventarioService = require('../services/inventarioService');
const Respuesta = require('../../app_core/helpers/respuesta');

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

module.exports = {
    getResumenInventario,
    ajustarStockIngrediente,
};
