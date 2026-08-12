'use strict';
const Models = require('../../app_core/models/conection');
const EstadoCita = require('./estadoCita');
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

/**
 * Cambia el estado de una cita respetando la máquina de estados.
 *
 * Devuelve `null` si la cita no existe (el controlador lo traduce a 404) y **lanza** un
 * error tipado si la transición no es válida. La diferencia es deliberada: «no existe» es
 * una respuesta, «no se puede» es un rechazo del dominio y merece decir por qué.
 *
 * Se relee el estado dentro de la transacción y se escribe con la condición del estado
 * origen: dos peticiones simultáneas sobre la misma cita no pueden ganar las dos.
 */
async function cambiarEstado(idCita, idNegocio, nuevoEstado, extra = {}) {
    return Models.sequelize.transaction(async (t) => {
        const cita = await Models.ReservaCita.findOne({
            where: { id_cita: idCita, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!cita) return null;

        EstadoCita.exigirTransicion(cita.estado, nuevoEstado);

        return cita.update(
            { estado: nuevoEstado, ...extra, fecha_actualizacion: new Date() },
            { transaction: t }
        );
    });
}

module.exports = { listar, getById, cambiarEstado };
