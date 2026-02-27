const Respuesta = require('../helpers/respuesta');

/**
 * Middleware global para manejo de errores no controlados.
 * Captura cualquier error que no haya sido manejado en los controladores.
 */
function errorHandler(err, req, res, next) {
    console.error('Error no controlado:', err);

    const statusCode = err.statusCode || 500;
    const message = process.env.NODE_ENV === 'production'
        ? 'Error interno del servidor'
        : err.message || 'Error interno del servidor';

    return Respuesta.error(res, message, statusCode);
}

/**
 * Middleware para rutas no encontradas (404).
 */
function notFound(req, res) {
    return Respuesta.error(res, `Ruta no encontrada: ${req.method} ${req.originalUrl}`, 404);
}

module.exports = { errorHandler, notFound };
