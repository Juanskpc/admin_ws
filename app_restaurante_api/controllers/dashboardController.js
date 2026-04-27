const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const DashboardService = require('../services/dashboardService');
const AccessCodeStore = require('../../app_parqueadero_api/services/accessCodeStore');
const Respuesta = require('../../app_core/helpers/respuesta');
const { tienePlanActivo } = require('../../app_core/helpers/planHelper');

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
        const idNegocio = req.query.id_negocio ? Number(req.query.id_negocio) : null;
        const resumen = await DashboardService.getResumenDashboard(idUsuario, idNegocio);
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

/**
 * POST /restaurante/auth/generar-codigo
 * Recibe el JWT del admin_app, verifica que el usuario tenga acceso al
 * módulo restaurante y emite un código de acceso de un solo uso (TTL 30 s).
 *
 * Necesario porque las apps están en orígenes distintos en desarrollo
 * (admin:4002 ↔ restaurante:6002) y los navegadores limpian `window.name`
 * en navegación cross-origin (Chrome 88+, Firefox 79+).
 */
async function generarCodigoAcceso(req, res) {
    const { token, id_negocio } = req.body;
    if (!token) return Respuesta.error(res, 'Token requerido', 400);

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const acceso = await DashboardService.verificarAccesoRestaurante(decoded.id_usuario);
        if (!acceso) return Respuesta.error(res, 'No tienes acceso al módulo de restaurante.', 403);

        if (id_negocio) {
            const tieneAcceso = (acceso.negocios || []).some(
                (n) => n.id_negocio === parseInt(id_negocio, 10)
            );
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
        console.error('[Restaurante] Error generarCodigoAcceso:', err.message);
        return Respuesta.error(res, 'Error al generar código de acceso.');
    }
}

/**
 * POST /restaurante/auth/canjear-codigo
 * Canjea el código de un solo uso por la sesión completa (token + datos).
 */
async function canjearCodigo(req, res) {
    const { code } = req.body;
    if (!code) return Respuesta.error(res, 'Código requerido', 400);

    const entry = AccessCodeStore.consume(code);
    if (!entry) return Respuesta.error(res, 'Código inválido o expirado.', 401);

    try {
        const acceso = await DashboardService.verificarAccesoRestaurante(entry.idUsuario);
        if (!acceso) return Respuesta.error(res, 'Acceso revocado.', 403);

        if (entry.idNegocio) {
            const negocioSeleccionado = (acceso.negocios || []).find(
                (n) => n.id_negocio === entry.idNegocio
            );
            if (negocioSeleccionado) {
                acceso.negocio = negocioSeleccionado;
                acceso.roles = negocioSeleccionado.roles;
            }
        }

        const idNegocioActivo = entry.idNegocio || acceso.negocio?.id_negocio || null;
        acceso.plan_activo = idNegocioActivo ? await tienePlanActivo(idNegocioActivo) : false;

        return Respuesta.success(res, 'Acceso concedido', {
            token: entry.token,
            ...acceso,
        });
    } catch (err) {
        console.error('[Restaurante] Error canjearCodigo:', err.message);
        return Respuesta.error(res, 'Error al canjear código.');
    }
}

module.exports = {
    verificarTokenAcceso,
    generarCodigoAcceso,
    canjearCodigo,
    getResumenDashboard,
    getPerfilRestaurante,
};
