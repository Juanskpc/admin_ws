const { sequelize } = require('../models/conection');

/**
 * Inicializa y retorna una transacción de Sequelize
 * @returns {Promise<Transaction>} Objeto de transacción
 */
async function initTransaction() {
    return await sequelize.transaction();
}

module.exports = {
    initTransaction
};