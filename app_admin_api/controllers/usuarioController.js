const jwt = require('jsonwebtoken');
const Bcrypt = require('bcrypt');
const { validationResult } = require('express-validator');

const LoginDao = require('../../app_core/dao/loginDao');
const UsuarioDao = require('../../app_core/dao/usuarioDao');
const Respuesta = require('../../app_core/helpers/respuesta');
const { initTransaction } = require('../../app_core/helpers/funcionesAdicionales');

/**
 * Login de usuario.
 * Verifica credenciales, genera JWT y retorna datos del usuario con sus negocios y roles.
 */
async function loginUsuario(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const { num_identificacion, password } = req.body;

        // Buscar usuario por número de identificación
        const usuario = await LoginDao.getPwUsuario(num_identificacion);
        if (!usuario) {
            return Respuesta.error(res, 'Credenciales incorrectas', 401);
        }

        // Verificar contraseña
        const pwCorrecta = await Bcrypt.compare(password, usuario.password);
        if (!pwCorrecta) {
            return Respuesta.error(res, 'Credenciales incorrectas', 401);
        }

        // Obtener datos completos del usuario (negocios, roles)
        const datosUsuario = await LoginDao.getUsuarioLogin(usuario.id_usuario);

        // Generar token JWT
        const token = jwt.sign(
            { id_usuario: usuario.id_usuario },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
        );

        return Respuesta.success(res, 'Login exitoso', { token, usuario: datosUsuario });
    } catch (error) {
        console.error('Error en loginUsuario:', error);
        return Respuesta.error(res, 'Error al iniciar sesión');
    }
}

/**
 * Crear un nuevo usuario.
 * Valida entrada, verifica duplicados, crea usuario con negocio y rol en transacción.
 */
async function createUsuario(req, res) {
    let transaction;
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const {
            primer_nombre,
            segundo_nombre,
            primer_apellido,
            segundo_apellido,
            num_identificacion,
            telefono,
            email,
            password,
            fecha_nacimiento,
            id_rol,
            id_negocio
        } = req.body;

        // Verificar si ya existe un usuario con ese email o identificación
        const existe = await UsuarioDao.verificarUsuarioExistente(email, num_identificacion);
        if (existe) {
            const campo = existe.email === email ? 'email' : 'número de identificación';
            return Respuesta.error(res, `Ya existe un usuario con ese ${campo}`, 409);
        }

        const dataUsuario = {
            primer_nombre,
            segundo_nombre,
            primer_apellido,
            segundo_apellido,
            num_identificacion,
            telefono,
            email,
            password, // Se hashea automáticamente en el hook beforeCreate del modelo
            fecha_nacimiento
        };

        transaction = await initTransaction();

        // Crear usuario
        const id_usuario = await UsuarioDao.createUsuario(dataUsuario, transaction);

        // Ligar usuario al negocio
        if (id_negocio) {
            await UsuarioDao.createUsuarioNegocio({ id_usuario, id_negocio }, transaction);
        }

        // Asignar rol al usuario en el negocio
        if (id_rol) {
            await UsuarioDao.createUsuarioRol({
                id_usuario,
                id_rol,
                id_negocio: id_negocio || null
            }, transaction);
        }

        await transaction.commit();
        return Respuesta.success(res, 'Usuario creado exitosamente', { id_usuario }, 201);
    } catch (error) {
        if (transaction) await transaction.rollback();
        console.error('Error en createUsuario:', error);
        return Respuesta.error(res, 'Error al crear el usuario');
    }
}

/**
 * Listar roles activos.
 */
async function getListaRoles(req, res) {
    try {
        const roles = await UsuarioDao.getListaRoles();
        return Respuesta.success(res, 'Roles obtenidos', roles);
    } catch (error) {
        console.error('Error en getListaRoles:', error);
        return Respuesta.error(res, 'Error al obtener los roles');
    }
}

/**
 * Obtener perfil del usuario autenticado (datos del token JWT).
 */
async function getPerfil(req, res) {
    try {
        const { id_usuario } = req.usuario; // Viene del middleware auth
        const datosUsuario = await LoginDao.getUsuarioLogin(id_usuario);

        if (!datosUsuario) {
            return Respuesta.error(res, 'Usuario no encontrado', 404);
        }

        return Respuesta.success(res, 'Perfil obtenido', datosUsuario);
    } catch (error) {
        console.error('Error en getPerfil:', error);
        return Respuesta.error(res, 'Error al obtener el perfil');
    }
}

module.exports = { loginUsuario, createUsuario, getListaRoles, getPerfil };