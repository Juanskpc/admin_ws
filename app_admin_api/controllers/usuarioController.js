const UsuarioDao = require('./../../app_core/dao/usuarioDao');
const Respuesta = require('./../../app_core/helpers/respuesta');
const Bcrypt = require('bcrypt');

/**
 * Función para logearse
 * @param {*} req 
 * @param {*} res 
 */
async function loginUsuario(req, res){
    try {
        const { numIdentificacion, password } = req.body;
        
        const pwUsuario = await UsuarioDao.getPwUsuario(numIdentificacion);

        if(!pwUsuario) throw new Error('El número de identificación es incorrecto o el usuario no existe');

        const pwCorrecta = await Bcrypt.compare(password, pwUsuario.password);
        
        if(!pwCorrecta) throw new Error('La contraseña es incorrecta');

        Respuesta.sendJsonResponse(res, 200, 'logeo exitoso');
    } catch (error) {
        console.log('error en loginUsuario ------------->', error);
        Respuesta.sendJsonResponse(res, 500, error.message);
    }
}

module.exports.loginUsuario = loginUsuario;