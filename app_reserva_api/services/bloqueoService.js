'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

async function listar({ idNegocio, idProfesional, desde, hasta }) {
    const where = { id_negocio: idNegocio };
    if (idProfesional !== undefined) where.id_profesional = idProfesional;
    if (desde) where.fecha_fin    = { [Op.gte]: new Date(desde) };
    if (hasta) where.fecha_inicio = { [Op.lte]: new Date(hasta) };
    return Models.ReservaBloqueo.findAll({ where, order: [['fecha_inicio', 'ASC']] });
}

async function crear(data) {
    return Models.ReservaBloqueo.create(data);
}

async function eliminar(idBloqueo, idNegocio) {
    const b = await Models.ReservaBloqueo.findOne({ where: { id_bloqueo: idBloqueo, id_negocio: idNegocio } });
    if (!b) return null;
    await b.destroy();
    return b;
}

module.exports = { listar, crear, eliminar };
