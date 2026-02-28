const Models = require('../models/conection');
const { Op } = require('sequelize');

/**
 * codigoVerificacionDao — Operaciones de base de datos para códigos de verificación OTP.
 *
 * Tabla: general.gener_codigo_verificacion
 * Soporta dos tipos: RESET_PASSWORD y REGISTRO.
 */

// ============================================================
// Operaciones genéricas (ambos tipos)
// ============================================================

/**
 * Crea un nuevo código de verificación.
 * @param {object} data
 * @param {string}  data.email      - Email destino
 * @param {string}  data.tokenHash  - Hash bcrypt del OTP
 * @param {Date}    data.expiresAt  - Fecha de expiración
 * @param {string}  data.tipo       - 'RESET_PASSWORD' | 'REGISTRO'
 * @param {number}  [data.idUsuario]  - ID del usuario (solo RESET_PASSWORD)
 * @param {number}  [data.idPlan]     - ID del plan (solo REGISTRO, opcional)
 */
function createCodigo(data) {
    return Models.GenerCodigoVerificacion.create({
        email:      data.email,
        token_hash: data.tokenHash,
        expires_at: data.expiresAt,
        tipo:       data.tipo,
        id_usuario: data.idUsuario || null,
        id_plan:    data.idPlan || null,
        used:       false,
        attempts:   0,
    });
}

/**
 * Busca el código activo (no usado, no expirado) más reciente por email y tipo.
 * @param {string} email
 * @param {string} tipo - 'RESET_PASSWORD' | 'REGISTRO'
 */
function findActiveByEmailAndTipo(email, tipo) {
    return Models.GenerCodigoVerificacion.findOne({
        where: {
            email: email.toLowerCase().trim(),
            tipo,
            used: false,
            expires_at: { [Op.gt]: new Date() },
        },
        order: [['created_at', 'DESC']],
    });
}

/**
 * Busca el código activo más reciente para un usuario (por id_usuario y tipo).
 * @param {number} idUsuario
 * @param {string} tipo
 */
function findActiveByUserIdAndTipo(idUsuario, tipo) {
    return Models.GenerCodigoVerificacion.findOne({
        where: {
            id_usuario: idUsuario,
            tipo,
            used: false,
            expires_at: { [Op.gt]: new Date() },
        },
        order: [['created_at', 'DESC']],
    });
}

/**
 * Incrementa el contador de intentos fallidos.
 * @param {bigint|number} id — ID del registro
 */
function incrementAttempts(id) {
    return Models.GenerCodigoVerificacion.increment('attempts', { where: { id } });
}

/**
 * Marca un código como usado (consumido).
 * @param {bigint|number} id — ID del registro
 */
function markUsed(id) {
    return Models.GenerCodigoVerificacion.update({ used: true }, { where: { id } });
}

/**
 * Invalida todos los códigos activos de un email y tipo dados.
 * @param {string} email
 * @param {string} tipo - 'RESET_PASSWORD' | 'REGISTRO'
 */
function invalidateAllForEmailAndTipo(email, tipo) {
    return Models.GenerCodigoVerificacion.update(
        { used: true },
        { where: { email: email.toLowerCase().trim(), tipo, used: false } },
    );
}

/**
 * Invalida todos los códigos activos de un usuario y tipo dados.
 * @param {number} idUsuario
 * @param {string} tipo
 */
function invalidateAllForUserAndTipo(idUsuario, tipo) {
    return Models.GenerCodigoVerificacion.update(
        { used: true },
        { where: { id_usuario: idUsuario, tipo, used: false } },
    );
}

/**
 * Elimina códigos expirados (mantenimiento). Puede llamarse periódicamente.
 */
function cleanupExpired() {
    return Models.GenerCodigoVerificacion.destroy({
        where: { expires_at: { [Op.lt]: new Date() } },
    });
}

module.exports = {
    createCodigo,
    findActiveByEmailAndTipo,
    findActiveByUserIdAndTipo,
    incrementAttempts,
    markUsed,
    invalidateAllForEmailAndTipo,
    invalidateAllForUserAndTipo,
    cleanupExpired,
};
