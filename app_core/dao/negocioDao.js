const Models = require('../models/conection');

/**
 * Obtiene la lista de negocios activos.
 * @returns {Array} Lista de negocios
 */
function getListaNegocios() {
    return Models.GenerNegocio.findAll({
        where: { estado: 'A' },
        attributes: ['id_negocio', 'nombre', 'nit', 'email_contacto', 'telefono', 'fecha_registro']
    });
}

/**
 * Obtiene un negocio por su ID.
 * @param {number} idNegocio
 * @returns {Object|null}
 */
function getNegocioById(idNegocio) {
    return Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio, estado: 'A' }
    });
}

/**
 * Crea un nuevo negocio.
 * @param {Object} negocio Datos del negocio
 * @param {Object} t Transacción (opcional)
 */
function createNegocio(negocio, t) {
    const options = t ? { transaction: t } : {};
    return Models.GenerNegocio.create(negocio, options);
}

module.exports = { getListaNegocios, getNegocioById, createNegocio };