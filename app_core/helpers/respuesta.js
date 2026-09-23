/**
 * Envía una respuesta exitosa en formato JSON estandarizado.
 * @param {Object} res - Objeto de respuesta de Express
 * @param {string} message - Mensaje descriptivo
 * @param {*} data - Datos a enviar (opcional)
 * @param {number} statusCode - Código HTTP (default: 200)
 */
function success(res, message, data = null, statusCode = 200) {
    const response = { success: true, message };
    if (data !== null) response.data = data;
    return res.status(statusCode).json(response);
}

/**
 * Envía una respuesta de error en formato JSON estandarizado.
 * @param {Object} res - Objeto de respuesta de Express
 * @param {string} message - Mensaje de error
 * @param {number} statusCode - Código HTTP (default: 500)
 * @param {*} errors - Detalle de errores de validación (opcional)
 * @param {{code?: string, data?: *}} [extra] - `code` (enum-like) y `data` para errores de dominio
 *        que necesitan devolver algo accionable (p. ej. la lista de usuarios que bloquean un borrado)
 */
function error(res, message, statusCode = 500, errors = null, extra = null) {
    const response = { success: false, message };
    if (errors) response.errors = errors;
    if (extra?.code) response.code = extra.code;
    if (extra?.data != null) response.data = extra.data;
    return res.status(statusCode).json(response);
}

/**
 * Compatibilidad con el formato anterior.
 * @deprecated Usar success() o error() en su lugar.
 */
function sendJsonResponse(res, status, content) {
    return res.status(status).json(content);
}

module.exports = { success, error, sendJsonResponse };
