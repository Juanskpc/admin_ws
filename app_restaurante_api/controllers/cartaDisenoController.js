'use strict';
const { validationResult } = require('express-validator');
const CartaDisenoService = require('../services/cartaDisenoService');
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
    console.error(`[CartaDiseno] Error ${donde}:`, err?.message);
    return Respuesta.error(res, generico);
}

/** GET /restaurante/carta/diseno?id_negocio=N */
async function getDiseno(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const data = await CartaDisenoService.getDisenoAdmin(
            req.usuario.id_usuario,
            Number(req.query.id_negocio),
        );
        return Respuesta.success(res, 'Diseño de carta obtenido', data);
    } catch (err) {
        return fallo(res, err, 'getDiseno', 'Error al obtener el diseño de la carta.');
    }
}

/** PUT /restaurante/carta/diseno — publica plantilla, formato, marca y opciones. */
async function publicar(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        setAuditNegocio(idNegocio);
        const data = await CartaDisenoService.publicarDiseno(req.usuario.id_usuario, {
            id_negocio: idNegocio,
            plantilla: req.body.plantilla,
            formato: req.body.formato,
            marca: req.body.marca,
            opciones: req.body.opciones,
        });
        return Respuesta.success(res, 'Carta publicada', data);
    } catch (err) {
        return fallo(res, err, 'publicar', 'Error al publicar la carta.');
    }
}

/** POST /restaurante/carta/diseno/logo (multipart) */
async function subirLogo(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        if (!req.file) return Respuesta.error(res, 'No se recibió ninguna imagen.', 400);
        const idNegocio = Number(req.body.id_negocio);
        setAuditNegocio(idNegocio);
        const data = await CartaDisenoService.subirLogo(req.usuario.id_usuario, {
            idNegocio,
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
        });
        return Respuesta.success(res, 'Logo actualizado', data, 201);
    } catch (err) {
        return fallo(res, err, 'subirLogo', 'Error al subir el logo.');
    }
}

/** DELETE /restaurante/carta/diseno/logo?id_negocio=N */
async function eliminarLogo(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);
        setAuditNegocio(idNegocio);
        const data = await CartaDisenoService.eliminarLogo(req.usuario.id_usuario, idNegocio);
        return Respuesta.success(res, 'Logo eliminado', data);
    } catch (err) {
        return fallo(res, err, 'eliminarLogo', 'Error al eliminar el logo.');
    }
}

module.exports = { getDiseno, publicar, subirLogo, eliminarLogo };
