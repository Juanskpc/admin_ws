'use strict';
const { validationResult } = require('express-validator');
const TiqueteDisenoService = require('../services/tiqueteDisenoService');
const Respuesta = require('../../app_core/helpers/respuesta');
const { setAuditNegocio } = require('../../app_core/middleware/auditContext');

function handleValidation(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        Respuesta.error(res, 'Datos inválidos', 422, errors.array());
        return false;
    }
    return true;
}

/** Los errores de dominio llegan con su código; el resto es una avería y se registra. */
function fallo(res, err, donde, generico) {
    if (err?.statusCode && err.statusCode < 500) {
        return Respuesta.error(res, err.message, err.statusCode, err.code ? { code: err.code } : undefined);
    }
    console.error(`[TiqueteDiseno] Error ${donde}:`, err?.message);
    return Respuesta.error(res, generico);
}

/** GET /restaurante/tiquete/diseno?id_negocio=N */
async function getDiseno(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const data = await TiqueteDisenoService.getDisenoAdmin(
            req.usuario.id_usuario,
            Number(req.query.id_negocio),
        );
        return Respuesta.success(res, 'Diseño del tiquete obtenido', data);
    } catch (err) {
        return fallo(res, err, 'getDiseno', 'Error al obtener el diseño del tiquete.');
    }
}

/** PUT /restaurante/tiquete/diseno — guarda el diseño común y el de factura electrónica. */
async function guardar(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        setAuditNegocio(idNegocio);
        const data = await TiqueteDisenoService.guardarDiseno(req.usuario.id_usuario, {
            id_negocio: idNegocio,
            comun: req.body.comun,
            electronica: req.body.electronica,
        });
        return Respuesta.success(res, 'Tiquete guardado', data);
    } catch (err) {
        return fallo(res, err, 'guardar', 'Error al guardar el diseño del tiquete.');
    }
}

module.exports = { getDiseno, guardar };
