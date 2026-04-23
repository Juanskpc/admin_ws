'use strict';
const ConfigService = require('../services/configuracionService');
const Respuesta = require('../../app_core/helpers/respuesta');

async function listarPaletas(req, res) {
    try {
        const paletas = await ConfigService.listarPaletas();
        return Respuesta.success(res, 'Paletas obtenidas', paletas);
    } catch (err) {
        console.error('[Gym/Config] listarPaletas:', err.message);
        return Respuesta.error(res, 'Error al obtener paletas.');
    }
}

async function getPaletaNegocio(req, res) {
    try {
        const idNegocio = Number(req.params.id);
        const p = await ConfigService.getPaletaNegocio(idNegocio);
        if (!p) return Respuesta.error(res, 'Negocio sin paleta asignada', 404);
        return Respuesta.success(res, 'Paleta obtenida', p);
    } catch (err) {
        console.error('[Gym/Config] getPaletaNegocio:', err.message);
        return Respuesta.error(res, 'Error al obtener la paleta.');
    }
}

async function asignarPaletaNegocio(req, res) {
    try {
        const idNegocio = Number(req.params.id);
        const idPaleta = req.body.id_paleta != null ? Number(req.body.id_paleta) : null;
        const p = await ConfigService.asignarPaletaNegocio(idNegocio, idPaleta);
        if (!p) return Respuesta.error(res, 'Negocio no encontrado', 404);
        return Respuesta.success(res, 'Paleta asignada', p);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Gym/Config] asignarPaleta:', err.message);
        return Respuesta.error(res, 'Error al asignar la paleta.');
    }
}

async function getConfiguracion(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const c = await ConfigService.getConfiguracion(idNegocio);
        if (!c) return Respuesta.error(res, 'Negocio no encontrado', 404);
        return Respuesta.success(res, 'Configuración obtenida', c);
    } catch (err) {
        console.error('[Gym/Config] getConfiguracion:', err.message);
        return Respuesta.error(res, 'Error al obtener la configuración.');
    }
}

async function actualizarConfiguracion(req, res) {
    try {
        const idNegocio = Number(req.body.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const c = await ConfigService.actualizarConfiguracion(idNegocio, req.body);
        if (!c) return Respuesta.error(res, 'Negocio no encontrado', 404);
        return Respuesta.success(res, 'Configuración actualizada', c);
    } catch (err) {
        console.error('[Gym/Config] actualizarConfiguracion:', err.message);
        return Respuesta.error(res, 'Error al actualizar la configuración.');
    }
}

module.exports = {
    listarPaletas, getPaletaNegocio, asignarPaletaNegocio,
    getConfiguracion, actualizarConfiguracion,
};
