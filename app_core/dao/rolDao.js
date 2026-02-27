const Models = require('../models/conection');

/**
 * Obtiene la lista de roles, opcionalmente filtrados por tipo de negocio.
 * Incluye la relación con el tipo de negocio.
 * @param {number|null} idTipoNegocio - Filtro opcional por tipo de negocio
 * @returns {Array} Lista de roles
 */
function getListaRoles(idTipoNegocio = null) {
    const where = { estado: 'A' };
    if (idTipoNegocio) {
        where.id_tipo_negocio = idTipoNegocio;
    }

    return Models.GenerRol.findAll({
        where,
        attributes: ['id_rol', 'descripcion', 'id_tipo_negocio', 'estado', 'fecha_creacion'],
        include: [
            {
                model: Models.GenerTipoNegocio,
                as: 'tipoNegocio',
                attributes: ['id_tipo_negocio', 'nombre']
            }
        ],
        order: [['id_tipo_negocio', 'ASC NULLS FIRST'], ['descripcion', 'ASC']]
    });
}

/**
 * Obtiene un rol por su ID con sus permisos de nivel.
 * @param {number} idRol
 * @returns {Object|null}
 */
function getRolById(idRol) {
    return Models.GenerRol.findOne({
        where: { id_rol: idRol },
        include: [
            {
                model: Models.GenerTipoNegocio,
                as: 'tipoNegocio',
                attributes: ['id_tipo_negocio', 'nombre']
            },
            {
                model: Models.GenerRolNivel,
                as: 'permisos',
                where: { estado: 'A' },
                required: false,
                attributes: ['id_rol_nivel', 'id_nivel', 'puede_ver', 'puede_crear', 'puede_editar', 'puede_eliminar'],
                include: [
                    {
                        model: Models.GenerNivel,
                        as: 'nivel',
                        attributes: ['id_nivel', 'descripcion', 'url', 'icono']
                    }
                ]
            }
        ]
    });
}

/**
 * Crea un nuevo rol.
 * @param {Object} data - { descripcion, id_tipo_negocio }
 * @param {Object} t - Transacción (opcional)
 * @returns {Object} Rol creado
 */
function createRol(data, t) {
    const options = t ? { transaction: t } : {};
    return Models.GenerRol.create(data, options);
}

/**
 * Inactiva un rol (cambia estado a 'I').
 * @param {number} idRol
 * @returns {Array} [affectedCount]
 */
function inactivarRol(idRol) {
    return Models.GenerRol.update(
        { estado: 'I', fecha_actualizacion: new Date() },
        { where: { id_rol: idRol, estado: 'A' } }
    );
}

module.exports = { getListaRoles, getRolById, createRol, inactivarRol };
