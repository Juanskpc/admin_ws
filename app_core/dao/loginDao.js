const Models = require('../models/conection');

/**
 * Obtiene la contraseña hasheada del usuario por número de identificación.
 * Se usa para verificar credenciales en el login.
 * @param {string} numIdentificacion
 * @returns {Object|null} Usuario con id y password, o null si no existe
 */
function getPwUsuario(numIdentificacion) {
    return Models.GenerUsuario.findOne({
        where: {
            num_identificacion: numIdentificacion,
            estado: 'A'
        },
        attributes: ['id_usuario', 'password']
    });
}

/**
 * Obtiene la información completa del usuario para la respuesta de login.
 * Incluye negocios asociados y roles por negocio.
 * @param {number} idUsuario
 * @returns {Object} Usuario con negocios y roles agrupados
 */
async function getUsuarioLogin(idUsuario) {
    const usuario = await Models.GenerUsuario.findOne({
        where: { id_usuario: idUsuario, estado: 'A' },
        attributes: [
            'id_usuario', 'primer_nombre', 'segundo_nombre',
            'primer_apellido', 'segundo_apellido', 'email', 'num_identificacion'
        ]
    });

    if (!usuario) return null;

    // Obtener negocios del usuario
    const negociosUsuario = await Models.GenerNegocioUsuario.findAll({
        where: { id_usuario: idUsuario, estado: 'A' },
        include: [{
            model: Models.GenerNegocio,
            as: 'negocio',
            attributes: ['id_negocio', 'nombre'],
            where: { estado: 'A' },
            required: true
        }]
    });

    // Obtener roles del usuario
    const rolesUsuario = await Models.GenerUsuarioRol.findAll({
        where: { id_usuario: idUsuario, estado: 'A' },
        include: [{
            model: Models.GenerRol,
            as: 'rol',
            attributes: ['id_rol', 'descripcion']
        }]
    });

    // Agrupar negocios con sus roles correspondientes
    const negocios = negociosUsuario.map(nu => {
        const negocio = nu.negocio;
        const roles = rolesUsuario
            .filter(r => r.id_negocio === negocio.id_negocio)
            .map(r => ({ id_rol: r.rol.id_rol, descripcion: r.rol.descripcion }));

        return {
            id_negocio: negocio.id_negocio,
            nombre: negocio.nombre,
            roles
        };
    });

    // Roles globales (sin negocio asociado, ej: Super Admin)
    const rolesGlobales = rolesUsuario
        .filter(r => r.id_negocio === null)
        .map(r => ({ id_rol: r.rol.id_rol, descripcion: r.rol.descripcion }));

    return {
        id_usuario: usuario.id_usuario,
        primer_nombre: usuario.primer_nombre,
        segundo_nombre: usuario.segundo_nombre,
        primer_apellido: usuario.primer_apellido,
        segundo_apellido: usuario.segundo_apellido,
        email: usuario.email,
        negocios,
        roles_globales: rolesGlobales
    };
}

module.exports = { getPwUsuario, getUsuarioLogin };