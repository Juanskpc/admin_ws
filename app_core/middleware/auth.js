const jwt = require('jsonwebtoken');
const Respuesta = require('../helpers/respuesta');

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

module.exports = { verificarToken };
