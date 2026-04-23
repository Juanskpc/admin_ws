'use strict';
const crypto = require('crypto');
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

function generarCodigoQR() {
    return 'GYM-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

async function listar({ idNegocio, q, estado, page = 1, pageSize = 20 }) {
    const where = { id_negocio: idNegocio };
    if (estado) where.estado = estado;
    if (q && q.trim()) {
        const term = `%${q.trim()}%`;
        where[Op.or] = [
            { primer_nombre:    { [Op.iLike]: term } },
            { segundo_nombre:   { [Op.iLike]: term } },
            { primer_apellido:  { [Op.iLike]: term } },
            { segundo_apellido: { [Op.iLike]: term } },
            { num_identificacion: { [Op.iLike]: term } },
            { email:            { [Op.iLike]: term } },
            { telefono:         { [Op.iLike]: term } },
            { codigo_qr:        { [Op.iLike]: term } },
        ];
    }
    const offset = (page - 1) * pageSize;
    const { rows, count } = await Models.GymMiembro.findAndCountAll({
        where, offset, limit: pageSize,
        order: [['primer_apellido', 'ASC'], ['primer_nombre', 'ASC']],
        include: [{
            model: Models.GymMembresia, as: 'membresias',
            where: { estado: 'ACTIVA' }, required: false,
            attributes: ['id_membresia', 'fecha_fin', 'estado'],
            include: [{ model: Models.GymPlan, as: 'plan', attributes: ['nombre'] }],
            limit: 1, order: [['fecha_fin', 'DESC']],
        }],
    });
    return { rows, total: count, page, page_size: pageSize };
}

async function getById(idMiembro, idNegocio) {
    return Models.GymMiembro.findOne({
        where: { id_miembro: idMiembro, id_negocio: idNegocio },
        include: [{
            model: Models.GymMembresia, as: 'membresias',
            include: [{ model: Models.GymPlan, as: 'plan', attributes: ['id_plan', 'nombre', 'duracion_meses'] }],
            order: [['fecha_creacion', 'DESC']],
        }],
    });
}

async function getByQr(codigoQr, idNegocio) {
    return Models.GymMiembro.findOne({
        where: { codigo_qr: codigoQr, id_negocio: idNegocio },
        include: [{
            model: Models.GymMembresia, as: 'membresias',
            where: { estado: 'ACTIVA' }, required: false,
            include: [{ model: Models.GymPlan, as: 'plan', attributes: ['nombre', 'duracion_meses'] }],
            limit: 1, order: [['fecha_fin', 'DESC']],
        }],
    });
}

async function getByIdentificacion(numIdentificacion, idNegocio) {
    return Models.GymMiembro.findOne({
        where: { num_identificacion: String(numIdentificacion).trim(), id_negocio: idNegocio },
        include: [{
            model: Models.GymMembresia, as: 'membresias',
            where: { estado: 'ACTIVA' }, required: false,
            include: [{ model: Models.GymPlan, as: 'plan', attributes: ['nombre', 'duracion_meses'] }],
            limit: 1, order: [['fecha_fin', 'DESC']],
        }],
    });
}

async function crear(data) {
    const codigo_qr = data.codigo_qr || generarCodigoQR();
    return Models.GymMiembro.create({ ...data, codigo_qr });
}

async function actualizar(idMiembro, idNegocio, data) {
    const m = await Models.GymMiembro.findOne({ where: { id_miembro: idMiembro, id_negocio: idNegocio } });
    if (!m) return null;
    delete data.id_miembro; delete data.id_negocio; delete data.codigo_qr; delete data.fecha_registro;
    data.fecha_actualizacion = new Date();
    return m.update(data);
}

async function cambiarEstado(idMiembro, idNegocio, estado) {
    if (!['ACTIVO','SUSPENDIDO','MOROSO','INACTIVO'].includes(estado)) {
        const e = new Error('Estado inválido'); e.statusCode = 422; throw e;
    }
    const m = await Models.GymMiembro.findOne({ where: { id_miembro: idMiembro, id_negocio: idNegocio } });
    if (!m) return null;
    return m.update({ estado, fecha_actualizacion: new Date() });
}

module.exports = { listar, getById, getByQr, getByIdentificacion, crear, actualizar, cambiarEstado, generarCodigoQR };
