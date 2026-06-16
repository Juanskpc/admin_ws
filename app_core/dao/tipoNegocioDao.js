const Models = require('../models/conection');

const TIPO_ATTRS = [
    'id_tipo_negocio', 'nombre', 'descripcion',
    'icono', 'color_hex', 'estado',
    'fecha_creacion', 'fecha_actualizacion',
];

/**
 * Obtiene todos los tipos de negocio activos.
 * @returns {Array} Lista de tipos de negocio
 */
function getListaTiposNegocio() {
    return Models.GenerTipoNegocio.findAll({
        where: { estado: 'A' },
        attributes: TIPO_ATTRS,
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
        attributes: TIPO_ATTRS
    });
}

/**
 * Crea un nuevo tipo de negocio.
 * @param {Object} data { nombre, descripcion, icono, color_hex }
 * @returns {Object} El tipo de negocio creado
 */
function createTipoNegocio(data) {
    return Models.GenerTipoNegocio.create({
        nombre: data.nombre,
        descripcion: data.descripcion ?? null,
        icono: data.icono ?? null,
        color_hex: data.color_hex ?? null,
        estado: 'A',
    });
}

module.exports = { getListaTiposNegocio, getTipoNegocioById, createTipoNegocio };
