const Models = require('../../app_core/models/conection');

/**
 * cartaService — Lógica de negocio para el menú / carta del restaurante.
 */

function normalizeSearchText(value = '') {
    return String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

/**
 * Lista las categorías activas de un negocio con conteo de productos.
 */
async function getCategorias(idNegocio) {
    return Models.CartaCategoria.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_categoria', 'nombre', 'descripcion', 'icono', 'orden'],
        include: [{
            model: Models.CartaProducto,
            as: 'productos',
            where: { estado: 'A', disponible: true },
            required: false,
            attributes: ['id_producto'],
        }],
        order: [['orden', 'ASC']],
    });
}

/**
 * Lista los productos de una categoría, con ingredientes.
 */
async function getProductosByCategoria(idNegocio, idCategoria) {
    return Models.CartaProducto.findAll({
        where: { id_negocio: idNegocio, id_categoria: idCategoria, estado: 'A', disponible: true },
        attributes: ['id_producto', 'nombre', 'descripcion', 'precio', 'imagen_url', 'icono', 'es_popular'],
        include: [{
            model: Models.CartaProductoIngred,
            as: 'ingredientes',
            where: { estado: 'A' },
            required: false,
            include: [{
                model: Models.CartaIngrediente,
                as: 'ingrediente',
                attributes: ['id_ingrediente', 'nombre'],
            }],
            attributes: ['id_producto_ingred', 'es_removible'],
        }],
        order: [['es_popular', 'DESC'], ['nombre', 'ASC']],
    });
}

/**
 * Busca productos por nombre dentro de un negocio.
 */
async function buscarProductos(idNegocio, termino, options = {}) {
    const includeDisabled = options.includeDisabled === true;
    const normalizedTerm = normalizeSearchText(termino);

    if (!normalizedTerm) {
        return [];
    }

    const productos = await Models.CartaProducto.findAll({
        where: {
            id_negocio: idNegocio,
            estado: 'A',
            ...(includeDisabled ? {} : { disponible: true }),
        },
        attributes: ['id_producto', 'nombre', 'descripcion', 'precio', 'icono', 'es_popular', 'id_categoria', 'disponible'],
        include: [{
            model: Models.CartaCategoria,
            as: 'categoria',
            attributes: ['nombre', 'icono'],
        }, {
            model: Models.CartaProductoIngred,
            as: 'ingredientes',
            where: { estado: 'A' },
            required: false,
            include: [{
                model: Models.CartaIngrediente,
                as: 'ingrediente',
                attributes: ['id_ingrediente', 'nombre'],
            }],
            attributes: ['id_producto_ingred', 'es_removible'],
        }],
        order: [['es_popular', 'DESC'], ['nombre', 'ASC']],
    });

    return productos
        .filter((producto) => {
            const nombre = normalizeSearchText(producto.nombre);
            const descripcion = normalizeSearchText(producto.descripcion || '');
            return nombre.includes(normalizedTerm) || descripcion.includes(normalizedTerm);
        })
        .slice(0, 20);
}

module.exports = {
    getCategorias,
    getProductosByCategoria,
    buscarProductos,
};
