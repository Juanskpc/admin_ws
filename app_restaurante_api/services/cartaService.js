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
 * \u00bfEste negocio lleva control de inventario? Mismo criterio que
 * `pedidoService.negocioControlaInventario`: opt-OUT, encendido por defecto \u2014 si el negocio no
 * aparece, se asume que s\u00ed controla.
 */
async function negocioControlaInventario(idNegocio) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'controla_inventario'],
    });
    return negocio ? negocio.controla_inventario !== false : true;
}

/**
 * \u00bfAlcanza el stock actual para preparar una unidad m\u00e1s de este producto? Se calcula al vuelo
 * sobre `producto.ingredientes` (cada uno con `.ingrediente.stock_actual`), nunca se guarda.
 *
 * A prop\u00f3sito no toca `disponible`: ese sigue siendo el interruptor manual que el negocio prende
 * y apaga desde Productos. Quedarse sin insumo no es lo mismo que decidir retirar un plato de la
 * carta, as\u00ed que esto solo decide qu\u00e9 le ofrece el men\u00fa digital y el asistente de WhatsApp en el
 * momento en que preguntan \u2014 el producto sigue vi\u00e9ndose normal, "disponible", en Productos.
 */
function alcanzaStockPara(producto) {
    const receta = producto.ingredientes || [];
    return receta.every((pi) => {
        const porcion = Number(pi.porcion || 0);
        if (porcion <= 0) return true;
        return Number(pi.ingrediente?.stock_actual ?? 0) >= porcion;
    });
}

/** Include reutilizable: la receta con el stock actual de cada insumo, solo para `alcanzaStockPara`. */
const INCLUDE_INGREDIENTES_STOCK = {
    model: Models.CartaProductoIngred,
    as: 'ingredientes',
    where: { estado: 'A' },
    required: false,
    attributes: ['porcion'],
    include: [{
        model: Models.CartaIngrediente,
        as: 'ingrediente',
        attributes: ['stock_actual'],
    }],
};

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
    const controlaInventario = await negocioControlaInventario(idNegocio);

    const categorias = await Models.CartaCategoria.findAll({
        where: { id_negocio: idNegocio, estado: 'A', visible: true },
        attributes: ['id_categoria', 'nombre', 'descripcion', 'icono', 'imagen_url', 'orden'],
        include: [{
            model: Models.CartaProducto,
            as: 'productos',
            where: { estado: 'A', disponible: true, visible: true },
            required: false,
            attributes: ['id_producto'],
            include: controlaInventario ? [INCLUDE_INGREDIENTES_STOCK] : [],
        }],
        order: [['orden', 'ASC']],
    });

    if (controlaInventario) {
        for (const categoria of categorias) {
            categoria.productos = (categoria.productos || []).filter(alcanzaStockPara);
        }
    }
    return categorias;
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
 * diferencia entre lo que el negocio gestiona y lo que le enseña a un cliente. Y, sin guardar
 * nada, tampoco ofrece lo que hoy no alcanza en stock (ver `alcanzaStockPara`).
 */
