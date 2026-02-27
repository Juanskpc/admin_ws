const Models = require('../models/conection');

/**
 * Obtiene todos los tipos de negocio activos.
 * @returns {Array} Lista de tipos de negocio
 */
function getListaTiposNegocio() {
    return Models.GenerTipoNegocio.findAll({
        where: { estado: 'A' },
        attributes: ['id_tipo_negocio', 'nombre', 'descripcion', 'estado', 'fecha_creacion', 'fecha_actualizacion'],
        order: [['nombre', 'ASC']]
    });
}

/**
 * Obtiene un tipo de negocio por su ID.
 * @param {number} idTipoNegocio
 * @returns {Object|null}
 */
function getTipoNegocioById(idTipoNegocio) {
    return Models.GenerTipoNegocio.findOne({
        where: { id_tipo_negocio: idTipoNegocio },
        attributes: ['id_tipo_negocio', 'nombre', 'descripcion', 'estado', 'fecha_creacion', 'fecha_actualizacion']
    });
}

module.exports = { getListaTiposNegocio, getTipoNegocioById };
