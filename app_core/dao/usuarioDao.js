const Models = require('../models/conection');
const { Op } = require('sequelize');

/**
 * Obtiene información del usuario por ID (sin contraseña).
 * @param {number} idUsuario
 * @returns {Object} Información del usuario
 */
function getInfoUsuario(idUsuario) {
    return Models.GenerUsuario.findOne({
        where: { id_usuario: idUsuario, estado: 'A' },
        attributes: { exclude: ['password'] }
    });
}

/**
 * Verifica si ya existe un usuario con el mismo email o número de identificación.
 * @param {string} email
 * @param {string} numIdentificacion
 * @returns {Object|null} Usuario existente o null
 */
function verificarUsuarioExistente(email, numIdentificacion) {
    return Models.GenerUsuario.findOne({
        where: {
            [Op.or]: [
                { email },
                { num_identificacion: numIdentificacion }
            ]
        },
        attributes: ['id_usuario', 'email', 'num_identificacion']
    });
}

/**
 * Crea un nuevo usuario.
 * La contraseña se hashea automáticamente por el hook del modelo.
 * @param {Object} usuario Datos del usuario
 * @param {Object} t Transacción de Sequelize
 * @returns {number} ID del usuario creado
 */
async function createUsuario(usuario, t) {
    const nuevoUsuario = await Models.GenerUsuario.create(usuario, { transaction: t });
    return nuevoUsuario.id_usuario;
}

/**
 * Liga un usuario a un negocio.
 * @param {Object} usuarioNegocio { id_usuario, id_negocio }
 * @param {Object} t Transacción
 */
function createUsuarioNegocio(usuarioNegocio, t) {
    return Models.GenerNegocioUsuario.create(usuarioNegocio, { transaction: t });
}

/**
 * Asigna un rol a un usuario, opcionalmente dentro de un negocio.
 * @param {Object} usuarioRol { id_usuario, id_rol, id_negocio }
 * @param {Object} t Transacción
 */
function createUsuarioRol(usuarioRol, t) {
    return Models.GenerUsuarioRol.create(usuarioRol, { transaction: t });
}

/**
 * Obtiene la lista de roles activos.
 * @returns {Array} Lista de roles
 */
function getListaRoles() {
    return Models.GenerRol.findAll({
        where: { estado: 'A' },
        attributes: ['id_rol', 'descripcion']
    });
}

module.exports = {
    getInfoUsuario,
    verificarUsuarioExistente,
    createUsuario,
    createUsuarioNegocio,
    createUsuarioRol,
    getListaRoles
};