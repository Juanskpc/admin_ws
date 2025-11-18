const sequelize = require('./../models/conection');
const Models = sequelize.sequelize;

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

module.exports.getInfoUsuario = getInfoUsuario;