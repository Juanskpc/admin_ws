/**
 * reporteAuth.js
 * Middleware de autorización de roles para el módulo de reportes.
 * Se aplica después de verificarToken.
 *
 * Uso:
 *   router.get('/reportes/transacciones',
 *     verificarToken,
 *     requireReportePermission('VER_TRANSACCIONES'),
 *     ReporteController.getTransacciones
 *   );
 */

'use strict';

const Respuesta = require('../helpers/respuesta');

// ─────────────────────────────────────────────
// Mapa de permisos por rol
// ─────────────────────────────────────────────

const PERMISOS_POR_ROL = {
  SUPER_ADMINISTRADOR: [
    'VER_REPORTES', 'VER_TRANSACCIONES', 'DESCARGAR_REPORTES',
    'PROGRAMAR_REPORTES', 'VER_AUDIT_LOG', 'VER_CONSOLIDADO_MULTI_TENANT',
    'VER_RECONCILIACION', 'VER_ANOMALIAS', 'VER_HISTORIAL_PLACA',
  ],
  ADMINISTRADOR: [
    'VER_REPORTES', 'VER_TRANSACCIONES', 'DESCARGAR_REPORTES',
    'PROGRAMAR_REPORTES', 'VER_AUDIT_LOG', 'VER_RECONCILIACION',
    'VER_ANOMALIAS', 'VER_HISTORIAL_PLACA',
  ],
  CAJERO: [
    'VER_REPORTES', 'VER_HISTORIAL_PLACA', 'VER_RECONCILIACION_PROPIA',
  ],
};

// ─────────────────────────────────────────────
// Middleware factory
// ─────────────────────────────────────────────

/**
 * Verifica que el usuario autenticado tenga el permiso indicado
 * y que tenga acceso al id_negocio solicitado.
 *
 * @param {string} permiso  Clave del permiso (ver PERMISOS_POR_ROL)
 */
function requireReportePermission(permiso) {
  return function (req, res, next) {
    const usuario = req.usuario;
    if (!usuario) return Respuesta.error(res, 'No autenticado', 401);

    const idNegocioSolicitado = parseInt(
      req.query.id_negocio || req.body.id_negocio || req.params.id_negocio,
      10,
    );

    // SUPER_ADMINISTRADOR puede acceder a cualquier negocio
    const esSuperAdmin = usuario.rol === 'SUPER_ADMINISTRADOR'
      || (Array.isArray(usuario.roles) && usuario.roles.includes('SUPER_ADMINISTRADOR'));

    if (!esSuperAdmin) {
      // Verificar acceso al negocio
      if (idNegocioSolicitado) {
        const negociosDelUsuario = usuario.negocios || [];
        const tieneAcceso = negociosDelUsuario.some(
          n => parseInt(n.id_negocio, 10) === idNegocioSolicitado,
        );
        if (!tieneAcceso) {
          return Respuesta.error(res, 'No tienes acceso a este negocio', 403);
        }
      }

      // Verificar permiso de rol
      const rolActual     = usuario.rol || '';
      const permisosDelRol = PERMISOS_POR_ROL[rolActual] || [];
      if (!permisosDelRol.includes(permiso)) {
        return Respuesta.error(res, `Sin permiso: ${permiso}`, 403);
      }

      // CAJERO solo puede ver su propia reconciliación
      if (permiso === 'VER_RECONCILIACION' && rolActual === 'CAJERO') {
        return Respuesta.error(res, 'Los cajeros solo pueden ver su propio turno', 403);
      }
    }

    next();
  };
}

/**
 * Middleware que solo permite acceso a SUPER_ADMINISTRADOR.
 * Para reportes consolidados multi-tenant.
 */
function soloSuperAdmin(req, res, next) {
  const usuario = req.usuario;
  const esSuperAdmin = usuario?.rol === 'SUPER_ADMINISTRADOR'
    || (Array.isArray(usuario?.roles) && usuario.roles.includes('SUPER_ADMINISTRADOR'));

  if (!esSuperAdmin) {
    return Respuesta.error(res, 'Solo el Super Administrador puede acceder a este recurso', 403);
  }
  next();
}

module.exports = { requireReportePermission, soloSuperAdmin, PERMISOS_POR_ROL };
