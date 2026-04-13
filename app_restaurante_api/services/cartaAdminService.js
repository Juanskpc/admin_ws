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
    const nombreNormalizado = String(nombre || '').trim();
    const existente = await Models.CartaIngrediente.findOne({
        where: {
            id_negocio: idNegocio,
            estado: 'A',
            [Models.Sequelize.Op.and]: [
                Models.Sequelize.where(
                    Models.Sequelize.fn('LOWER', Models.Sequelize.col('nombre')),
                    nombreNormalizado.toLowerCase()
                ),
            ],
        },
        attributes: ['id_ingrediente'],
    });

    if (existente) {
        const err = new Error('Ya existe un insumo con ese nombre.');
        err.code = 'INGREDIENTE_DUPLICADO';
        throw err;
    }

    return Models.CartaIngrediente.create({
        id_negocio: idNegocio,
        nombre: nombreNormalizado,
        unidad_medida: defaults.unidad_medida || 'g',
        stock_actual: defaults.stock_actual ?? 0,
        stock_minimo: defaults.stock_minimo ?? 0,
        stock_maximo: defaults.stock_maximo ?? 0,
    });
}

async function buildProductoIngredientesRows(idProducto, ingredientes, transaction) {
    if (!Array.isArray(ingredientes) || ingredientes.length === 0) {
        return [];
    }

    const ingredientesUnicos = new Map();
    for (const ing of ingredientes) {
        const idIngrediente = Number(ing?.id_ingrediente);
        if (!Number.isInteger(idIngrediente) || idIngrediente <= 0) {
            continue;
        }
        ingredientesUnicos.set(idIngrediente, ing);
    }

    if (ingredientesUnicos.size === 0) {
        return [];
    }

    const idsIngredientes = Array.from(ingredientesUnicos.keys());
    const ingredientesBase = await Models.CartaIngrediente.findAll({
        where: {
            id_ingrediente: idsIngredientes,
            estado: 'A',
        },
        attributes: ['id_ingrediente', 'unidad_medida'],
        transaction,
    });

    const unidadPorIngrediente = new Map(
        ingredientesBase.map((ing) => [
            Number(ing.id_ingrediente),
            ing.unidad_medida || 'g',
        ])
    );

    return Array.from(ingredientesUnicos.entries()).map(([idIngrediente, ing]) => ({
        id_producto: idProducto,
        id_ingrediente: idIngrediente,
        porcion: ing.porcion || 0,
        unidad_medida: ing.unidad_medida || unidadPorIngrediente.get(idIngrediente) || 'g',
        es_removible: ing.es_removible !== undefined ? ing.es_removible : true,
    }));
}

async function syncProductoIngredientes(idProducto, ingredientes, transaction) {
    const rows = await buildProductoIngredientesRows(idProducto, ingredientes, transaction);

    const relacionesExistentes = await Models.CartaProductoIngred.findAll({
        where: { id_producto: idProducto },
        attributes: ['id_producto_ingred', 'id_ingrediente', 'estado'],
        transaction,
    });

    const relacionPorIngrediente = new Map(
        relacionesExistentes.map((rel) => [Number(rel.id_ingrediente), rel])
    );
    const idsEntrantes = new Set(rows.map((row) => Number(row.id_ingrediente)));

    for (const row of rows) {
        const idIngrediente = Number(row.id_ingrediente);
        const existente = relacionPorIngrediente.get(idIngrediente);

        if (existente) {
            await existente.update({
                porcion: row.porcion,
                unidad_medida: row.unidad_medida,
                es_removible: row.es_removible,
                estado: 'A',
            }, { transaction });
            continue;
        }

        await Models.CartaProductoIngred.create({
            ...row,
            estado: 'A',
        }, { transaction });
    }

    const idsADesactivar = relacionesExistentes
        .filter((rel) => rel.estado === 'A' && !idsEntrantes.has(Number(rel.id_ingrediente)))
        .map((rel) => rel.id_producto_ingred);

    if (idsADesactivar.length > 0) {
        await Models.CartaProductoIngred.update(
            { estado: 'I' },
            {
                where: { id_producto_ingred: idsADesactivar },
                transaction,
            }
        );
    }
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
            attributes: ['id_producto_ingred', 'id_ingrediente', 'porcion', 'unidad_medida', 'es_removible'],
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
            const rows = await buildProductoIngredientesRows(prod.id_producto, ingredientes, t);
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

        // Sync ingredientes: actualiza existentes, reactiva eliminados lógicos,
        // crea sólo nuevos y desactiva los removidos.
        if (Array.isArray(ingredientes)) {
            await syncProductoIngredientes(idProducto, ingredientes, t);
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
