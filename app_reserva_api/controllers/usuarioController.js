'use strict';
const { validationResult } = require('express-validator');
const UsuarioService = require('../services/usuarioService');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

function fallo(res, err, contexto, porDefecto) {
    if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
    console.error(`[Reserva/Usuarios] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

/**
 * Todas las rutas empiezan igual: comprobar que quien pide puede administrar ese negocio.
 *
 * La verificación va contra la base de datos, no contra el cuerpo de la petición. Es la
 * diferencia entre acotar de verdad y confiar en que el cliente mande el `id_negocio` correcto.
 */
async function autorizar(req) {
    const idNegocio = Number(req.query.id_negocio ?? req.body.id_negocio);
    if (!Number.isInteger(idNegocio) || idNegocio <= 0) {
        const e = new Error('id_negocio requerido'); e.statusCode = 400; throw e;
    }
    await UsuarioService.exigirPuedeAdministrar({
        idUsuario: req.usuario?.id_usuario,
        idNegocio,
    });
    return idNegocio;
}

/** GET /reserva/usuarios?id_negocio=N[&search=&incluir_inactivos=true] */
async function listar(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = await autorizar(req);
        const data = await UsuarioService.listar({
            idNegocio,
            search: req.query.search || '',
            incluirInactivos: req.query.incluir_inactivos === 'true',
        });
        return Respuesta.success(res, 'Usuarios obtenidos', data);
    } catch (err) {
        return fallo(res, err, 'listar', 'Error al consultar los usuarios.');
    }
}

/** GET /reserva/usuarios/roles?id_negocio=N */
async function listarRoles(req, res) {
    if (!check(req, res)) return;
    try {
        await autorizar(req);
        const data = await UsuarioService.listarRoles();
        return Respuesta.success(res, 'Roles obtenidos', data);
    } catch (err) {
        return fallo(res, err, 'listarRoles', 'Error al consultar los roles.');
    }
}

/** GET /reserva/usuarios/profesionales-libres?id_negocio=N */
async function profesionalesLibres(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = await autorizar(req);
        const data = await UsuarioService.profesionalesSinUsuario(idNegocio);
        return Respuesta.success(res, 'Profesionales sin usuario', data);
    } catch (err) {
        return fallo(res, err, 'profesionalesLibres', 'Error al consultar los profesionales.');
    }
}

/** GET /reserva/usuarios/roles/:id/permisos?id_negocio=N */
async function getPermisosRol(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = await autorizar(req);
        const data = await UsuarioService.getPermisosRol({
            idRol: Number(req.params.id), idNegocio,
        });
        return Respuesta.success(res, 'Permisos del rol', data);
    } catch (err) {
        return fallo(res, err, 'getPermisosRol', 'Error al consultar los permisos.');
    }
}

/** PUT /reserva/usuarios/roles/:id/permisos */
async function savePermisosRol(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = await autorizar(req);
        const data = await UsuarioService.savePermisosRol({
            idRol: Number(req.params.id), idNegocio, modulos: req.body.modulos,
        });
        return Respuesta.success(res, 'Permisos actualizados', data);
    } catch (err) {
        return fallo(res, err, 'savePermisosRol', 'Error al guardar los permisos.');
    }
}

/** POST /reserva/usuarios */
async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = await autorizar(req);
        const r = await UsuarioService.crear({
            idNegocio,
            datos: req.body,
            idProfesionalExistente: req.body.id_profesional ? Number(req.body.id_profesional) : null,
        });
        return Respuesta.success(res, 'Usuario creado', {
            id_usuario: r.usuario.id_usuario,
            // Se devuelve la contraseña inicial para que el administrador pueda dictársela al
            // empleado; solo la ve quien acaba de crear la cuenta y obliga a cambiarla al entrar.
            password_temporal: r.usuario.debe_cambiar_password ? r.usuario.num_identificacion : null,
            id_profesional: r.profesional?.id_profesional ?? null,
        });
    } catch (err) {
        return fallo(res, err, 'crear', 'Error al crear el usuario.');
    }
}

/** PUT /reserva/usuarios/:id */
async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = await autorizar(req);
        await UsuarioService.actualizar({
            idNegocio, idUsuario: Number(req.params.id), datos: req.body,
        });
        return Respuesta.success(res, 'Usuario actualizado', { id_usuario: Number(req.params.id) });
    } catch (err) {
        return fallo(res, err, 'actualizar', 'Error al actualizar el usuario.');
    }
}

/** PATCH /reserva/usuarios/:id/estado */
async function cambiarEstado(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = await autorizar(req);
        await UsuarioService.cambiarEstado({
            idNegocio,
            idUsuario: Number(req.params.id),
            estado: String(req.body.estado || '').toUpperCase(),
            idUsuarioSolicitante: req.usuario?.id_usuario,
        });
        return Respuesta.success(res, 'Estado actualizado', { id_usuario: Number(req.params.id) });
    } catch (err) {
        return fallo(res, err, 'cambiarEstado', 'Error al cambiar el estado.');
    }
}

/** POST /reserva/usuarios/:id/reset-password */
async function resetPassword(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = await autorizar(req);
        const data = await UsuarioService.resetPassword({
            idNegocio, idUsuario: Number(req.params.id),
        });
        return Respuesta.success(res, 'Contraseña restablecida', data);
    } catch (err) {
        return fallo(res, err, 'resetPassword', 'Error al restablecer la contraseña.');
    }
}

module.exports = {
    listar, listarRoles, profesionalesLibres,
    getPermisosRol, savePermisosRol,
    crear, actualizar, cambiarEstado, resetPassword,
};
