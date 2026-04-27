'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

async function listar({ idNegocio, q, soloActivos = true }) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    if (q && q.trim()) {
        const term = `%${q.trim()}%`;
        where[Op.or] = [
            { nombre:   { [Op.iLike]: term } },
            { num_doc:  { [Op.iLike]: term } },
            { email:    { [Op.iLike]: term } },
            { telefono: { [Op.iLike]: term } },
        ];
    }
    return Models.TiendaCliente.findAll({ where, order: [['nombre', 'ASC']] });
}

async function getById(idCliente, idNegocio) {
    return Models.TiendaCliente.findOne({ where: { id_cliente: idCliente, id_negocio: idNegocio } });
}

async function crear(data) {
    return Models.TiendaCliente.create(data);
}

async function actualizar(idCliente, idNegocio, data) {
    const c = await Models.TiendaCliente.findOne({ where: { id_cliente: idCliente, id_negocio: idNegocio } });
    if (!c) return null;
    delete data.id_cliente; delete data.id_negocio; delete data.fecha_creacion;
    data.fecha_actualizacion = new Date();
    return c.update(data);
}

module.exports = { listar, getById, crear, actualizar };
