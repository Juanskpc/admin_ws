'use strict';
const { validationResult } = require('express-validator');
const PuntoCajaService = require('../services/puntoCajaService');
const CajaService = require('../services/cajaService');
const Respuesta = require('../../app_core/helpers/respuesta');
const Audit = require('../../app_core/helpers/auditHelper');
const { setAuditNegocio } = require('../../app_core/middleware/auditContext');

/**
 * Las cajas (rubros de ingreso) del negocio: crearlas, renombrarlas, activarlas y repartirlas
 * entre los usuarios.
 *
 * `GET /restaurante/cajas/mias` es la que usa el POS y no exige permiso de gestión: cualquiera
 * que tome pedidos necesita saber en qué cajas puede cobrar.
 */

function handleValidation(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        Respuesta.error(res, 'Datos inválidos', 422, errors.array());
        return false;
    }
    return true;
}

/** Los errores del servicio ya vienen tipados; esto solo los traduce a respuesta. */
function responderError(res, err, mensajeGenerico) {
    if (err.statusCode) {
        return Respuesta.error(res, err.message, err.statusCode, {
            code: err.code,
            ...(err.limite ? { limite: err.limite } : {}),
        });
    }
    console.error('[Cajas] ' + mensajeGenerico + ':', err.message);
    return Respuesta.error(res, mensajeGenerico);
}

async function exigirPertenencia(req, res, idNegocio) {
    const pertenece = await CajaService.usuarioPerteneceANegocio({
        idUsuario: req.usuario?.id_usuario,
        idNegocio,
    });
    if (!pertenece) {
        Respuesta.error(res, 'No tienes acceso a este negocio.', 403);
        return false;
    }
    return true;
}

/** GET /restaurante/cajas?id_negocio=N — listado de gestión, con el tope del plan. */
async function listar(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!(await exigirPertenencia(req, res, idNegocio))) return;

        const data = await PuntoCajaService.listarParaAdmin(idNegocio);
        return Respuesta.success(res, 'Cajas obtenidas', data);
    } catch (err) {
        return responderError(res, err, 'Error al obtener las cajas.');
    }
}

/** GET /restaurante/cajas/mias?id_negocio=N — las que puede usar quien pregunta. */
async function mias(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!(await exigirPertenencia(req, res, idNegocio))) return;

        const cajas = await PuntoCajaService.cajasDeUsuario({
            idNegocio,
            idUsuario: req.usuario.id_usuario,
        });
        return Respuesta.success(res, 'Cajas del usuario', cajas);
    } catch (err) {
        return responderError(res, err, 'Error al obtener tus cajas.');
    }
}

/** GET /restaurante/cajas/asignaciones?id_negocio=N */
async function asignaciones(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!(await exigirPertenencia(req, res, idNegocio))) return;

        const filas = await PuntoCajaService.listarAsignaciones(idNegocio);
        return Respuesta.success(res, 'Asignaciones obtenidas', filas);
    } catch (err) {
        return responderError(res, err, 'Error al obtener las asignaciones.');
    }
}

/** POST /restaurante/cajas */
async function crear(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        if (!(await exigirPertenencia(req, res, idNegocio))) return;
        setAuditNegocio(idNegocio);

        const punto = await PuntoCajaService.crearPunto({
            idNegocio,
            idUsuario: req.usuario.id_usuario,
            nombre: req.body.nombre,
            descripcion: req.body.descripcion || null,
        });

        await Audit.registrarEvento({
            modulo: 'caja', accion: 'punto_caja_creado', idNegocio,
            detalle: { id_punto_caja: punto.id_punto_caja, nombre: punto.nombre },
        });
        return Respuesta.success(res, 'Caja creada', punto, 201);
    } catch (err) {
        return responderError(res, err, 'Error al crear la caja.');
    }
}

/** PUT /restaurante/cajas/:id */
async function actualizar(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        if (!(await exigirPertenencia(req, res, idNegocio))) return;
        setAuditNegocio(idNegocio);

        const punto = await PuntoCajaService.actualizarPunto({
            idNegocio,
            idUsuario: req.usuario.id_usuario,
            idPuntoCaja: Number(req.params.id),
            nombre: req.body.nombre,
            descripcion: req.body.descripcion,
            orden: req.body.orden,
            estado: req.body.estado,
        });

        await Audit.registrarEvento({
            modulo: 'caja', accion: 'punto_caja_actualizado', idNegocio,
            detalle: { id_punto_caja: punto.id_punto_caja, nombre: punto.nombre, estado: punto.estado },
        });
        return Respuesta.success(res, 'Caja actualizada', punto);
    } catch (err) {
        return responderError(res, err, 'Error al actualizar la caja.');
    }
}

/**
 * PUT /restaurante/cajas/usuarios/:id_usuario — las cajas de un usuario, de una vez.
 *
 * Lista vacía = sin asignación explícita, que es «puede usar todas las activas». No es lo
 * mismo que no poder usar ninguna: dejar a alguien sin caja lo dejaría sin poder cobrar, y
 * eso se hace quitándole el permiso, no vaciándole la lista.
 */
async function asignarUsuario(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        if (!(await exigirPertenencia(req, res, idNegocio))) return;
        setAuditNegocio(idNegocio);

        const idUsuarioObjetivo = Number(req.params.id_usuario);
        const cajas = await PuntoCajaService.fijarCajasDeUsuario({
            idNegocio,
            idUsuario: req.usuario.id_usuario,
            idUsuarioObjetivo,
            idsPuntos: Array.isArray(req.body.id_puntos_caja) ? req.body.id_puntos_caja : [],
        });

        await Audit.registrarEvento({
            modulo: 'caja', accion: 'cajas_de_usuario_asignadas', idNegocio,
            detalle: { id_usuario: idUsuarioObjetivo, cajas: cajas.map((c) => c.id_punto_caja) },
        });
        return Respuesta.success(res, 'Cajas asignadas', cajas);
    } catch (err) {
        return responderError(res, err, 'Error al asignar las cajas.');
    }
}

module.exports = { listar, mias, asignaciones, crear, actualizar, asignarUsuario };
