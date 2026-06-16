'use strict';
const Models = require('../models/conection');
const { Op } = Models.Sequelize;

/**
 * Verifica si un negocio tiene al menos un plan activo y vigente.
 * Un plan es vigente cuando fecha_inicio <= ahora <= fecha_fin (o fecha_fin es NULL).
 *
 * @param {number} idNegocio
 * @returns {Promise<boolean>}
 */
async function tienePlanActivo(idNegocio) {
    if (!idNegocio) return false;

    const ahora = new Date();
    const plan = await Models.GenerNegocioPlan.findOne({
        where: {
            id_negocio: Number(idNegocio),
            estado: 'A',
            fecha_inicio: { [Op.lte]: ahora },
            [Op.or]: [
                { fecha_fin: null },
                { fecha_fin: { [Op.gte]: ahora } },
            ],
        },
        attributes: ['id_negocio_plan'],
    });

    return plan !== null;
}

/**
 * Para una lista de IDs de negocio, devuelve un Set con los que tienen plan activo.
 *
 * @param {number[]} idNegocios
 * @returns {Promise<Set<number>>}
 */
async function getIdsConPlanActivo(idNegocios) {
    if (!idNegocios || idNegocios.length === 0) return new Set();

    const ahora = new Date();
    const planes = await Models.GenerNegocioPlan.findAll({
        where: {
            id_negocio: { [Op.in]: idNegocios.map(Number) },
            estado: 'A',
            fecha_inicio: { [Op.lte]: ahora },
            [Op.or]: [
                { fecha_fin: null },
                { fecha_fin: { [Op.gte]: ahora } },
            ],
        },
        attributes: ['id_negocio'],
    });

    return new Set(planes.map(p => p.id_negocio));
}

/**
 * Para una lista de IDs de negocio, devuelve un Map id_negocio → info del plan
 * más reciente y activo de ese negocio (o sin entrada si no tiene plan).
 *
 * La forma del plan coincide con la usada por getMisNegociosPlanInfo:
 *   { id_plan, nombre, precio, moneda, fecha_inicio, fecha_fin, vigente, dias_restantes }
 *
 * @param {number[]} idNegocios
 * @returns {Promise<Map<number, object>>}
 */
async function getPlanesActivosPorNegocio(idNegocios) {
    const ids = [...new Set((idNegocios || []).map(Number).filter(Boolean))];
    if (ids.length === 0) return new Map();

    const now = new Date();
    const rows = await Models.GenerNegocioPlan.findAll({
        where: {
            id_negocio: { [Op.in]: ids },
            estado: 'A',
        },
        include: [{ model: Models.GenerPlan }],
        order: [['fecha_inicio', 'DESC']],
    });

    const map = new Map();
    for (const row of rows) {
        // Como vienen ordenados por fecha_inicio DESC, el primero por negocio es el vigente.
        if (map.has(row.id_negocio)) continue;

        const p = row.GenerPlan;
        const inicio = row.fecha_inicio ? new Date(row.fecha_inicio) : null;
        const fin = row.fecha_fin ? new Date(row.fecha_fin) : null;
        const vigente = (!inicio || inicio <= now) && (!fin || fin >= now);
        const diasRestantes = fin ? Math.ceil((fin - now) / 86400000) : null;

        map.set(row.id_negocio, {
            id_plan: p?.id_plan ?? null,
            nombre: p?.nombre ?? 'Sin nombre',
            precio: p ? parseFloat(p.precio) : 0,
            moneda: p?.moneda ?? 'COP',
            fecha_inicio: row.fecha_inicio,
            fecha_fin: row.fecha_fin,
            vigente,
            dias_restantes: diasRestantes,
        });
    }

    return map;
}

module.exports = { tienePlanActivo, getIdsConPlanActivo, getPlanesActivosPorNegocio };
