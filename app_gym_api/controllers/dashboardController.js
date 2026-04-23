'use strict';
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const DashboardService = require('../services/dashboardService');
const AccessCodeStore = require('../../app_parqueadero_api/services/accessCodeStore');
const Respuesta = require('../../app_core/helpers/respuesta');

/** POST /gym/auth/verificar-token */
async function verificarTokenAcceso(req, res) {
    const { token } = req.body;
    if (!token) return Respuesta.error(res, 'Token requerido', 400);
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const acceso = await DashboardService.verificarAccesoGym(decoded.id_usuario);
        if (!acceso) return Respuesta.error(res, 'No tienes acceso al módulo de gimnasio.', 403);
        return Respuesta.success(res, 'Token válido', acceso);
    } catch (err) {
        if (err.name === 'TokenExpiredError') return Respuesta.error(res, 'El token ha expirado.', 401);
        if (err.name === 'JsonWebTokenError')  return Respuesta.error(res, 'Token inválido.', 401);
        console.error('[Gym] verificarToken:', err.message);
        return Respuesta.error(res, 'Error al verificar el token.');
    }
}

/** POST /gym/auth/generar-codigo */
async function generarCodigoAcceso(req, res) {
    const { token, id_negocio } = req.body;
    if (!token) return Respuesta.error(res, 'Token requerido', 400);
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const acceso = await DashboardService.verificarAccesoGym(decoded.id_usuario);
        if (!acceso) return Respuesta.error(res, 'No tienes acceso al módulo de gimnasio.', 403);

        if (id_negocio) {
            const tieneAcceso = (acceso.negocios || []).some(n => n.id_negocio === parseInt(id_negocio, 10));
            if (!tieneAcceso) return Respuesta.error(res, 'No tienes acceso a este negocio.', 403);
        }

        const code = uuidv4();
        AccessCodeStore.save(code, {
            idUsuario: decoded.id_usuario,
            token,
            idNegocio: id_negocio ? parseInt(id_negocio, 10) : null,
        });
        return Respuesta.success(res, 'Código generado', { code });
    } catch (err) {
        if (err.name === 'TokenExpiredError') return Respuesta.error(res, 'El token ha expirado.', 401);
        if (err.name === 'JsonWebTokenError')  return Respuesta.error(res, 'Token inválido.', 401);
        console.error('[Gym] generarCodigoAcceso:', err.message);
        return Respuesta.error(res, 'Error al generar código de acceso.');
    }
}

/** POST /gym/auth/canjear-codigo */
async function canjearCodigo(req, res) {
    const { code } = req.body;
    if (!code) return Respuesta.error(res, 'Código requerido', 400);

    const entry = AccessCodeStore.consume(code);
    if (!entry) return Respuesta.error(res, 'Código inválido o expirado.', 401);

    try {
        const acceso = await DashboardService.verificarAccesoGym(entry.idUsuario);
        if (!acceso) return Respuesta.error(res, 'Acceso revocado.', 403);

        if (entry.idNegocio) {
            const seleccionado = (acceso.negocios || []).find(n => n.id_negocio === entry.idNegocio);
            if (seleccionado) {
                acceso.negocio = seleccionado;
                acceso.roles = seleccionado.roles;
            }
        }
        return Respuesta.success(res, 'Acceso concedido', { token: entry.token, ...acceso });
    } catch (err) {
        console.error('[Gym] canjearCodigo:', err.message);
        return Respuesta.error(res, 'Error al canjear código.');
    }
}

/** GET /gym/dashboard/resumen?id_negocio=N */
async function getResumen(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const resumen = await DashboardService.getResumenDashboard(idNegocio);
        return Respuesta.success(res, 'Resumen del dashboard', resumen);
    } catch (err) {
        console.error('[Gym] getResumen:', err.message);
        return Respuesta.error(res, 'Error al obtener el resumen.');
    }
}

/** GET /gym/perfil */
async function getPerfil(req, res) {
    try {
        const acceso = await DashboardService.verificarAccesoGym(req.usuario.id_usuario);
        if (!acceso) return Respuesta.error(res, 'No tienes acceso al módulo de gimnasio.', 403);
        return Respuesta.success(res, 'Perfil obtenido', acceso);
    } catch (err) {
        console.error('[Gym] getPerfil:', err.message);
        return Respuesta.error(res, 'Error al obtener el perfil.');
    }
}

module.exports = {
    verificarTokenAcceso, generarCodigoAcceso, canjearCodigo, getResumen, getPerfil,
};
