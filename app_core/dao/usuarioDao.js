const Models = require('./../models/conection');


/**
 * Función para obtener información del usuario
 * @param {*} idUsuario Identificador único del usuario
 * @returns { Objetc } Información del usuario logeado
 */
function getInfoUsuario(idUsuario){
    return Models.GenerUsuario.findOne({
        where: {
            id_usuario: idUsuario,
            estado: 'A'
        }
    })
}

/**
 * Función para obtener información del usuario
 * @param {*} numIdentificacion Identificador único del usuario
 * @returns { Objetc } Información del usuario logeado
 */
function getPwUsuario(numIdentificacion){
    return Models.GenerUsuario.findOne({
        where: {
            num_identificacion: numIdentificacion,
            estado: 'A'
        },
        attributes: ['password']
    })
}

/**
 * Función para crear usuarios
 * @param {*} usuario Información completa del usuario
 * @param {*} t transacción de la bd
 * @returns 
 */
async function createUsuario(usuario, t){
    const usuarioRegister = await Models.GenerUsuario.create(usuario, { transaction: t});

    return usuarioRegister.id_usuario;
}

/**
 * Función para ligar el usuario al negocio que pertenece
 * @param {*} usuario 
 * @param {*} t 
 * @returns 
 */
function createUsuarioNegocio(usuarioNegocio, t){
    return Models.GenerNegocioUsuario.create(usuarioNegocio, { transaction: t});
}

module.exports.getInfoUsuario = getInfoUsuario;
module.exports.getPwUsuario = getPwUsuario;
module.exports.createUsuario = createUsuario;
module.exports.createUsuarioNegocio = createUsuarioNegocio;