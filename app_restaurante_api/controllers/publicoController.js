const CartaService = require('../services/cartaService');
const PublicoService = require('../services/publicoService');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * publicoController — endpoints publicos para la carta.
 */

/** GET /restaurante/public/negocios/:id */
async function getNegocio(req, res) {
    try {
        const idNegocio = Number(req.params.id);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const negocio = await PublicoService.getNegocioPublico(idNegocio);
        if (!negocio) return Respuesta.error(res, 'Negocio no encontrado', 404);

        return Respuesta.success(res, 'Negocio obtenido', negocio);
    } catch (err) {
        console.error('[Publico] Error getNegocio:', err.message);
        return Respuesta.error(res, 'Error al obtener informacion del negocio.');
    }
}

/** GET /restaurante/public/carta/categorias?id_negocio=N */
async function getCategorias(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const categorias = await CartaService.getCategoriasPublicas(idNegocio);
        const data = categorias.map(c => ({
            id_categoria: c.id_categoria,
            nombre: c.nombre,
            descripcion: c.descripcion,
            icono: c.icono,
            orden: c.orden,
            total_productos: c.productos ? c.productos.length : 0,
        }));

        return Respuesta.success(res, 'Categorias obtenidas', data);
    } catch (err) {
        console.error('[Publico] Error getCategorias:', err.message);
        return Respuesta.error(res, 'Error al obtener las categorias.');
    }
}

/** GET /restaurante/public/carta/productos?id_negocio=N&id_categoria=N */
async function getProductos(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        const idCategoria = Number(req.query.id_categoria);
        if (!idNegocio || !idCategoria) {
            return Respuesta.error(res, 'id_negocio e id_categoria requeridos', 400);
        }

        const productos = await CartaService.getProductosPublicosByCategoria(idNegocio, idCategoria);
        const data = productos.map(p => ({
            id_producto: p.id_producto,
            nombre: p.nombre,
            descripcion: p.descripcion,
            precio: Number(p.precio),
            imagen_url: p.imagen_url,
            icono: p.icono,
            es_popular: p.es_popular,
            ingredientes: (p.ingredientes || []).map(pi => ({
                id_producto_ingred: pi.id_producto_ingred,
                id_ingrediente: pi.ingrediente.id_ingrediente,
                nombre: pi.ingrediente.nombre,
                es_removible: pi.es_removible,
            })),
        }));

        return Respuesta.success(res, 'Productos obtenidos', data);
    } catch (err) {
        console.error('[Publico] Error getProductos:', err.message);
        return Respuesta.error(res, 'Error al obtener los productos.');
    }
}

module.exports = {
    getNegocio,
    getCategorias,
    getProductos,
};
