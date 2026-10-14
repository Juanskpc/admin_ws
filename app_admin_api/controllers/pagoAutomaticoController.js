/**
 * Pago automático (débito mensual opcional con tarjeta guardada) — ver
 * `services/pagoAutomaticoService.js`.
 *
 * Quién puede qué:
 *   - VER y DESACTIVAR: el administrador del negocio y el super admin (soporte).
 *   - ACTIVAR: solo el administrador del propio negocio. La autorización de un débito recurrente
 *     tiene que darla el titular; un super admin activándolo por el cliente sería un cargo que el
 *     cliente no pidió. Con la impersonación, el token ES del usuario, así que sigue valiendo.
 */
'use strict';
const { validationResult } = require('express-validator');
const PagoAutomaticoService = require('../services/pagoAutomaticoService');
const CobranzaService = require('../services/cobranzaService');
const Respuesta = require('../../app_core/helpers/respuesta');
const { alcanceDeNegocios } = require('../../app_core/middleware/auth');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) {
        Respuesta.error(res, 'Datos inválidos', 422, e.array());
        return false;
    }
    return true;
}

function fallo(res, err, contexto, porDefecto) {
    if (err.statusCode) {
        return Respuesta.error(res, err.message, err.statusCode, err.code ? [{ code: err.code }] : null);
    }
    console.error(`[PagoAutomatico] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

/** ¿Administra el negocio (o es super admin, si se permite)? Responde 403 y devuelve false si no. */
async function autorizado(req, res, idNegocio, { permitirSuperAdmin }) {
    const idUsuario = req.usuario?.id_usuario;
    if (await CobranzaService.usuarioAdministraNegocio(idUsuario, idNegocio)) return true;
    if (permitirSuperAdmin) {
        const alcance = await alcanceDeNegocios(idUsuario);
        if (alcance.superAdmin) return true;
    }
    Respuesta.error(
        res,
        permitirSuperAdmin
            ? 'No tienes acceso a los pagos de este negocio.'
            : 'Solo el administrador del negocio puede activar el pago automático.',
        403
    );
    return false;
}

/** GET /admin/cobranza/pago-automatico?id_negocio=N */
async function getEstado(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!(await autorizado(req, res, idNegocio, { permitirSuperAdmin: true }))) return;
        return Respuesta.success(res, 'Pago automático', await PagoAutomaticoService.estado(idNegocio));
    } catch (err) {
        return fallo(res, err, 'getEstado', 'Error al consultar el pago automático.');
    }
}

/** GET /admin/cobranza/pago-automatico/terminos?id_negocio=N */
async function getTerminos(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!(await autorizado(req, res, idNegocio, { permitirSuperAdmin: false }))) return;
        return Respuesta.success(res, 'Términos de Wompi', await PagoAutomaticoService.terminos());
    } catch (err) {
        return fallo(res, err, 'getTerminos', 'Error al preparar el registro de la tarjeta.');
    }
}

/** POST /admin/cobranza/pago-automatico */
async function activar(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        if (!(await autorizado(req, res, idNegocio, { permitirSuperAdmin: false }))) return;
        const datos = await PagoAutomaticoService.activar(idNegocio, {
            tokenTarjeta: req.body.token,
            tipo: req.body.tipo,
            acceptanceToken: req.body.acceptance_token,
            personalAuthToken: req.body.personal_auth_token,
            idUsuario: req.usuario.id_usuario,
            ip: req.ip,
        });
        return Respuesta.success(res, 'Pago automático activado', datos, 201);
    } catch (err) {
        return fallo(res, err, 'activar', 'No se pudo activar el pago automático.');
    }
}

/** POST /admin/cobranza/pago-automatico/desactivar */
async function desactivar(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        if (!(await autorizado(req, res, idNegocio, { permitirSuperAdmin: true }))) return;
        const datos = await PagoAutomaticoService.desactivar(idNegocio, {
            idUsuario: req.usuario.id_usuario,
        });
        return Respuesta.success(res, 'Pago automático desactivado', datos);
    } catch (err) {
        return fallo(res, err, 'desactivar', 'No se pudo desactivar el pago automático.');
    }
}

module.exports = { getEstado, getTerminos, activar, desactivar };
