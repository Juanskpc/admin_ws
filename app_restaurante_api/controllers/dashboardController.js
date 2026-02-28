const jwt = require('jsonwebtoken');
const DashboardService = require('../services/dashboardService');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * dashboardController — Endpoints para el módulo restaurante.
 */

/**
 * POST /restaurante/auth/verificar-token
 * Recibe un JWT (desde admin_app) y verifica que sea válido y que
 * el usuario tenga acceso a al menos un negocio de tipo restaurante.
 *
 * Body: { token }
 * Response: { success, data: { valid, usuario, negocio } }
 */
async function verificarTokenAcceso(req, res) {
    const { token } = req.body;

    if (!token) {
        return Respuesta.error(res, 'Token requerido', 400);
    }

    try {
        // Verificar firma y expiración del JWT
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Verificar que el usuario tenga acceso a un negocio tipo restaurante
        const acceso = await DashboardService.verificarAccesoRestaurante(decoded.id_usuario);

        if (!acceso) {
            return Respuesta.error(res, 'No tienes acceso al módulo de restaurante.', 403);
        }

        return Respuesta.success(res, 'Token válido', acceso);
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return Respuesta.error(res, 'El token ha expirado.', 401);
        }
        if (err.name === 'JsonWebTokenError') {
            return Respuesta.error(res, 'Token inválido.', 401);
        }
        console.error('[Restaurante] Error verificando token:', err.message);
        return Respuesta.error(res, 'Error al verificar el token.');
    }
}

/**
 * GET /restaurante/dashboard/resumen
 * Retorna datos resumidos del dashboard del restaurante.
 * (Placeholder — se irá completando con datos reales)
 */
async function getResumenDashboard(req, res) {
    try {
        const idUsuario = req.usuario.id_usuario;
        const resumen = await DashboardService.getResumenDashboard(idUsuario);
        return Respuesta.success(res, 'Resumen del dashboard', resumen);
    } catch (err) {
        console.error('[Restaurante] Error dashboard:', err.message);
        return Respuesta.error(res, 'Error al obtener el resumen del dashboard.');
    }
}

/**
 * GET /restaurante/perfil
 * Retorna el perfil del usuario con su contexto de restaurante.
 */
async function getPerfilRestaurante(req, res) {
    try {
        const idUsuario = req.usuario.id_usuario;
        const perfil = await DashboardService.verificarAccesoRestaurante(idUsuario);

        if (!perfil) {
            return Respuesta.error(res, 'No tienes acceso al módulo de restaurante.', 403);
        }

        return Respuesta.success(res, 'Perfil obtenido', perfil);
    } catch (err) {
        console.error('[Restaurante] Error perfil:', err.message);
        return Respuesta.error(res, 'Error al obtener el perfil.');
    }
}

module.exports = {
    verificarTokenAcceso,
    getResumenDashboard,
    getPerfilRestaurante,
};
