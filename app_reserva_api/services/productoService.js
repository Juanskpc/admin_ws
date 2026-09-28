'use strict';
const Models = require('../../app_core/models/conection');
const ImagenService = require('./imagenService');

/**
 * Catálogo de productos físicos que un negocio de `reserva` vende junto a sus servicios —
 * shampoo en un salón, cera en una barbería, alimento en un cuidado de mascotas—.
 *
 * Es una función del perfil (`productos`, ver `app_reserva_api/perfiles`), disponible en los
 * siete perfiles y apagada de fábrica: nada de esto existe para un negocio hasta que su dueño la
 * enciende en Configuración → Funciones.
 *
 * ## Categorías propias, no las de servicios
 *
 * `reserva_categoria` es de servicios; mezclar productos ahí habría obligado a filtrar por tipo
 * en cada sitio que ya la consulta (secciones del portal, el selector de un servicio nuevo), con
 * el riesgo de que un producto se colara donde no debía. `reserva_producto_categoria` es su
 * propia tabla, con la misma forma (orden, borrado que suelta en vez de arrastrar).
 */

function error(mensaje, statusCode = 400, code = null) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    if (code) e.code = code;
    return e;
}

// ───────────────────────── Categorías ─────────────────────────

async function listarCategorias(idNegocio, { incluirInactivas = false } = {}) {
    const where = { id_negocio: idNegocio };
    if (!incluirInactivas) where.estado = 'A';
    return Models.ReservaProductoCategoria.findAll({ where, order: [['orden', 'ASC'], ['nombre', 'ASC']] });
}

async function getCategoriaById(idCategoria, idNegocio) {
    return Models.ReservaProductoCategoria.findOne({ where: { id_categoria: idCategoria, id_negocio: idNegocio } });
}

async function crearCategoria({ idNegocio, nombre, descripcion }) {
    const limpio = String(nombre || '').trim();
    if (!limpio) throw error('El nombre de la categoría es obligatorio.', 422);

    const [[fila]] = await Models.sequelize.query(
        'SELECT COALESCE(MAX(orden), -1) + 1 AS siguiente FROM reserva.reserva_producto_categoria WHERE id_negocio = :n',
        { replacements: { n: idNegocio } },
    );
    return Models.ReservaProductoCategoria.create({
        id_negocio: idNegocio,
        nombre: limpio,
        descripcion: String(descripcion || '').trim() || null,
        orden: Number(fila.siguiente) || 0,
    });
}

async function actualizarCategoria(idCategoria, idNegocio, { nombre, descripcion }) {
    const cat = await getCategoriaById(idCategoria, idNegocio);
    if (!cat) throw error('Categoría no encontrada.', 404);
    const cambios = { fecha_actualizacion: new Date() };
    if (nombre !== undefined) {
        const limpio = String(nombre).trim();
        if (!limpio) throw error('El nombre de la categoría es obligatorio.', 422);
        cambios.nombre = limpio;
    }
    if (descripcion !== undefined) cambios.descripcion = String(descripcion || '').trim() || null;
    return cat.update(cambios);
}

