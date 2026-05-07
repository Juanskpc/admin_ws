'use strict';
const Models = require('../../app_core/models/conection');

async function listar({ idNegocio, idServicio = null, soloActivos = true }) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    const include = [];
    if (idServicio) {
        include.push({
            model: Models.ReservaServicio, as: 'servicios',
            where: { id_servicio: idServicio, estado: 'A' },
            attributes: ['id_servicio'],
            through: { attributes: [] },
            required: true,
        });
    }
    return Models.ReservaProfesional.findAll({
        where, include,
        order: [['nombre', 'ASC']],
    });
}

async function getById(idProfesional, idNegocio) {
    return Models.ReservaProfesional.findOne({
        where: { id_profesional: idProfesional, id_negocio: idNegocio },
        include: [{
            model: Models.ReservaServicio, as: 'servicios',
            attributes: ['id_servicio', 'nombre'],
            through: { attributes: [] },
        }],
    });
}

async function crear(data) {
    return Models.ReservaProfesional.create(data);
}

async function actualizar(idProfesional, idNegocio, data) {
    const p = await Models.ReservaProfesional.findOne({ where: { id_profesional: idProfesional, id_negocio: idNegocio } });
    if (!p) return null;
    delete data.id_profesional; delete data.id_negocio; delete data.fecha_creacion;
    data.fecha_actualizacion = new Date();
    return p.update(data);
}

async function inactivar(idProfesional, idNegocio) {
    const p = await Models.ReservaProfesional.findOne({ where: { id_profesional: idProfesional, id_negocio: idNegocio } });
    if (!p) return null;
    return p.update({ estado: 'I', fecha_actualizacion: new Date() });
}

async function setServicios(idProfesional, idNegocio, idServicios = []) {
    const p = await Models.ReservaProfesional.findOne({ where: { id_profesional: idProfesional, id_negocio: idNegocio } });
    if (!p) return null;
    const t = await Models.sequelize.transaction();
    try {
        await Models.ReservaProfesionalServicio.destroy({ where: { id_profesional: idProfesional }, transaction: t });
        if (idServicios.length) {
            // Validar que los servicios pertenezcan al mismo negocio
            const servicios = await Models.ReservaServicio.findAll({
                where: { id_servicio: idServicios, id_negocio: idNegocio },
                attributes: ['id_servicio'],
                transaction: t,
            });
            if (servicios.length !== idServicios.length) {
                const e = new Error('Algún servicio no pertenece al negocio'); e.statusCode = 400; throw e;
            }
            await Models.ReservaProfesionalServicio.bulkCreate(
                idServicios.map(id_servicio => ({ id_profesional: idProfesional, id_servicio })),
                { transaction: t },
            );
        }
        await t.commit();
    } catch (err) {
        await t.rollback(); throw err;
    }
    return getById(idProfesional, idNegocio);
}

module.exports = { listar, getById, crear, actualizar, inactivar, setServicios };
