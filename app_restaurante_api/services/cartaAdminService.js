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

/** Edita nombre y/o unidad de medida de un ingrediente. */
async function editarIngrediente(idIngrediente, { nombre, unidad_medida } = {}) {
    const ing = await Models.CartaIngrediente.findOne({
        where: { id_ingrediente: idIngrediente, estado: 'A' },
    });
    if (!ing) {
        const err = new Error('Ingrediente no encontrado.');
        err.code = 'INGREDIENTE_NO_ENCONTRADO'; err.statusCode = 404;
        throw err;
    }

    const nombreNormalizado = typeof nombre === 'string' ? nombre.trim() : null;
    if (nombreNormalizado && nombreNormalizado.toLowerCase() !== String(ing.nombre || '').toLowerCase()) {
        const duplicado = await Models.CartaIngrediente.findOne({
            where: {
                id_negocio: ing.id_negocio,
                estado: 'A',
                id_ingrediente: { [Models.Sequelize.Op.ne]: idIngrediente },
                [Models.Sequelize.Op.and]: [
                    Models.Sequelize.where(
                        Models.Sequelize.fn('LOWER', Models.Sequelize.col('nombre')),
                        nombreNormalizado.toLowerCase()
                    ),
                ],
            },
            attributes: ['id_ingrediente'],
        });
        if (duplicado) {
            const err = new Error('Ya existe un insumo con ese nombre.');
            err.code = 'INGREDIENTE_DUPLICADO'; err.statusCode = 409;
            throw err;
        }
    }

    const cambios = {};
    if (nombreNormalizado) cambios.nombre = nombreNormalizado;
    if (typeof unidad_medida === 'string' && unidad_medida.trim()) {
        cambios.unidad_medida = unidad_medida.trim();
    }
    if (Object.keys(cambios).length === 0) return ing;

    await ing.update(cambios);
    return ing;
}

/**
 * Desactiva un ingrediente y libera su nombre para reutilizarlo.
 * Mantiene trazabilidad de recetas historicas evitando borrar filas usadas.
 */
