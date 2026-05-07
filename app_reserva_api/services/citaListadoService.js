'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

async function listar({ idNegocio, desde, hasta, idProfesional, estado, soloPendientesPago = false }) {
    const where = { id_negocio: idNegocio };
    if (desde)          where.fecha_hora_inicio = { ...(where.fecha_hora_inicio || {}), [Op.gte]: new Date(desde) };
    if (hasta)          where.fecha_hora_inicio = { ...(where.fecha_hora_inicio || {}), [Op.lt]: new Date(hasta) };
    if (idProfesional)  where.id_profesional = idProfesional;
    if (estado)         where.estado = estado;
    if (soloPendientesPago) where.pago_estado = 'pendiente_validacion';

    return Models.ReservaCita.findAll({
        where,
        include: [
            { model: Models.ReservaProfesional, as: 'profesional',
              attributes: ['id_profesional', 'nombre', 'color_hex'] },
            { model: Models.ReservaCitaServicio, as: 'servicios',
              include: [{ model: Models.ReservaServicio, as: 'servicio',
                          attributes: ['id_servicio', 'nombre'] }] },
        ],
        order: [['fecha_hora_inicio', 'ASC']],
    });
}

async function getById(idCita, idNegocio) {
    return Models.ReservaCita.findOne({
        where: { id_cita: idCita, id_negocio: idNegocio },
        include: [
            { model: Models.ReservaProfesional, as: 'profesional',
              attributes: ['id_profesional', 'nombre', 'color_hex', 'foto_url', 'especialidad'] },
            { model: Models.ReservaCitaServicio, as: 'servicios',
              include: [{ model: Models.ReservaServicio, as: 'servicio',
                          attributes: ['id_servicio', 'nombre'] }] },
        ],
    });
}

async function cambiarEstado(idCita, idNegocio, nuevoEstado, extra = {}) {
    const cita = await Models.ReservaCita.findOne({ where: { id_cita: idCita, id_negocio: idNegocio } });
    if (!cita) return null;
    return cita.update({ estado: nuevoEstado, ...extra, fecha_actualizacion: new Date() });
}

module.exports = { listar, getById, cambiarEstado };
