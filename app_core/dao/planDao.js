const sequelize = require('./../models/conection');
const Models = sequelize.sequelize;

/**
 * Función para obtener los planes activos a los que se puede ligar un negocio
 * @returns { Array } Lista de planes activos para negocio
 */
function getListaPlanes() {
    return Models.GenerPlan.findAll({
        where: {
            estado: 'A'
        }
    })
}

/**
 * Función para crear nuevo plan
 * @param { Object } plan Datos requeridos para crear un nuevo plan
 */
function createPlan(plan) {
    return Models.GenerPlan.create(plan)
}

/**
 * Función para dar de baja un plan
 * @param {*} idPlan Identificador único del plan
 */
function inactivarPlan(idPlan) {
    return Models.GenerPlan.update({
        estado: 'I'
    }, {
        where: {
            id_plan: idPlan
        }
    })
}

/**
 * Función para actualizar los datos de un plan
 * @param {*} plan Objeto con los datos del plan
 */
function updatePlan(plan) {
    return Models.GenerPlan.update({
        plan
    }, {
        where: {
            id_plan: plan.idPlan
        }
    })
}

module.exports.getListaPlanes = getListaPlanes;
module.exports.createPlan = createPlan;
module.exports.inactivarPlan = inactivarPlan;
module.exports.updatePlan = updatePlan;