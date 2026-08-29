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

/**
 * A qué negocios puede mirar este usuario.
 *
 * Existe para la Bandeja, y su razón de ser es que **el `id_negocio` que llega en la petición no
 * se puede creer**. La Consola de super admin lo acepta tal cual porque quien la usa ya lo ve
 * todo; en cuanto la misma pantalla se abre a un inquilino, ese parámetro pasa a ser la frontera
 * entre dos clientes. F2 ya cerró una fuga real entre negocios: aquí se decide desde la base, no
 * desde lo que mande el navegador.
 *
 * Un super admin devuelve `superAdmin: true` y **no** una lista: no es que pueda ver muchos
 * negocios, es que la pregunta no le aplica. Distinguirlo de "puede ver estos 300" evita que
 * alguien tenga que mantener sincronizada una lista que crece con cada cliente.
 *
 * @returns {Promise<{superAdmin: boolean, idNegocios: number[]}>}
 */
async function alcanceDeNegocios(idUsuario) {
    const rolesSuper = await Models.sequelize.query(
        `SELECT 1
           FROM general.gener_usuario_rol ur
           JOIN general.gener_rol r ON r.id_rol = ur.id_rol AND r.estado = 'A'
          WHERE ur.id_usuario = :idUsuario
            AND ur.estado = 'A'
            AND UPPER(TRIM(r.descripcion)) = :rol
          LIMIT 1`,
        { replacements: { idUsuario, rol: SUPER_ADMIN_ROL }, type: Models.sequelize.QueryTypes.SELECT }
    );
    if (rolesSuper.length > 0) return { superAdmin: true, idNegocios: [] };

    const filas = await Models.sequelize.query(
        `SELECT nu.id_negocio
           FROM general.gener_negocio_usuario nu
           JOIN general.gener_negocio n ON n.id_negocio = nu.id_negocio AND n.estado = 'A'
          WHERE nu.id_usuario = :idUsuario AND nu.estado = 'A'`,
        { replacements: { idUsuario }, type: Models.sequelize.QueryTypes.SELECT }
    );
    return { superAdmin: false, idNegocios: filas.map((f) => Number(f.id_negocio)) };
}

module.exports = { verificarToken, requireSuperAdmin, alcanceDeNegocios };
