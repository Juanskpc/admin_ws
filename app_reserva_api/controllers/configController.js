'use strict';
const ConfigService = require('../services/configService');
const Respuesta = require('../../app_core/helpers/respuesta');

async function get(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const cfg = await ConfigService.get(idNegocio);
        return Respuesta.success(res, 'Configuración obtenida', cfg);
    } catch (err) {
        console.error('[Reserva/Config] get:', err.message);
        return Respuesta.error(res, 'Error al obtener la configuración.');
    }
}

async function actualizar(req, res) {
    try {
        const idNegocio = Number(req.body.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const cfg = await ConfigService.actualizar(idNegocio, req.body);
        return Respuesta.success(res, 'Configuración actualizada', cfg);
    } catch (err) {
        console.error('[Reserva/Config] actualizar:', err.message);
        return Respuesta.error(res, 'Error al actualizar la configuración.');
    }
}

module.exports = { get, actualizar };
