'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

async function listar({ idNegocio, q, id_categoria, id_proveedor, soloActivos = true, stockBajo = false, page = 1, pageSize = 50 }) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    if (id_categoria) where.id_categoria = id_categoria;
    if (id_proveedor) where.id_proveedor = id_proveedor;
    if (stockBajo) {
        where.es_servicio = false;
        where.stock_actual = { [Op.lte]: Models.sequelize.col('stock_minimo') };
    }
    if (q && q.trim()) {
        const term = `%${q.trim()}%`;
        where[Op.or] = [
            { nombre:         { [Op.iLike]: term } },
            { sku:            { [Op.iLike]: term } },
            { codigo_barras:  { [Op.iLike]: term } },
            { descripcion:    { [Op.iLike]: term } },
        ];
    }
    const offset = (page - 1) * pageSize;
    const { rows, count } = await Models.TiendaProducto.findAndCountAll({
        where, offset, limit: pageSize,
        order: [['nombre', 'ASC']],
        include: [
            { model: Models.TiendaCategoria, as: 'categoria', attributes: ['id_categoria', 'nombre'], required: false },
            { model: Models.TiendaProveedor, as: 'proveedor', attributes: ['id_proveedor', 'nombre'], required: false },
        ],
    });
    return { rows, total: count, page, page_size: pageSize };
}

async function getById(idProducto, idNegocio) {
    return Models.TiendaProducto.findOne({
        where: { id_producto: idProducto, id_negocio: idNegocio },
        include: [
            { model: Models.TiendaCategoria, as: 'categoria', attributes: ['id_categoria', 'nombre'], required: false },
            { model: Models.TiendaProveedor, as: 'proveedor', attributes: ['id_proveedor', 'nombre'], required: false },
        ],
    });
}

async function crear(data) {
    return Models.TiendaProducto.create(data);
}

async function actualizar(idProducto, idNegocio, data) {
    const p = await Models.TiendaProducto.findOne({ where: { id_producto: idProducto, id_negocio: idNegocio } });
    if (!p) return null;
    delete data.id_producto; delete data.id_negocio; delete data.fecha_creacion;
    data.fecha_actualizacion = new Date();
    return p.update(data);
}

async function inactivar(idProducto, idNegocio) {
    const p = await Models.TiendaProducto.findOne({ where: { id_producto: idProducto, id_negocio: idNegocio } });
    if (!p) return null;
    return p.update({ estado: 'I', fecha_actualizacion: new Date() });
}

/**
 * Ajuste directo de stock sin crear movimiento formal.
 * @param {object} params
 * @param {number} params.idProducto
 * @param {number} params.idNegocio
 * @param {number} params.delta - Valor positivo o negativo a sumar al stock actual
 */
async function ajustarStock({ idProducto, idNegocio, delta }) {
    const p = await Models.TiendaProducto.findOne({ where: { id_producto: idProducto, id_negocio: idNegocio } });
    if (!p) return null;
    const nuevo = Number(p.stock_actual) + Number(delta);
    if (nuevo < 0) {
        const e = new Error('Stock no puede quedar negativo'); e.statusCode = 422; throw e;
    }
    return p.update({ stock_actual: nuevo, fecha_actualizacion: new Date() });
}

module.exports = { listar, getById, crear, actualizar, inactivar, ajustarStock };
