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

module.exports = { tienePlanActivo, getIdsConPlanActivo };
