const CartaService = require('../services/cartaService');
const PublicoService = require('../services/publicoService');
const Respuesta = require('../../app_core/helpers/respuesta');
const { tienePlanActivo } = require('../../app_core/helpers/planHelper');

const CODIGO_SIN_PLAN = 'SIN_PLAN_ACTIVO';

function planError(res) {
    return Respuesta.error(res, 'El negocio no cuenta con un plan activo.', 402, [{
        code: CODIGO_SIN_PLAN,
        message: 'Suscripcion inactiva',
    }]);
}

/** GET /restaurante/public/negocios/:id */
async function getNegocio(req, res) {
    try {
        const idNegocio = Number(req.params.id);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const negocio = await PublicoService.getNegocioPublico(idNegocio);
        if (!negocio) return Respuesta.error(res, 'Negocio no encontrado', 404);

        const planActivo = await tienePlanActivo(idNegocio);

        return Respuesta.success(res, 'Negocio obtenido', {
            ...negocio.toJSON(),
            plan_activo: planActivo,
        });
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

        if (!(await tienePlanActivo(idNegocio))) return planError(res);

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

        if (!(await tienePlanActivo(idNegocio))) return planError(res);

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

/** GET /restaurante/public/negocios/:id/paleta */
async function getPaleta(req, res) {
    try {
        const idNegocio = Number(req.params.id);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const paleta = await PublicoService.getPaletaNegocioPublico(idNegocio);
        if (!paleta) return Respuesta.error(res, 'Paleta no encontrada', 404);

        return Respuesta.success(res, 'Paleta obtenida', {
            id_paleta: paleta.id_paleta,
            nombre: paleta.nombre,
            colores: paleta.colores,
        });
    } catch (err) {
        console.error('[Publico] Error getPaleta:', err.message);
        return Respuesta.error(res, 'Error al obtener la paleta.');
    }
}

module.exports = {
    getNegocio,
    getCategorias,
    getProductos,
    getPaleta,
};
