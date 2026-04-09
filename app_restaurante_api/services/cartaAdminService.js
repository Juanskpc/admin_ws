const Models = require('../../app_core/models/conection');

/**
 * cartaAdminService — CRUD de categorías, productos e ingredientes del menú.
 */

// ================================================================
// INGREDIENTES BASE
// ================================================================

/** Lista todos los ingredientes activos de un negocio. */
async function getIngredientes(idNegocio) {
    return Models.CartaIngrediente.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_ingrediente', 'nombre', 'unidad_medida', 'stock_actual', 'stock_minimo', 'stock_maximo'],
        order: [['nombre', 'ASC']],
    });
}

/** Crea un ingrediente base nuevo. */
async function crearIngrediente(idNegocio, nombre, defaults = {}) {
    return Models.CartaIngrediente.create({
        id_negocio: idNegocio,
        nombre,
        unidad_medida: defaults.unidad_medida || 'g',
        stock_actual: defaults.stock_actual ?? 0,
        stock_minimo: defaults.stock_minimo ?? 0,
        stock_maximo: defaults.stock_maximo ?? 0,
    });
}

// ================================================================
// CATEGORÍAS
// ================================================================

/** Lista categorías (activas e inactivas) para administración. */
async function getCategoriasAdmin(idNegocio) {
    return Models.CartaCategoria.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_categoria', 'nombre', 'descripcion', 'icono', 'orden', 'estado'],
        include: [{
            model: Models.CartaProducto,
            as: 'productos',
            where: { estado: 'A' },
            required: false,
            attributes: ['id_producto', 'disponible'],
        }],
        order: [['orden', 'ASC'], ['nombre', 'ASC']],
    });
}

/** Crea una categoría para el menú. */
async function crearCategoria({ id_negocio, nombre, descripcion, icono, orden }) {
    return Models.CartaCategoria.create({
        id_negocio,
        nombre,
        descripcion: descripcion || null,
        icono: icono || '🍽️',
        orden: orden || 0,
    });
}

/** Edita una categoría existente. */
async function editarCategoria(idCategoria, { nombre, descripcion, icono, orden }) {
    const cat = await Models.CartaCategoria.findByPk(idCategoria);
    if (!cat) throw new Error('Categoría no encontrada');
    return cat.update({
        nombre:      nombre      ?? cat.nombre,
        descripcion: descripcion ?? cat.descripcion,
        icono:       icono       ?? cat.icono,
        orden:       orden       ?? cat.orden,
    });
}

/** Soft-delete de una categoría (estado = 'I'). */
async function eliminarCategoria(idCategoria) {
    const cat = await Models.CartaCategoria.findByPk(idCategoria);
    if (!cat) throw new Error('Categoría no encontrada');
    // Soft-delete también los productos de la categoría
    await Models.CartaProducto.update(
        { estado: 'I' },
        { where: { id_categoria: idCategoria } }
    );
    return cat.update({ estado: 'I' });
}

// ================================================================
// PRODUCTOS
// ================================================================

/** Lista todos los productos activos de un negocio (admin: incluye no disponibles). */
async function getProductosAdmin(idNegocio, idCategoria) {
    const where = { id_negocio: idNegocio, estado: 'A' };
    if (idCategoria) where.id_categoria = idCategoria;

    return Models.CartaProducto.findAll({
        where,
        attributes: [
            'id_producto', 'id_categoria', 'nombre', 'descripcion',
            'precio', 'imagen_url', 'icono', 'es_popular', 'disponible',
        ],
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
            attributes: ['id_producto_ingred', 'porcion', 'unidad_medida', 'es_removible'],
        }],
        order: [['es_popular', 'DESC'], ['nombre', 'ASC']],
    });
}

/** Crea un producto con sus ingredientes. */
async function crearProducto({ id_negocio, id_categoria, nombre, descripcion, precio, icono, imagen_url, es_popular, disponible, ingredientes }) {
    const t = await Models.sequelize.transaction();
    try {
        const prod = await Models.CartaProducto.create({
            id_negocio,
            id_categoria,
            nombre,
            descripcion: descripcion || null,
            precio,
            icono: icono || '🍔',
            imagen_url: imagen_url || null,
            es_popular: es_popular || false,
            disponible: disponible !== undefined ? disponible : true,
        }, { transaction: t });

        if (Array.isArray(ingredientes) && ingredientes.length > 0) {
            const rows = ingredientes.map(i => ({
                id_producto:    prod.id_producto,
                id_ingrediente: i.id_ingrediente,
                porcion:        i.porcion || 0,
                unidad_medida:  i.unidad_medida || 'g',
                es_removible:   i.es_removible !== undefined ? i.es_removible : true,
            }));
            await Models.CartaProductoIngred.bulkCreate(rows, { transaction: t });
        }

        await t.commit();
        return prod;
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

/** Edita un producto y sincroniza su lista de ingredientes. */
async function editarProducto(idProducto, { id_categoria, nombre, descripcion, precio, icono, imagen_url, es_popular, disponible, ingredientes }) {
    const t = await Models.sequelize.transaction();
    try {
        const prod = await Models.CartaProducto.findByPk(idProducto);
        if (!prod) throw new Error('Producto no encontrado');

        await prod.update({
            id_categoria: id_categoria ?? prod.id_categoria,
            nombre:       nombre       ?? prod.nombre,
            descripcion:  descripcion  !== undefined ? descripcion  : prod.descripcion,
            precio:       precio       ?? prod.precio,
            icono:        icono        ?? prod.icono,
            imagen_url:   imagen_url   !== undefined ? imagen_url   : prod.imagen_url,
            es_popular:   es_popular   !== undefined ? es_popular   : prod.es_popular,
            disponible:   disponible   !== undefined ? disponible   : prod.disponible,
        }, { transaction: t });

        // Sync ingredientes (soft-delete los viejos, re-insert)
        if (Array.isArray(ingredientes)) {
            await Models.CartaProductoIngred.update(
                { estado: 'I' },
                { where: { id_producto: idProducto }, transaction: t }
            );
            if (ingredientes.length > 0) {
                const rows = ingredientes.map(i => ({
                    id_producto:    idProducto,
                    id_ingrediente: i.id_ingrediente,
                    porcion:        i.porcion || 0,
                    unidad_medida:  i.unidad_medida || 'g',
                    es_removible:   i.es_removible !== undefined ? i.es_removible : true,
                }));
                await Models.CartaProductoIngred.bulkCreate(rows, { transaction: t });
            }
        }

        await t.commit();
        return prod;
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

/** Soft-delete de un producto. */
async function eliminarProducto(idProducto) {
    const prod = await Models.CartaProducto.findByPk(idProducto);
    if (!prod) throw new Error('Producto no encontrado');
    return prod.update({ estado: 'I' });
}

module.exports = {
    getIngredientes,
    crearIngrediente,
    getCategoriasAdmin,
    crearCategoria,
    editarCategoria,
    eliminarCategoria,
    getProductosAdmin,
    crearProducto,
    editarProducto,
    eliminarProducto,
};
