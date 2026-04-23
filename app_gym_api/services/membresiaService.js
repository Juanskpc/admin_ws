'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

/**
 * Suma N meses a una fecha, manejando overflow de día (ej: 31 enero + 1 mes = 28/29 feb).
 */
function addMonths(date, months) {
    const d = new Date(date);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return d;
}

function toDateOnly(d) {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/**
 * Lista membresías filtrando por miembro o por estado.
 */
async function listar({ idNegocio, idMiembro, estado, page = 1, pageSize = 50 }) {
    const where = { id_negocio: idNegocio };
    if (idMiembro) where.id_miembro = idMiembro;
    if (estado)    where.estado = estado;
    const offset = (page - 1) * pageSize;
    const { rows, count } = await Models.GymMembresia.findAndCountAll({
        where, offset, limit: pageSize, order: [['fecha_creacion', 'DESC']],
        include: [
            { model: Models.GymPlan,    as: 'plan',    attributes: ['id_plan', 'nombre', 'duracion_meses'] },
            { model: Models.GymMiembro, as: 'miembro', attributes: ['id_miembro', 'primer_nombre', 'primer_apellido', 'codigo_qr'] },
        ],
    });
    return { rows, total: count, page, page_size: pageSize };
}

async function getActivaDeMiembro(idMiembro, idNegocio) {
    return Models.GymMembresia.findOne({
        where: { id_miembro: idMiembro, id_negocio: idNegocio, estado: 'ACTIVA' },
        order: [['fecha_fin', 'DESC']],
        include: [{ model: Models.GymPlan, as: 'plan' }],
    });
}

/**
 * Crea una membresía nueva o renueva una existente.
 *
 * Reglas:
 *  - Si el miembro tiene una ACTIVA con fecha_fin >= hoy: extiende fecha_fin sumando duracion_meses.
 *  - Si la activa está vencida o no hay activa: crea una nueva con fecha_inicio=hoy.
 *
 * Devuelve la membresía resultante (ya incluye plan).
 */
async function asignarOrenovar({ idMiembro, idPlan, idNegocio, transaction }) {
    const t = transaction || await Models.sequelize.transaction();
    const ownT = !transaction;
    try {
        const plan = await Models.GymPlan.findOne({
            where: { id_plan: idPlan, id_negocio: idNegocio, estado: 'A' },
            transaction: t,
        });
        if (!plan) {
            const e = new Error('Plan no encontrado o inactivo'); e.statusCode = 404; throw e;
        }

        const miembro = await Models.GymMiembro.findOne({
            where: { id_miembro: idMiembro, id_negocio: idNegocio },
            transaction: t, lock: t.LOCK.UPDATE,
        });
        if (!miembro) {
            const e = new Error('Miembro no encontrado'); e.statusCode = 404; throw e;
        }

        const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
        const activa = await Models.GymMembresia.findOne({
            where: { id_miembro: idMiembro, id_negocio: idNegocio, estado: 'ACTIVA' },
            transaction: t, lock: t.LOCK.UPDATE,
            order: [['fecha_fin', 'DESC']],
        });

        let resultado;
        if (activa && new Date(activa.fecha_fin) >= hoy) {
            // Renovación: extiende fecha_fin
            const nuevoFin = addMonths(new Date(activa.fecha_fin), plan.duracion_meses);
            await activa.update({
                fecha_fin: toDateOnly(nuevoFin),
                id_plan: plan.id_plan,
                precio_pagado: Number(activa.precio_pagado) + Number(plan.precio),
            }, { transaction: t });
            resultado = activa;
        } else {
            // Si había una vencida, marcarla como VENCIDA
            if (activa) {
                await activa.update({ estado: 'VENCIDA' }, { transaction: t });
            }
            const fechaInicio = hoy;
            const fechaFin = addMonths(fechaInicio, plan.duracion_meses);
            resultado = await Models.GymMembresia.create({
                id_miembro:    idMiembro,
                id_plan:       plan.id_plan,
                id_negocio:    idNegocio,
                fecha_inicio:  toDateOnly(fechaInicio),
                fecha_fin:     toDateOnly(fechaFin),
                precio_pagado: plan.precio,
                estado:        'ACTIVA',
            }, { transaction: t });
        }

        // Asegurar que el miembro queda en estado ACTIVO al renovar
        if (miembro.estado !== 'ACTIVO') {
            await miembro.update({ estado: 'ACTIVO', fecha_actualizacion: new Date() }, { transaction: t });
        }

        if (ownT) await t.commit();
        return Models.GymMembresia.findByPk(resultado.id_membresia, {
            include: [{ model: Models.GymPlan, as: 'plan' }],
        });
    } catch (err) {
        if (ownT) await t.rollback();
        throw err;
    }
}

async function pausar({ idMembresia, idNegocio, hasta }) {
    const m = await Models.GymMembresia.findOne({
        where: { id_membresia: idMembresia, id_negocio: idNegocio, estado: 'ACTIVA' },
    });
    if (!m) return null;
    return m.update({
        estado: 'PAUSADA',
        pausada_desde: toDateOnly(new Date()),
        pausada_hasta: hasta ? toDateOnly(new Date(hasta)) : null,
    });
}

async function reanudar({ idMembresia, idNegocio }) {
    const m = await Models.GymMembresia.findOne({
        where: { id_membresia: idMembresia, id_negocio: idNegocio, estado: 'PAUSADA' },
    });
    if (!m) return null;
    // Sumar días pausados a fecha_fin
    const desde = new Date(m.pausada_desde);
    const ahora = new Date();
    const diasPausados = Math.max(0, Math.floor((ahora - desde) / (1000 * 60 * 60 * 24)));
    const nuevaFin = new Date(m.fecha_fin);
    nuevaFin.setDate(nuevaFin.getDate() + diasPausados);
    return m.update({
        estado: 'ACTIVA',
        pausada_desde: null,
        pausada_hasta: null,
        fecha_fin: toDateOnly(nuevaFin),
    });
}

async function cancelar({ idMembresia, idNegocio }) {
    const m = await Models.GymMembresia.findOne({
        where: { id_membresia: idMembresia, id_negocio: idNegocio },
    });
    if (!m) return null;
    return m.update({ estado: 'CANCELADA' });
}

/**
 * Marca como VENCIDA todas las membresías ACTIVA cuyo fecha_fin < hoy.
 * Útil para invocar desde un cron diario (no implementado en fase 1).
 */
async function marcarVencidas(idNegocio) {
    const hoy = toDateOnly(new Date());
    const [, count] = await Models.GymMembresia.update(
        { estado: 'VENCIDA' },
        { where: { id_negocio: idNegocio, estado: 'ACTIVA', fecha_fin: { [Op.lt]: hoy } } },
    );
    return count;
}

module.exports = { listar, getActivaDeMiembro, asignarOrenovar, pausar, reanudar, cancelar, marcarVencidas };
