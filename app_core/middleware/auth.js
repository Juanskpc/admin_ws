const jwt = require('jsonwebtoken');
const Respuesta = require('../helpers/respuesta');
const Models = require('../models/conection');

/** Descripción exacta del rol con acceso total. */
const SUPER_ADMIN_ROL = 'SUPER ADMINISTRADOR';

/**
 * Middleware para verificar el token JWT en las peticiones protegidas.
 * Extrae el token del header Authorization (formato: Bearer <token>).
 */
function verificarToken(req, res, next) {
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
        return Respuesta.error(res, 'Token de acceso requerido', 401);
    }

    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.usuario = decoded;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return Respuesta.error(res, 'El token ha expirado, inicie sesión nuevamente', 401);
        }
        return Respuesta.error(res, 'Token inválido', 401);
    }
}

/**
 * Middleware que restringe una ruta al rol SUPER ADMINISTRADOR.
 * Debe usarse DESPUÉS de verificarToken (necesita req.usuario.id_usuario).
 * Considera el rol tanto global como asignado a cualquier negocio.
 */
async function requireSuperAdmin(req, res, next) {
    try {
        const idUsuario = req.usuario?.id_usuario;
        if (!idUsuario) {
            return Respuesta.error(res, 'No autenticado', 401);
        }

        const [rows] = await Models.sequelize.query(
            `SELECT 1
               FROM general.gener_usuario_rol ur
               JOIN general.gener_rol r
                 ON r.id_rol = ur.id_rol
                AND r.estado = 'A'
              WHERE ur.id_usuario = :idUsuario
                AND ur.estado = 'A'
                AND UPPER(TRIM(r.descripcion)) = :rol
              LIMIT 1`,
            { replacements: { idUsuario, rol: SUPER_ADMIN_ROL } }
        );

        if (!rows || rows.length === 0) {
            return Respuesta.error(res, 'Acceso restringido a super administradores', 403);
        }

        next();
    } catch (err) {
        console.error('Error en requireSuperAdmin:', err);
        return Respuesta.error(res, 'Error al verificar permisos', 500);
    }
}

module.exports = { verificarToken, requireSuperAdmin };
