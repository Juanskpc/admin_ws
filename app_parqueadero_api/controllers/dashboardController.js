const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const DashboardService = require('../services/dashboardService');
const AccessCodeStore  = require('../services/accessCodeStore');
const Respuesta = require('../../app_core/helpers/respuesta');
const { tienePlanActivo } = require('../../app_core/helpers/planHelper');

async function verificarTokenAcceso(req, res) {
  const { token } = req.body;
  if (!token) return Respuesta.error(res, 'Token requerido', 400);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const acceso = await DashboardService.verificarAccesoParqueadero(decoded.id_usuario);
    if (!acceso) return Respuesta.error(res, 'No tienes acceso al módulo de parqueadero.', 403);

    const idNegocioActivo = acceso.negocio?.id_negocio ?? null;
    acceso.plan_activo = idNegocioActivo ? await tienePlanActivo(idNegocioActivo) : false;

    return Respuesta.success(res, 'Token válido', acceso);
  } catch (err) {
    if (err.name === 'TokenExpiredError') return Respuesta.error(res, 'El token ha expirado.', 401);
    if (err.name === 'JsonWebTokenError') return Respuesta.error(res, 'Token inválido.', 401);
    return Respuesta.error(res, 'Error al verificar el token.');
  }
}

async function getResumenDashboard(req, res) {
  try {
    const idUsuario = req.usuario.id_usuario;
    const idNegocio = parseInt(req.query.id_negocio || req.usuario.id_negocio, 10);
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
    const resumen = await DashboardService.getResumenDashboard(idUsuario, idNegocio);
    return Respuesta.success(res, 'Resumen del dashboard', resumen);
  } catch (err) {
    console.error('Error en getResumenDashboard:', err);
    return Respuesta.error(res, 'Error al obtener el resumen del dashboard.');
  }
}

async function getPerfilParqueadero(req, res) {
  try {
    const idUsuario = req.usuario.id_usuario;
    const perfil = await DashboardService.verificarAccesoParqueadero(idUsuario);
    if (!perfil) return Respuesta.error(res, 'No tienes acceso al módulo de parqueadero.', 403);
    return Respuesta.success(res, 'Perfil obtenido', perfil);
  } catch (err) {
    console.error('Error en getPerfilParqueadero:', err);
    return Respuesta.error(res, 'Error al obtener el perfil.');
  }
}

module.exports = { verificarTokenAcceso, generarCodigoAcceso, canjearCodigo, getResumenDashboard, getPerfilParqueadero };

/**
 * POST /parqueadero/auth/generar-codigo
 * Recibe el JWT del admin_app, lo verifica, comprueba acceso a PARQUEADERO,
 * y genera un código de acceso de un solo uso (TTL: 30 s).
 * El código se usa para que la app del parqueadero obtenga los datos sin
 * exponer el JWT en la URL.
 */
async function generarCodigoAcceso(req, res) {
  const { token, id_negocio } = req.body;
  if (!token) return Respuesta.error(res, 'Token requerido', 400);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const acceso  = await DashboardService.verificarAccesoParqueadero(decoded.id_usuario);
    if (!acceso) return Respuesta.error(res, 'No tienes acceso al módulo de parqueadero.', 403);

    // Verificar que el id_negocio solicitado pertenece al usuario
    if (id_negocio) {
      const tieneAcceso = acceso.negocios.some(n => n.id_negocio === parseInt(id_negocio, 10));
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
    console.error('Error en generarCodigoAcceso:', err);
    return Respuesta.error(res, 'Error al generar código de acceso.');
  }
}

/**
 * POST /parqueadero/auth/canjear-codigo
 * Canjea el código de un solo uso y devuelve los datos completos de acceso
 * (usuario, negocios, roles, niveles de permisos).
 */
async function canjearCodigo(req, res) {
  const { code } = req.body;
  if (!code) return Respuesta.error(res, 'Código requerido', 400);

  const entry = AccessCodeStore.consume(code);
  if (!entry) return Respuesta.error(res, 'Código inválido o expirado.', 401);

  try {
    const acceso = await DashboardService.verificarAccesoParqueadero(entry.idUsuario);
    if (!acceso) return Respuesta.error(res, 'Acceso revocado.', 403);

    // Establecer el negocio activo según la selección del admin_app
    if (entry.idNegocio) {
      const negocioSeleccionado = acceso.negocios.find(n => n.id_negocio === entry.idNegocio);
      if (negocioSeleccionado) {
        acceso.negocio = negocioSeleccionado;
        acceso.roles   = negocioSeleccionado.roles;
      }
    }

    const idNegocioActivo = entry.idNegocio || acceso.negocio?.id_negocio || null;
    acceso.plan_activo = idNegocioActivo ? await tienePlanActivo(idNegocioActivo) : false;

    return Respuesta.success(res, 'Acceso concedido', {
      token: entry.token,
      ...acceso,
    });
  } catch (err) {
    console.error('Error en canjearCodigo:', err);
    return Respuesta.error(res, 'Error al canjear código.');
  }
}
