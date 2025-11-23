const Bcrypt = require('bcrypt');

const UsuarioDao = require('./../../app_core/dao/usuarioDao');
const Respuesta = require('./../../app_core/helpers/respuesta');
const Transaction = require('./../../app_core/helpers/funcionesAdicionales')

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

/**
 * Función para crear usuarios
 * @param {*} req 
 * @param {*} res 
 */
async function createUsuario(req, res){
    let transaction;
    try {
        const { 
            primer_nombre,
            segundo_nombre,
            primer_apellido,
            segundo_apellido,
            num_identificacion,
            telefono,
            email,
            password,
            fec_nacimiento,
            id_rol,
            id_negocio
        } = req.body;

        const dataUsuario = {
            primer_nombre,
            segundo_nombre,
            primer_apellido,
            segundo_apellido,
            num_identificacion,
            telefono,
            email,
            password,
            fec_nacimiento,
            id_rol
        };

        transaction = await Transaction.initTransaction();
        const id_usuario = await UsuarioDao.createUsuario(dataUsuario, transaction);
        
        const usuarioNegocio = {
            id_usuario: id_usuario,
            id_negocio: id_negocio
        }

        await UsuarioDao.createUsuarioNegocio(usuarioNegocio, transaction);

        await transaction.commit();
        Respuesta.sendJsonResponse(res, 200, 'éxito');
    } catch (error) {
        if(transaction) await transaction.rollback();
        console.log('error en createUsuario ------------->', error);
        Respuesta.sendJsonResponse(res, 500, error.message);
    }
}

/**
 * Función para listar roles activos
 * @param {*} req 
 * @param {*} res 
 */
async function getListaRoles(req, res){
    try {
        
    } catch (error) {
        
    }
}

module.exports.loginUsuario = loginUsuario;
module.exports.createUsuario = createUsuario;
module.exports.getListaRoles = getListaRoles;