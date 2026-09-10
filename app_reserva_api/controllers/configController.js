'use strict';
const { validationResult } = require('express-validator');
const ConfigService = require('../services/configService');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

async function get(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const cfg = await ConfigService.getPantalla(idNegocio);
        return Respuesta.success(res, 'Configuración obtenida', cfg);
    } catch (err) {
        console.error('[Reserva/Config] get:', err.message);
        return Respuesta.error(res, 'Error al obtener la configuración.');
    }
}

async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const cfg = await ConfigService.actualizar(idNegocio, req.body);
        return Respuesta.success(res, 'Configuración actualizada', cfg);
    } catch (err) {
        // Los errores de dominio (país no soportado) llevan su propio código y se reenvían
        // tal cual: convertirlos en un 500 genérico escondería el motivo real.
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Config] actualizar:', err.message);
        return Respuesta.error(res, 'Error al actualizar la configuración.');
    }
}

module.exports = { get, actualizar };
