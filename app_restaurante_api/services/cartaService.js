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
        attributes: ['id_categoria', 'nombre', 'descripcion', 'icono', 'imagen_url', 'orden'],
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
 * Lista las categorias visibles del negocio para vista publica.
 */
async function getCategoriasPublicas(idNegocio) {
    return Models.CartaCategoria.findAll({
        where: { id_negocio: idNegocio, estado: 'A', visible: true },
        attributes: ['id_categoria', 'nombre', 'descripcion', 'icono', 'imagen_url', 'orden'],
        include: [{
            model: Models.CartaProducto,
            as: 'productos',
            where: { estado: 'A', disponible: true, visible: true },
            required: false,
            attributes: ['id_producto'],
        }],
        order: [['orden', 'ASC']],
    });
}

/**
 * La carta pública ENTERA: categorías visibles con sus productos y sus precios.
 *
 * `getCategoriasPublicas` trae los productos solo como ids —le basta, porque quien la usa pinta
 * una rejilla de categorías y luego pide la que se toque—. Quien necesita enseñar precios de una
 * sola vez tenía que pedir cada categoría por separado: N+1 consultas para armar una lista que
 * cabe en un mensaje de chat.
 *
 * Mismos filtros que las otras `...Publicas`: `visible` además de `disponible`, que es la
 * diferencia entre lo que el negocio gestiona y lo que le enseña a un cliente.
 */
async function getCartaPublica(idNegocio) {
    return Models.CartaCategoria.findAll({
        where: { id_negocio: idNegocio, estado: 'A', visible: true },
        attributes: ['id_categoria', 'nombre', 'descripcion', 'orden'],
        include: [{
            model: Models.CartaProducto,
            as: 'productos',
            where: { estado: 'A', disponible: true, visible: true },
            required: false,
            attributes: ['id_producto', 'nombre', 'descripcion', 'precio', 'es_popular'],
        }],
        order: [
            ['orden', 'ASC'],
            [{ model: Models.CartaProducto, as: 'productos' }, 'es_popular', 'DESC'],
            [{ model: Models.CartaProducto, as: 'productos' }, 'nombre', 'ASC'],
        ],
    });
}

/**
 * La carta pública entera, lista para pintar en una sola vista: cada categoría visible con
 * su foto y sus productos con foto, ícono y disponibilidad.
 *
 * La carta muestra todas las categorías seguidas y resalta la que se está leyendo al bajar.
 * Pedirlas una a una obligaba a N peticiones antes de poder pintar la página, y con una red
 * lenta las secciones aparecían a saltos mientras el cliente ya estaba haciendo scroll.
 *
 * `incluirAgotados` suma los productos con `disponible = false` al final de cada categoría;
 * la carta decide si mostrarlos según su diseño. Lo oculto (`visible = false`) no sale nunca.
 */
async function getCartaPublicaCompleta(idNegocio, { incluirAgotados = false } = {}) {
    const whereProductos = { estado: 'A', visible: true };
    if (!incluirAgotados) whereProductos.disponible = true;

    return Models.CartaCategoria.findAll({
        where: { id_negocio: idNegocio, estado: 'A', visible: true },
        attributes: ['id_categoria', 'nombre', 'descripcion', 'icono', 'imagen_url', 'orden'],
        include: [{
            model: Models.CartaProducto,
            as: 'productos',
            where: whereProductos,
            required: false,
            attributes: ['id_producto', 'nombre', 'descripcion', 'precio', 'imagen_url', 'icono', 'es_popular', 'disponible'],
        }],
        order: [
            ['orden', 'ASC'],
            ['id_categoria', 'ASC'],
            [{ model: Models.CartaProducto, as: 'productos' }, 'disponible', 'DESC'],
            [{ model: Models.CartaProducto, as: 'productos' }, 'es_popular', 'DESC'],
            [{ model: Models.CartaProducto, as: 'productos' }, 'nombre', 'ASC'],
        ],
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
 * Lista productos visibles de una categoria para vista publica.
 */
/**
 * `incluirAgotados` suma los productos con `disponible = false` al final de la lista. Por
 * defecto no se incluyen, que es lo que esperan el POS y el asistente de WhatsApp.
 */
async function getProductosPublicosByCategoria(idNegocio, idCategoria, { incluirAgotados = false } = {}) {
    const where = {
        id_negocio: idNegocio,
        id_categoria: idCategoria,
        estado: 'A',
        visible: true,
    };
    if (!incluirAgotados) where.disponible = true;

    return Models.CartaProducto.findAll({
        where,
        attributes: ['id_producto', 'nombre', 'descripcion', 'precio', 'imagen_url', 'icono', 'es_popular', 'disponible'],
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
        // Con agotados, estos van al final: quien mira la carta ve primero lo que puede pedir.
        order: incluirAgotados
            ? [['disponible', 'DESC'], ['es_popular', 'DESC'], ['nombre', 'ASC']]
            : [['es_popular', 'DESC'], ['nombre', 'ASC']],
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
        attributes: ['id_producto', 'nombre', 'descripcion', 'precio', 'imagen_url', 'icono', 'es_popular', 'id_categoria', 'disponible', 'visible'],
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
    getCartaPublicaCompleta,
    getCategorias,
    getProductosByCategoria,
    getCategoriasPublicas,
    getCartaPublica,
    getProductosPublicosByCategoria,
    buscarProductos,
};
