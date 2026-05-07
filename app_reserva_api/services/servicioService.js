'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

async function listar({ idNegocio, soloActivos = true }) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    return Models.ReservaServicio.findAll({ where, order: [['nombre', 'ASC']] });
}

async function getById(idServicio, idNegocio) {
    return Models.ReservaServicio.findOne({ where: { id_servicio: idServicio, id_negocio: idNegocio } });
}

async function crear(data) {
    return Models.ReservaServicio.create(data);
}

async function actualizar(idServicio, idNegocio, data) {
    const s = await Models.ReservaServicio.findOne({ where: { id_servicio: idServicio, id_negocio: idNegocio } });
    if (!s) return null;
    delete data.id_servicio; delete data.id_negocio; delete data.fecha_creacion;
    data.fecha_actualizacion = new Date();
    return s.update(data);
}

async function inactivar(idServicio, idNegocio) {
    const s = await Models.ReservaServicio.findOne({ where: { id_servicio: idServicio, id_negocio: idNegocio } });
    if (!s) return null;
    return s.update({ estado: 'I', fecha_actualizacion: new Date() });
}

module.exports = { listar, getById, crear, actualizar, inactivar };
