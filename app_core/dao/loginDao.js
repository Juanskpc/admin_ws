const Models = require('../models/conection');
const { getIdsConPlanActivo } = require('../helpers/planHelper');

/**
 * Obtiene credenciales del usuario por número de identificación.
 * Se usa para verificar credenciales en el login.
 * @param {string} numIdentificacion
 * @returns {Object|null} Usuario con id, password y estado, o null si no existe
 */
function getPwUsuario(numIdentificacion) {
    return Models.GenerUsuario.findOne({
        where: {
            num_identificacion: numIdentificacion,
        },
        attributes: ['id_usuario', 'password', 'estado']
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

    // Verificar qué negocios tienen plan activo
    const idNegocios = negociosUsuario.map(nu => nu.negocio.id_negocio);
    const idsConPlan = await getIdsConPlanActivo(idNegocios);

    // Agrupar negocios con sus roles y estado de plan
    const negocios = negociosUsuario.map(nu => {
        const negocio = nu.negocio;
        const roles = rolesUsuario
            .filter(r => r.id_negocio === negocio.id_negocio)
            .map(r => ({ id_rol: r.rol.id_rol, descripcion: r.rol.descripcion }));

        return {
            id_negocio: negocio.id_negocio,
            nombre: negocio.nombre,
            roles,
            plan_activo: idsConPlan.has(negocio.id_negocio),
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
        num_identificacion: usuario.num_identificacion,
        negocios,
        roles_globales: rolesGlobales
    };
}

module.exports = { getPwUsuario, getUsuarioLogin };