async function getCartaPublica(idNegocio) {
    const controlaInventario = await negocioControlaInventario(idNegocio);

    const categorias = await Models.CartaCategoria.findAll({
        where: { id_negocio: idNegocio, estado: 'A', visible: true },
        attributes: ['id_categoria', 'nombre', 'descripcion', 'orden'],
        include: [{
            model: Models.CartaProducto,
            as: 'productos',
            where: { estado: 'A', disponible: true, visible: true },
            required: false,
            attributes: ['id_producto', 'nombre', 'descripcion', 'precio', 'es_popular'],
            include: controlaInventario ? [INCLUDE_INGREDIENTES_STOCK] : [],
        }],
        order: [
            ['orden', 'ASC'],
            [{ model: Models.CartaProducto, as: 'productos' }, 'es_popular', 'DESC'],
            [{ model: Models.CartaProducto, as: 'productos' }, 'nombre', 'ASC'],
        ],
    });

    if (controlaInventario) {
        for (const categoria of categorias) {
            categoria.productos = (categoria.productos || []).filter(alcanzaStockPara);
        }
    }
    return categorias;
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
 * Lo que hoy no alcanza en stock tampoco: a diferencia de `disponible`, eso no es una decisión
 * del negocio que la vista previa deba poder mostrar, así que `incluirAgotados` no lo trae de
 * vuelta (ver `alcanzaStockPara`).
 */
async function getCartaPublicaCompleta(idNegocio, { incluirAgotados = false } = {}) {
    const whereProductos = { estado: 'A', visible: true };
    if (!incluirAgotados) whereProductos.disponible = true;

    const controlaInventario = await negocioControlaInventario(idNegocio);

    const categorias = await Models.CartaCategoria.findAll({
        where: { id_negocio: idNegocio, estado: 'A', visible: true },
        attributes: ['id_categoria', 'nombre', 'descripcion', 'icono', 'imagen_url', 'orden'],
        include: [{
            model: Models.CartaProducto,
            as: 'productos',
            where: whereProductos,
            required: false,
            attributes: ['id_producto', 'nombre', 'descripcion', 'precio', 'imagen_url', 'icono', 'es_popular', 'disponible'],
            include: controlaInventario ? [INCLUDE_INGREDIENTES_STOCK] : [],
        }],
        order: [
            ['orden', 'ASC'],
            ['id_categoria', 'ASC'],
            [{ model: Models.CartaProducto, as: 'productos' }, 'disponible', 'DESC'],
            [{ model: Models.CartaProducto, as: 'productos' }, 'es_popular', 'DESC'],
            [{ model: Models.CartaProducto, as: 'productos' }, 'nombre', 'ASC'],
        ],
    });

    if (controlaInventario) {
        for (const categoria of categorias) {
            categoria.productos = (categoria.productos || []).filter(alcanzaStockPara);
        }
    }
    return categorias;
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

    const controlaInventario = await negocioControlaInventario(idNegocio);

    const productos = await Models.CartaProducto.findAll({
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
                attributes: ['id_ingrediente', 'nombre', 'stock_actual'],
            }],
            attributes: ['id_producto_ingred', 'es_removible', 'porcion'],
        }],
        // Con agotados, estos van al final: quien mira la carta ve primero lo que puede pedir.
        order: incluirAgotados
            ? [['disponible', 'DESC'], ['es_popular', 'DESC'], ['nombre', 'ASC']]
            : [['es_popular', 'DESC'], ['nombre', 'ASC']],
    });

    // Igual que `disponible`, pero sin guardarlo: lo que hoy no alcanza en stock tampoco sale
    // aquí, ni siquiera con `incluirAgotados` (ver `alcanzaStockPara`).
    return controlaInventario ? productos.filter(alcanzaStockPara) : productos;
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

    // `includeDisabled` es la misma bandera de siempre (vista de administración/POS vs. vista
    // pública). El stock sigue esa misma división: `includeDisabled=true` la deja fuera, igual
    // que ya dejaba fuera el filtro por `disponible`.
    const controlaInventario = !includeDisabled && (await negocioControlaInventario(idNegocio));

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
                attributes: ['id_ingrediente', 'nombre', 'stock_actual'],
            }],
            attributes: ['id_producto_ingred', 'es_removible', 'porcion'],
        }],
        order: [['es_popular', 'DESC'], ['nombre', 'ASC']],
    });

    return productos
        .filter((producto) => {
            const nombre = normalizeSearchText(producto.nombre);
            const descripcion = normalizeSearchText(producto.descripcion || '');
            return nombre.includes(normalizedTerm) || descripcion.includes(normalizedTerm);
        })
        .filter((producto) => !controlaInventario || alcanzaStockPara(producto))
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
