'use strict';
const Models = require('../../app_core/models/conection');

async function listar(idNegocio, soloActivos = true) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    return Models.GymPlan.findAll({
        where, order: [['duracion_meses', 'ASC'], ['precio', 'ASC']],
    });
}

async function getById(idPlan, idNegocio) {
    return Models.GymPlan.findOne({ where: { id_plan: idPlan, id_negocio: idNegocio } });
}

async function crear(data) {
    return Models.GymPlan.create(data);
}

async function actualizar(idPlan, idNegocio, data) {
    const p = await Models.GymPlan.findOne({ where: { id_plan: idPlan, id_negocio: idNegocio } });
    if (!p) return null;
    delete data.id_plan; delete data.id_negocio;
    return p.update(data);
}

async function inactivar(idPlan, idNegocio) {
    const p = await Models.GymPlan.findOne({ where: { id_plan: idPlan, id_negocio: idNegocio } });
    if (!p) return null;
    return p.update({ estado: 'I' });
}

module.exports = { listar, getById, crear, actualizar, inactivar };