async function eliminarIngrediente(idIngrediente) {
    const ing = await Models.CartaIngrediente.findOne({
        where: { id_ingrediente: idIngrediente, estado: 'A' },
    });
    if (!ing) {
        const err = new Error('Ingrediente no encontrado.');
        err.code = 'INGREDIENTE_NO_ENCONTRADO'; err.statusCode = 404;
        throw err;
    }

    const t = await Models.sequelize.transaction();
    try {
        await Models.CartaProductoIngred.update(
            { estado: 'I' },
            { where: { id_ingrediente: idIngrediente }, transaction: t },
        );

        const nombreActual = String(ing.nombre || '').trim();
        const nombreInactivo = nombreActual
            ? `${nombreActual} (eliminado ${ing.id_ingrediente})`
            : `Insumo eliminado ${ing.id_ingrediente}`;

        await ing.update({ estado: 'I', nombre: nombreInactivo }, { transaction: t });
        await t.commit();
        return ing;
    } catch (err) {
        await t.rollback();
        throw err;
    }
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
        attributes: ['id_categoria', 'nombre', 'descripcion', 'icono', 'imagen_url', 'orden', 'visible', 'estado'],
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
async function crearCategoria({ id_negocio, nombre, descripcion, icono, imagen_url, orden, visible }) {
    return Models.CartaCategoria.create({
        id_negocio,
        nombre,
        descripcion: descripcion || null,
        icono: icono || '🍽️',
        imagen_url: imagen_url || null,
        orden: orden || 0,
        visible: visible !== undefined ? visible : true,
    });
}

/** Edita una categoría existente. */
async function editarCategoria(idCategoria, { nombre, descripcion, icono, imagen_url, orden, visible }) {
    const cat = await Models.CartaCategoria.findByPk(idCategoria);
    if (!cat) throw new Error('Categoría no encontrada');
    return cat.update({
        nombre:      nombre      ?? cat.nombre,
        descripcion: descripcion ?? cat.descripcion,
        icono:       icono       ?? cat.icono,
        imagen_url:  imagen_url  !== undefined ? imagen_url : cat.imagen_url,
        orden:       orden       ?? cat.orden,
        visible:     visible     !== undefined ? visible : cat.visible,
    });
}

/** Soft-delete de una categoría (estado = 'I'). */
async function eliminarCategoria(idCategoria) {
    const cat = await Models.CartaCategoria.findByPk(idCategoria);
    if (!cat) throw new Error('Categoría no encontrada');
    // Soft-delete también los productos de la categoría
    // En una transacción (los productos y la categoría van juntos) para que la auditoría de
    // carta_producto sepa quién fue: el actor solo se fija dentro de una.
    return Models.sequelize.transaction(async (t) => {
        await Models.CartaProducto.update(
            { estado: 'I' },
            { where: { id_categoria: idCategoria }, transaction: t }
        );
        return cat.update({ estado: 'I' }, { transaction: t });
    });
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
            'precio', 'imagen_url', 'icono', 'es_popular', 'disponible', 'visible',
            'id_producto_empaque', 'cantidad_empaque',
            // Datos fiscales: la pantalla de carta los enseña solo si el negocio factura.
            'codigo_impuesto', 'tarifa_impuesto', 'unidad_medida_dian', 'codigo_producto',
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

/**
 * El empaque ligado a un producto tiene que ser OTRO producto activo del MISMO negocio: el id llega
 * del navegador y un producto de otro inquilino ahí sería una fuga. Devuelve `{ id, cantidad }`
 * normalizados (sin empaque = `{ id: null, cantidad: 1 }`).
 */
async function validarEmpaque({ idNegocio, idProducto = null, idEmpaque, cantidad }, transaction) {
    if (idEmpaque === null || idEmpaque === '' || idEmpaque === 0) return { id: null, cantidad: 1 };
    const id = Number(idEmpaque);
    const cant = cantidad === undefined || cantidad === null || cantidad === '' ? 1 : Number(cantidad);
    const invalido = (mensaje) => {
        const e = new Error(mensaje);
        e.code = 'EMPAQUE_INVALIDO';
        e.statusCode = 400;
        return e;
    };
    if (!Number.isInteger(id) || id < 1) throw invalido('El empaque elegido no es válido.');
    if (idProducto && id === Number(idProducto)) throw invalido('Un producto no puede ser su propio empaque.');
    if (!Number.isInteger(cant) || cant < 1 || cant > 20) {
        throw invalido('La cantidad de empaques debe ser un número entre 1 y 20.');
    }
    const existe = await Models.CartaProducto.findOne({
        where: { id_producto: id, id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_producto'],
        transaction,
    });
    if (!existe) throw invalido('El empaque elegido no existe en este negocio.');
    return { id, cantidad: cant };
}

/** Crea un producto con sus ingredientes. */
/**
 * El impuesto de un producto va en pareja (código + tarifa) y tiene que estar en el catálogo:
 * un «INC al 19 %» no existe, y con él la DIAN rechazaría cada factura que lo lleve.
 * `undefined` en los dos = no tocar; `null` en el código = quitarlo (usa el del negocio).
 */
async function validarImpuesto({ codigo_impuesto, tarifa_impuesto }, t) {
    if (codigo_impuesto === undefined && tarifa_impuesto === undefined) return undefined;
    if (codigo_impuesto === null || codigo_impuesto === '') return { codigo_impuesto: null, tarifa_impuesto: null };
    const invalido = (mensaje) => {
        const e = new Error(mensaje);
        e.code = 'FE_IMPUESTO_INVALIDO';
        e.statusCode = 422;
        return e;
    };
    if (codigo_impuesto === undefined || tarifa_impuesto === undefined || tarifa_impuesto === null) {
        throw invalido('El impuesto del producto va con su tarifa: faltó uno de los dos.');
    }
    const [existe] = await Models.sequelize.query(
        `SELECT 1 FROM facturacion.fe_impuesto
          WHERE codigo = :codigo AND tarifa = :tarifa AND estado = 'A' LIMIT 1;`,
        {
            replacements: { codigo: String(codigo_impuesto), tarifa: Number(tarifa_impuesto) },
            transaction: t,
            type: Models.sequelize.QueryTypes.SELECT,
        }
    );
    if (!existe) throw invalido(`El impuesto ${codigo_impuesto} con tarifa ${tarifa_impuesto}% no existe.`);
    return { codigo_impuesto: String(codigo_impuesto), tarifa_impuesto: Number(tarifa_impuesto) };
}

const textoONull = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());

async function crearProducto({ id_negocio, id_categoria, nombre, descripcion, precio, icono, imagen_url, es_popular, disponible, visible, ingredientes, id_producto_empaque, cantidad_empaque, codigo_impuesto, tarifa_impuesto, unidad_medida_dian, codigo_producto }) {
    const t = await Models.sequelize.transaction();
    try {
        const impuesto = await validarImpuesto({ codigo_impuesto, tarifa_impuesto }, t);
        const empaque = await validarEmpaque(
            { idNegocio: id_negocio, idEmpaque: id_producto_empaque ?? null, cantidad: cantidad_empaque },
            t
        );
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
            visible: visible !== undefined ? visible : true,
            id_producto_empaque: empaque.id,
            cantidad_empaque: empaque.cantidad,
            codigo_impuesto: impuesto?.codigo_impuesto ?? null,
            tarifa_impuesto: impuesto?.tarifa_impuesto ?? null,
            unidad_medida_dian: textoONull(unidad_medida_dian),
            codigo_producto: textoONull(codigo_producto),
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
async function editarProducto(idProducto, { id_categoria, nombre, descripcion, precio, icono, imagen_url, es_popular, disponible, visible, ingredientes, id_producto_empaque, cantidad_empaque, codigo_impuesto, tarifa_impuesto, unidad_medida_dian, codigo_producto }) {
    const t = await Models.sequelize.transaction();
    try {
        const prod = await Models.CartaProducto.findByPk(idProducto);
        if (!prod) throw new Error('Producto no encontrado');

        // `undefined` = la edición no habla de impuestos (la de la imagen, por ejemplo): no se tocan.
        const impuesto = await validarImpuesto({ codigo_impuesto, tarifa_impuesto }, t);

        // `undefined` = no tocar el empaque (las ediciones que no lo mandan, como la de la imagen,
        // no deben borrarlo); `null` = quitarlo.
        let empaque = { id: prod.id_producto_empaque, cantidad: prod.cantidad_empaque };
        if (id_producto_empaque !== undefined || cantidad_empaque !== undefined) {
            empaque = await validarEmpaque(
                {
                    idNegocio: prod.id_negocio,
                    idProducto,
                    idEmpaque: id_producto_empaque !== undefined ? id_producto_empaque : prod.id_producto_empaque,
                    cantidad: cantidad_empaque !== undefined ? cantidad_empaque : prod.cantidad_empaque,
                },
                t
            );
        }

        await prod.update({
            id_categoria: id_categoria ?? prod.id_categoria,
            nombre:       nombre       ?? prod.nombre,
            descripcion:  descripcion  !== undefined ? descripcion  : prod.descripcion,
            precio:       precio       ?? prod.precio,
            icono:        icono        ?? prod.icono,
            imagen_url:   imagen_url   !== undefined ? imagen_url   : prod.imagen_url,
            es_popular:   es_popular   !== undefined ? es_popular   : prod.es_popular,
            disponible:   disponible   !== undefined ? disponible   : prod.disponible,
            visible:      visible      !== undefined ? visible      : prod.visible,
            id_producto_empaque: empaque.id,
            cantidad_empaque:    empaque.cantidad,
            codigo_impuesto:    impuesto ? impuesto.codigo_impuesto : prod.codigo_impuesto,
            tarifa_impuesto:    impuesto ? impuesto.tarifa_impuesto : prod.tarifa_impuesto,
            unidad_medida_dian: unidad_medida_dian !== undefined ? textoONull(unidad_medida_dian) : prod.unidad_medida_dian,
            codigo_producto:    codigo_producto    !== undefined ? textoONull(codigo_producto)    : prod.codigo_producto,
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
    // En transacción: el actor de auditoría solo se fija dentro de una.
    return Models.sequelize.transaction((t) => prod.update({ estado: 'I' }, { transaction: t }));
}

module.exports = {
    getIngredientes,
    crearIngrediente,
    editarIngrediente,
    eliminarIngrediente,
    getCategoriasAdmin,
    crearCategoria,
    editarCategoria,
    eliminarCategoria,
    getProductosAdmin,
    validarEmpaque,
    crearProducto,
    editarProducto,
    eliminarProducto,
};
