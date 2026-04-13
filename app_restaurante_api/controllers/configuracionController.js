const { validationResult } = require('express-validator');

const ConfiguracionService = require('../services/configuracionService');
const Respuesta = require('../../app_core/helpers/respuesta');

function getValidationErrors(req, res) {
    const errors = validationResult(req);
    if (errors.isEmpty()) return null;
    return Respuesta.error(res, 'Datos de entrada invalidos', 400, errors.array());
}

function resolveStatusCode(error) {
    return Number(error?.statusCode || 500);
}

async function getConfiguracion(req, res) {
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idUsuario = req.usuario.id_usuario;
        const idNegocio = req.query.id_negocio ? Number(req.query.id_negocio) : null;

        const data = await ConfiguracionService.getConfiguracionNegocio(idUsuario, idNegocio);
        return Respuesta.success(res, 'Configuracion obtenida', data);
    } catch (error) {
        console.error('[Configuracion] Error getConfiguracion:', error.message);
        return Respuesta.error(res, error.message || 'Error al obtener la configuracion.', resolveStatusCode(error));
    }
}

async function updateConfiguracion(req, res) {
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idUsuario = req.usuario.id_usuario;
        const payload = {
            id_negocio: req.body.id_negocio ? Number(req.body.id_negocio) : null,
            nombre: req.body.nombre,
            nit: req.body.nit,
            email_contacto: req.body.email_contacto,
            telefono: req.body.telefono,
            id_paleta: req.body.id_paleta !== undefined ? req.body.id_paleta : undefined,
        };

        const data = await ConfiguracionService.updateConfiguracionNegocio(idUsuario, payload);
        return Respuesta.success(res, 'Configuracion actualizada', data);
    } catch (error) {
        console.error('[Configuracion] Error updateConfiguracion:', error.message);
        return Respuesta.error(res, error.message || 'Error al actualizar la configuracion.', resolveStatusCode(error));
    }
}

async function getPaletas(req, res) {
    try {
        const paletas = await ConfiguracionService.getPaletasActivas();
        return Respuesta.success(res, 'Paletas obtenidas', paletas);
    } catch (error) {
        console.error('[Configuracion] Error getPaletas:', error.message);
        return Respuesta.error(res, 'Error al obtener paletas de colores.');
    }
}

async function getPaletaNegocio(req, res) {
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idUsuario = req.usuario.id_usuario;
        const idNegocio = Number(req.params.id);
        const paleta = await ConfiguracionService.getPaletaNegocio(idUsuario, idNegocio);

        if (!paleta) {
            return Respuesta.error(res, 'No se encontro paleta para este negocio.', 404);
        }

        return Respuesta.success(res, 'Paleta del negocio obtenida', paleta);
    } catch (error) {
        console.error('[Configuracion] Error getPaletaNegocio:', error.message);
        return Respuesta.error(res, error.message || 'Error al obtener la paleta del negocio.', resolveStatusCode(error));
    }
}

async function assignPaletaNegocio(req, res) {
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idUsuario = req.usuario.id_usuario;
        const idNegocio = Number(req.params.id);
        const idPaleta = Number(req.body.id_paleta);

        const paleta = await ConfiguracionService.updatePaletaNegocio(idUsuario, idNegocio, idPaleta);
        return Respuesta.success(res, 'Paleta asignada correctamente', paleta);
    } catch (error) {
        console.error('[Configuracion] Error assignPaletaNegocio:', error.message);
        return Respuesta.error(res, error.message || 'Error al asignar la paleta.', resolveStatusCode(error));
    }
}

module.exports = {
    getConfiguracion,
    updateConfiguracion,
    getPaletas,
    getPaletaNegocio,
    assignPaletaNegocio,
};
