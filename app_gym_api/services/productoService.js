'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

async function listar({ idNegocio, q, categoria, page = 1, pageSize = 50, soloActivos = true }) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    if (categoria) where.categoria = categoria;
    if (q && q.trim()) {
        const term = `%${q.trim()}%`;
        where[Op.or] = [
            { nombre: { [Op.iLike]: term } },
            { sku:    { [Op.iLike]: term } },
            { categoria: { [Op.iLike]: term } },
        ];
    }
    const offset = (page - 1) * pageSize;
    const { rows, count } = await Models.GymProducto.findAndCountAll({
        where, offset, limit: pageSize,
        order: [['nombre', 'ASC']],
    });
    return { rows, total: count, page, page_size: pageSize };
}

async function getById(idProducto, idNegocio) {
    return Models.GymProducto.findOne({ where: { id_producto: idProducto, id_negocio: idNegocio } });
}

async function crear(data) {
    return Models.GymProducto.create(data);
}

async function actualizar(idProducto, idNegocio, data) {
    const p = await Models.GymProducto.findOne({ where: { id_producto: idProducto, id_negocio: idNegocio } });
    if (!p) return null;
    delete data.id_producto; delete data.id_negocio; delete data.fecha_creacion;
    data.fecha_actualizacion = new Date();
    return p.update(data);
}

async function inactivar(idProducto, idNegocio) {
    const p = await Models.GymProducto.findOne({ where: { id_producto: idProducto, id_negocio: idNegocio } });
    if (!p) return null;
    return p.update({ estado: 'I', fecha_actualizacion: new Date() });
}

/** Ajuste manual de stock (entrada/salida sin venta). */
async function ajustarStock({ idProducto, idNegocio, delta }) {
    const p = await Models.GymProducto.findOne({ where: { id_producto: idProducto, id_negocio: idNegocio } });
    if (!p) return null;
    const nuevo = Number(p.stock_actual) + Number(delta);
    if (nuevo < 0) {
        const e = new Error('Stock no puede quedar negativo'); e.statusCode = 422; throw e;
    }
    return p.update({ stock_actual: nuevo, fecha_actualizacion: new Date() });
}

module.exports = { listar, getById, crear, actualizar, inactivar, ajustarStock };
