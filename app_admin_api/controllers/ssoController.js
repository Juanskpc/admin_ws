const AccessCodeStore = require('../../app_parqueadero_api/services/accessCodeStore');
const LoginDao = require('../../app_core/dao/loginDao');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * POST /admin/auth/canjear-codigo
 *
 * Canjea un código de acceso de un solo uso (emitido por otra app del SaaS vía
 * `/{modulo}/auth/generar-codigo`) por la sesión del admin_app. Permite volver
 * al portal central autenticado sin reintroducir credenciales (SSO de salida:
 * negocio_app → admin_app). La seguridad la da el código de un solo uso (TTL corto);
 * por eso la ruta es pública, igual que el canjear-codigo de restaurante.
 */
async function canjearCodigo(req, res) {
    const { code } = req.body;
    if (!code) return Respuesta.error(res, 'Código requerido', 400);

    const entry = AccessCodeStore.consume(code);
    if (!entry) return Respuesta.error(res, 'Código inválido o expirado.', 401);

    try {
        const usuario = await LoginDao.getUsuarioLogin(entry.idUsuario);
        if (!usuario) return Respuesta.error(res, 'Usuario no encontrado.', 404);

        return Respuesta.success(res, 'Acceso concedido', {
            token: entry.token,
            usuario,
        });
    } catch (error) {
        console.error('[Admin] Error canjearCodigo SSO:', error.message);
        return Respuesta.error(res, 'Error al canjear el código de acceso.');
    }
}

module.exports = { canjearCodigo };
