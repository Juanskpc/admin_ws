'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

/**
 * Lista asistencias por rango de fechas; default = hoy.
 */
async function listar({ idNegocio, idMiembro, desde, hasta, page = 1, pageSize = 50 }) {
    const where = { id_negocio: idNegocio };
    if (idMiembro) where.id_miembro = idMiembro;

    const inicioHoy = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
    const finHoy    = (() => { const d = new Date(inicioHoy); d.setDate(d.getDate() + 1); return d; })();

    const desdeDt = desde ? new Date(desde) : inicioHoy;
    const hastaDt = hasta ? (() => { const d = new Date(hasta); d.setDate(d.getDate() + 1); return d; })() : finHoy;
    where.fecha_entrada = { [Op.gte]: desdeDt, [Op.lt]: hastaDt };

    const offset = (page - 1) * pageSize;
    const { rows, count } = await Models.GymAsistencia.findAndCountAll({
        where, offset, limit: pageSize, order: [['fecha_entrada', 'DESC']],
        include: [{
            model: Models.GymMiembro, as: 'miembro',
            attributes: ['id_miembro', 'primer_nombre', 'primer_apellido', 'codigo_qr', 'foto_url', 'estado'],
        }],
    });
    return { rows, total: count, page, page_size: pageSize };
}

/**
 * Registra ENTRADA. Si el miembro ya tiene una asistencia abierta, devuelve esa.
 * Bloquea si la membresía está vencida o el miembro está SUSPENDIDO/INACTIVO.
 */
async function registrarEntrada({ idNegocio, idMiembro, metodo = 'MANUAL' }) {
    const t = await Models.sequelize.transaction();
    try {
        const miembro = await Models.GymMiembro.findOne({
            where: { id_miembro: idMiembro, id_negocio: idNegocio },
            include: [{
                model: Models.GymMembresia, as: 'membresias',
                where: { estado: 'ACTIVA' }, required: false,
                attributes: ['id_membresia', 'fecha_fin'],
                limit: 1, order: [['fecha_fin', 'DESC']],
            }],
            transaction: t,
        });
        if (!miembro) { await t.rollback(); const e = new Error('Miembro no encontrado'); e.statusCode = 404; throw e; }

        if (miembro.estado === 'INACTIVO' || miembro.estado === 'SUSPENDIDO') {
            await t.rollback();
            const e = new Error(`El miembro está ${miembro.estado.toLowerCase()}.`);
            e.statusCode = 403; e.code = 'MIEMBRO_BLOQUEADO'; throw e;
        }

        const activa = miembro.membresias?.[0];
        const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
        if (!activa || new Date(activa.fecha_fin) < hoy) {
            await t.rollback();
            const e = new Error('El miembro no tiene una membresía vigente.');
            e.statusCode = 402; e.code = 'MEMBRESIA_VENCIDA'; throw e;
        }

        const abierta = await Models.GymAsistencia.findOne({
            where: { id_miembro: idMiembro, fecha_salida: null },
            transaction: t, lock: t.LOCK.UPDATE,
        });
        if (abierta) {
            await t.commit();
            return { asistencia: abierta, ya_estaba_dentro: true };
        }

        const a = await Models.GymAsistencia.create({
            id_miembro: idMiembro, id_negocio: idNegocio, metodo,
        }, { transaction: t });
        await t.commit();
        return { asistencia: a, ya_estaba_dentro: false };
    } catch (err) {
        if (!t.finished) { try { await t.rollback(); } catch { /* */ } }
        throw err;
    }
}

/** Cierra la asistencia abierta (o por id). */
async function registrarSalida({ idAsistencia, idMiembro, idNegocio }) {
    const where = idAsistencia
        ? { id_asistencia: idAsistencia, id_negocio: idNegocio, fecha_salida: null }
        : { id_miembro: idMiembro, id_negocio: idNegocio, fecha_salida: null };
    const a = await Models.GymAsistencia.findOne({ where });
    if (!a) return null;
    return a.update({ fecha_salida: new Date() });
}

module.exports = { listar, registrarEntrada, registrarSalida };
