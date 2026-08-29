'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

/**
 * Lista profesionales del negocio **con los servicios que cada uno ofrece**.
 *
 * Antes los `servicios` solo se incluían cuando se pasaba `idServicio`, y entonces el include
 * hacía dos trabajos a la vez: filtrar la lista de profesionales y, de paso, ser la única vía
 * por la que ese campo llegaba al cliente. Sin filtro, la respuesta no traía `servicios`.
 *
 * Eso rompía el formulario de cita, que decide qué servicios ofrecer con esta regla —la misma
 * que aplica `citaService` al crear—: *sin asignaciones, el profesional puede hacer todo; con
 * asignaciones, solo ésas*. Como el campo llegaba `undefined`, el formulario leía «sin
 * asignaciones» para todo el mundo y ofrecía el catálogo entero; al guardar, el backend sí
 * miraba la tabla real y respondía «El profesional no ofrece alguno de los servicios
 * solicitados». El usuario elegía algo que la interfaz le había ofrecido.
 *
 * Ahora el include siempre trae la lista completa, y el filtro por servicio se resuelve antes,
 * acotando los ids de profesional. Así una cosa no depende de la otra.
 */
async function listar({ idNegocio, idServicio = null, soloActivos = true }) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';

    if (idServicio) {
        const asignaciones = await Models.ReservaProfesionalServicio.findAll({
            where: { id_servicio: idServicio },
            attributes: ['id_profesional'],
        });
        where.id_profesional = { [Op.in]: asignaciones.map(a => a.id_profesional) };
    }

    return Models.ReservaProfesional.findAll({
        where,
        include: [{
            model: Models.ReservaServicio, as: 'servicios',
            attributes: ['id_servicio', 'nombre', 'duracion_min', 'precio'],
            through: { attributes: [] },
            required: false,   // un profesional sin asignaciones debe seguir apareciendo
        }],
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

/**
 * Nombre y especialidad se guardan en mayúsculas, igual que en el alta desde Usuarios.
 *
 * El nombre de un profesional puede llegar por dos caminos —creado con su usuario, o editado
 * aquí— y si solo uno normalizara, la misma persona acabaría escrita de dos formas según por
 * dónde se tocara por última vez. El email no se toca: se guarda tal cual para poder escribirle.
 */
function normalizarTexto(data) {
    const salida = { ...data };
    for (const campo of ['nombre', 'especialidad']) {
        if (typeof salida[campo] === 'string') salida[campo] = salida[campo].trim().toUpperCase();
    }
    return salida;
}

async function crear(data) {
    return Models.ReservaProfesional.create(normalizarTexto(data));
}

async function actualizar(idProfesional, idNegocio, data) {
    const p = await Models.ReservaProfesional.findOne({ where: { id_profesional: idProfesional, id_negocio: idNegocio } });
    if (!p) return null;
    const limpio = normalizarTexto(data);
    delete limpio.id_profesional; delete limpio.id_negocio; delete limpio.fecha_creacion;
    limpio.fecha_actualizacion = new Date();
    return p.update(limpio);
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
