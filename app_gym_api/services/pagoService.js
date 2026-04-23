'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;
const membresiaService = require('./membresiaService');

/**
 * Lista pagos paginados, filtros opcionales por miembro y rango de fechas.
 */
async function listar({ idNegocio, idMiembro, desde, hasta, page = 1, pageSize = 50 }) {
    const where = { id_negocio: idNegocio };
    if (idMiembro) where.id_miembro = idMiembro;
    if (desde || hasta) {
        where.fecha_pago = {};
        if (desde) where.fecha_pago[Op.gte] = new Date(desde);
        if (hasta) where.fecha_pago[Op.lt]  = (() => { const d = new Date(hasta); d.setDate(d.getDate() + 1); return d; })();
    }
    const offset = (page - 1) * pageSize;
    const { rows, count } = await Models.GymPago.findAndCountAll({
        where, offset, limit: pageSize, order: [['fecha_pago', 'DESC']],
        include: [
            { model: Models.GymMiembro, as: 'miembro', attributes: ['id_miembro', 'primer_nombre', 'primer_apellido', 'codigo_qr'] },
            { model: Models.GymMembresia, as: 'membresia', attributes: ['id_membresia', 'fecha_fin'],
              include: [{ model: Models.GymPlan, as: 'plan', attributes: ['nombre'] }] },
            { model: Models.GenerUsuario, as: 'usuarioCobro', attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'] },
        ],
    });
    return { rows, total: count, page, page_size: pageSize };
}

/**
 * Registra un pago.
 *
 * Modos:
 *  - Si viene id_plan: asigna/renueva una membresía con ese plan y el pago queda atado.
 *  - Si viene id_membresia (sin plan): pago suelto sobre una membresía existente
 *    (no extiende fechas, sólo registra dinero — útil para abonos o multas).
 *  - Si no viene ninguno: pago genérico sin membresía (concepto libre, ej: venta de producto).
 */
async function registrar({ idNegocio, idMiembro, idPlan, idMembresia, monto, metodo, concepto, idUsuarioCobro }) {
    const t = await Models.sequelize.transaction();
    try {
        const miembro = await Models.GymMiembro.findOne({
            where: { id_miembro: idMiembro, id_negocio: idNegocio },
            transaction: t,
        });
        if (!miembro) {
            const e = new Error('Miembro no encontrado'); e.statusCode = 404; throw e;
        }

        let membresia = null;
        if (idPlan) {
            membresia = await membresiaService.asignarOrenovar({
                idMiembro, idPlan, idNegocio, transaction: t,
            });
        } else if (idMembresia) {
            membresia = await Models.GymMembresia.findOne({
                where: { id_membresia: idMembresia, id_negocio: idNegocio },
                transaction: t,
            });
            if (!membresia) {
                const e = new Error('Membresía no encontrada'); e.statusCode = 404; throw e;
            }
        }

        const pago = await Models.GymPago.create({
            id_negocio:       idNegocio,
            id_miembro:       idMiembro,
            id_membresia:     membresia?.id_membresia || null,
            id_usuario_cobro: idUsuarioCobro || null,
            monto,
            metodo,
            concepto: concepto || (membresia?.plan?.nombre ? `Plan ${membresia.plan.nombre}` : null),
            estado: 'PAGADO',
        }, { transaction: t });

        await t.commit();
        return Models.GymPago.findByPk(pago.id_pago, {
            include: [
                { model: Models.GymMiembro, as: 'miembro' },
                { model: Models.GymMembresia, as: 'membresia',
                  include: [{ model: Models.GymPlan, as: 'plan' }] },
            ],
        });
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

async function anular({ idPago, idNegocio }) {
    const p = await Models.GymPago.findOne({ where: { id_pago: idPago, id_negocio: idNegocio } });
    if (!p) return null;
    return p.update({ estado: 'ANULADO' });
}

module.exports = { listar, registrar, anular };
