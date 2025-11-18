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

module.exports.getInfoUsuario = getInfoUsuario;
module.exports.getPwUsuario = getPwUsuario;