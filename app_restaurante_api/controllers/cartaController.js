const CartaService = require('../services/cartaService');
const adicionService = require('../services/adicionService');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * cartaController — Endpoints para el menú / carta del restaurante.
 */

/** GET /restaurante/carta/categorias?id_negocio=N */
async function getCategorias(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const categorias = await CartaService.getCategorias(idNegocio);
        // Con adiciones encendidas, una adición no se vende sola en el POS: no cuenta, y la
        // categoría que solo tenía adiciones no se ofrece.
        const ocultar = await adicionService.negocioPermiteAdiciones(idNegocio);

        // Transformar para incluir conteo de productos
        const data = [];
        for (const c of categorias) {
            const productos = c.productos || [];
            const vendibles = ocultar ? productos.filter(p => !p.es_adicion) : productos;
            if (productos.length > 0 && vendibles.length === 0) continue;
            data.push({
                id_categoria: c.id_categoria,
                nombre:       c.nombre,
                descripcion:  c.descripcion,
                icono:        c.icono,
                imagen_url:   c.imagen_url,
                orden:        c.orden,
                total_productos: vendibles.length,
            });
        }

        return Respuesta.success(res, 'Categorías obtenidas', data);
    } catch (err) {
        console.error('[Carta] Error getCategorias:', err.message);
        return Respuesta.error(res, 'Error al obtener las categorías.');
    }
}

/** GET /restaurante/carta/productos?id_negocio=N&id_categoria=N */
async function getProductos(req, res) {
    try {
        const idNegocio   = Number(req.query.id_negocio);
        const idCategoria = Number(req.query.id_categoria);
        if (!idNegocio || !idCategoria) {
            return Respuesta.error(res, 'id_negocio e id_categoria requeridos', 400);
        }

        const ocultar = await adicionService.negocioPermiteAdiciones(idNegocio);
        const productos = (await CartaService.getProductosByCategoria(idNegocio, idCategoria))
            .filter(p => !(ocultar && p.es_adicion));

        const data = productos.map(p => ({
            id_producto:  p.id_producto,
            nombre:       p.nombre,
            descripcion:  p.descripcion,
            precio:       Number(p.precio),
            imagen_url:   p.imagen_url,
            icono:        p.icono,
            es_popular:   p.es_popular,
            ingredientes: (p.ingredientes || []).map(pi => ({
                id_producto_ingred: pi.id_producto_ingred,
                id_ingrediente:     pi.ingrediente.id_ingrediente,
                nombre:             pi.ingrediente.nombre,
                porcion:            Number(pi.porcion),
                unidad_medida:      pi.unidad_medida,
                es_removible:       pi.es_removible,
            })),
        }));

        return Respuesta.success(res, 'Productos obtenidos', data);
    } catch (err) {
        console.error('[Carta] Error getProductos:', err.message);
        return Respuesta.error(res, 'Error al obtener los productos.');
    }
}

/** GET /restaurante/carta/buscar?id_negocio=N&q=texto */
async function buscarProductos(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        const termino   = (req.query.q || '').trim();
        const includeDisabledRaw = String(req.query.include_disabled || '').trim().toLowerCase();
        const includeDisabled = includeDisabledRaw === '1' || includeDisabledRaw === 'true';
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        if (!termino)   return Respuesta.success(res, 'Sin término de búsqueda', []);

        // El POS busca para vender: con adiciones encendidas, las adiciones no salen solas. (El
        // asistente llama al servicio directamente y las sigue encontrando.)
        const ocultar = await adicionService.negocioPermiteAdiciones(idNegocio);
        const productos = (await CartaService.buscarProductos(idNegocio, termino, { includeDisabled }))
            .filter(p => !(ocultar && p.es_adicion));

        const data = productos.map(p => ({
            id_producto:  p.id_producto,
            nombre:       p.nombre,
            descripcion:  p.descripcion,
            precio:       Number(p.precio),
            imagen_url:   p.imagen_url,
            icono:        p.icono,
            es_popular:   p.es_popular,
            disponible:   p.disponible !== false,
            visible:      p.visible !== false,
            categoria:    p.categoria ? { nombre: p.categoria.nombre, icono: p.categoria.icono } : null,
            ingredientes: (p.ingredientes || []).map(pi => ({
                id_producto_ingred: pi.id_producto_ingred,
                id_ingrediente:     pi.ingrediente.id_ingrediente,
                nombre:             pi.ingrediente.nombre,
                es_removible:       pi.es_removible,
            })),
        }));

        return Respuesta.success(res, 'Búsqueda completada', data);
    } catch (err) {
        console.error('[Carta] Error buscarProductos:', err.message);
        return Respuesta.error(res, 'Error en la búsqueda.');
    }
}

module.exports = { getCategorias, getProductos, buscarProductos };
