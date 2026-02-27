const Models = require('../models/conection');

/**
 * Obtiene los planes activos.
 * @returns {Array} Lista de planes activos
 */
function getListaPlanes() {
    return Models.GenerPlan.findAll({
        where: { estado: 'A' }
    });
}

/**
 * Crea un nuevo plan.
 * @param {Object} plan Datos del plan
 */
function createPlan(plan) {
    return Models.GenerPlan.create(plan);
}

/**
 * Inactiva un plan (cambio lógico, no se elimina).
 * @param {number} idPlan
 */
function inactivarPlan(idPlan) {
    return Models.GenerPlan.update(
        { estado: 'I' },
        { where: { id_plan: idPlan } }
    );
}

/**
 * Actualiza los datos de un plan.
 * @param {Object} plan Datos actualizados (debe incluir id_plan)
 */
function updatePlan(plan) {
    const { id_plan, ...datosActualizados } = plan;
    return Models.GenerPlan.update(datosActualizados, {
        where: { id_plan }
    });
}

module.exports = { getListaPlanes, createPlan, inactivarPlan, updatePlan };