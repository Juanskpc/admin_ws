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

/**
 * Obtiene los negocios a los que un usuario tiene acceso, filtrados por tipo de negocio.
 * JOIN con gener_negocio_usuario para verificar membresía.
 * @param {number} idUsuario
 * @param {number} idTipoNegocio
 * @returns {Array}
 */
function getNegociosByUsuarioAndTipo(idUsuario, idTipoNegocio) {
    return Models.GenerNegocio.findAll({
        where: { estado: 'A', id_tipo_negocio: idTipoNegocio },
        include: [{
            model: Models.GenerNegocioUsuario,
            as: 'usuarios',
            where: { id_usuario: idUsuario, estado: 'A' },
            attributes: [],
            required: true,
        }],
        attributes: [
            'id_negocio', 'nombre', 'nit',
            'email_contacto', 'telefono',
            'id_tipo_negocio', 'id_paleta',
            'estado', 'fecha_registro',
        ],
        order: [['nombre', 'ASC']],
    });
}

module.exports = { getListaNegocios, getNegocioById, createNegocio, getNegociosByUsuarioAndTipo };