/** Inactiva la categoría y suelta sus productos (quedan sin categoría, no se borran). */
async function inactivarCategoria(idCategoria, idNegocio) {
    const cat = await getCategoriaById(idCategoria, idNegocio);
    if (!cat) throw error('Categoría no encontrada.', 404);
    const t = await Models.sequelize.transaction();
    try {
        await Models.ReservaProducto.update(
            { id_categoria: null, fecha_actualizacion: new Date() },
            { where: { id_categoria: idCategoria, id_negocio: idNegocio }, transaction: t },
        );
        await cat.update({ estado: 'I', fecha_actualizacion: new Date() }, { transaction: t });
        await t.commit();
        return cat;
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

// ───────────────────────── Productos ─────────────────────────

async function listar(idNegocio, { incluirInactivos = false } = {}) {
    const where = { id_negocio: idNegocio };
    if (!incluirInactivos) where.estado = 'A';
    return Models.ReservaProducto.findAll({
        where,
        include: [{ model: Models.ReservaProductoCategoria, as: 'categoria', attributes: ['id_categoria', 'nombre'] }],
        order: [['nombre', 'ASC']],
    });
}

async function getById(idProducto, idNegocio) {
    return Models.ReservaProducto.findOne({ where: { id_producto: idProducto, id_negocio: idNegocio } });
}

/** Las que se venden hoy en el negocio: activas y visibles en el portal. Para la vitrina pública. */
async function listarPublico(idNegocio) {
    return Models.ReservaProducto.findAll({
        where: { id_negocio: idNegocio, estado: 'A', publico_activo: true },
        include: [{ model: Models.ReservaProductoCategoria, as: 'categoria', attributes: ['id_categoria', 'nombre', 'orden'] }],
        order: [['nombre', 'ASC']],
    });
}

function limpiarPrecio(valor, campo = 'precio') {
    const n = Number(valor);
    if (!Number.isFinite(n) || n < 0) throw error(`El ${campo} debe ser un número mayor o igual a cero.`, 422);
    return n;
}

async function crear({ idNegocio, idCategoria, nombre, descripcion, precio, controlaStock, stockActual, publicoActivo }) {
    const limpio = String(nombre || '').trim();
    if (!limpio) throw error('El nombre del producto es obligatorio.', 422);

    if (idCategoria != null) {
        const cat = await getCategoriaById(idCategoria, idNegocio);
        if (!cat) throw error('La categoría no pertenece a este negocio.', 400);
    }

    return Models.ReservaProducto.create({
        id_negocio: idNegocio,
        id_categoria: idCategoria ?? null,
        nombre: limpio,
        descripcion: String(descripcion || '').trim() || null,
        precio: limpiarPrecio(precio ?? 0),
        controla_stock: !!controlaStock,
        stock_actual: controlaStock ? limpiarPrecio(stockActual ?? 0, 'stock') : 0,
        publico_activo: publicoActivo !== false,
    });
}

async function actualizar(idProducto, idNegocio, data) {
    const prod = await getById(idProducto, idNegocio);
    if (!prod) throw error('Producto no encontrado.', 404);

    const cambios = { fecha_actualizacion: new Date() };
    if (data.nombre !== undefined) {
        const limpio = String(data.nombre).trim();
        if (!limpio) throw error('El nombre del producto es obligatorio.', 422);
        cambios.nombre = limpio;
    }
    if (data.descripcion !== undefined) cambios.descripcion = String(data.descripcion || '').trim() || null;
    if (data.precio !== undefined) cambios.precio = limpiarPrecio(data.precio);
    if (data.idCategoria !== undefined) {
        if (data.idCategoria != null) {
            const cat = await getCategoriaById(data.idCategoria, idNegocio);
            if (!cat) throw error('La categoría no pertenece a este negocio.', 400);
        }
        cambios.id_categoria = data.idCategoria;
    }
    if (data.controlaStock !== undefined) cambios.controla_stock = !!data.controlaStock;
    if (data.stockActual !== undefined) cambios.stock_actual = limpiarPrecio(data.stockActual, 'stock');
    if (data.publicoActivo !== undefined) cambios.publico_activo = !!data.publicoActivo;

    return prod.update(cambios);
}

async function inactivar(idProducto, idNegocio) {
    const prod = await getById(idProducto, idNegocio);
    if (!prod) throw error('Producto no encontrado.', 404);
    return prod.update({ estado: 'I', fecha_actualizacion: new Date() });
}

async function guardarImagen({ idProducto, idNegocio, buffer, mimetype }) {
    const prod = await getById(idProducto, idNegocio);
    if (!prod) throw error('Producto no encontrado.', 404);
    const { url } = ImagenService.guardar({ tipo: 'producto', idNegocio, idEntidad: idProducto, buffer, mimetype });
    await prod.update({ imagen_url: url, fecha_actualizacion: new Date() });
    return { imagen_url: url };
}

async function eliminarImagen(idProducto, idNegocio) {
    const prod = await getById(idProducto, idNegocio);
    if (!prod) throw error('Producto no encontrado.', 404);
    ImagenService.eliminar({ tipo: 'producto', idNegocio, idEntidad: idProducto });
    await prod.update({ imagen_url: null, fecha_actualizacion: new Date() });
    return true;
}

module.exports = {
    listarCategorias, getCategoriaById, crearCategoria, actualizarCategoria, inactivarCategoria,
    listar, listarPublico, getById, crear, actualizar, inactivar, guardarImagen, eliminarImagen,
};
