const Models = require('../models/conection');
const { Op } = require('sequelize');

/**
 * passwordResetDao — Operaciones de base de datos para tokens OTP.
 *
 * Tabla: general.password_reset_tokens
 */

/**
 * Crea un nuevo token de reset.
 * Antes de llamar a esta función, invalida los tokens anteriores con invalidateAllForUser().
 */
function createToken(idUsuario, tokenHash, expiresAt) {
    return Models.PasswordResetToken.create({
        id_usuario: idUsuario,
        token_hash: tokenHash,
        expires_at: expiresAt,
        used: false,
        attempts: 0,
    });
}

/**
 * Busca el token activo (no usado, no expirado) más reciente para un usuario.
 * @param {number} idUsuario
 */
function findActiveTokenByUserId(idUsuario) {
    return Models.PasswordResetToken.findOne({
        where: {
            id_usuario: idUsuario,
            used: false,
            expires_at: { [Op.gt]: new Date() },
        },
        order: [['created_at', 'DESC']],
    });
}

/**
 * Incrementa el contador de intentos fallidos para un token.
 * @param {bigint|number} id — ID del token
 */
function incrementAttempts(id) {
    return Models.PasswordResetToken.increment('attempts', { where: { id } });
}

/**
 * Marca un token como usado (consumido).
 * @param {bigint|number} id — ID del token
 */
function markUsed(id) {
    return Models.PasswordResetToken.update({ used: true }, { where: { id } });
}

/**
 * Invalida todos los tokens activos de un usuario.
 * Útil para garantizar un solo token válido por usuario a la vez.
 * @param {number} idUsuario
 */
function invalidateAllForUser(idUsuario) {
    return Models.PasswordResetToken.update(
        { used: true },
        { where: { id_usuario: idUsuario, used: false } },
    );
}

/**
 * Elimina tokens expirados (mantenimiento). Puede llamarse periódicamente.
 */
function cleanupExpired() {
    return Models.PasswordResetToken.destroy({
        where: { expires_at: { [Op.lt]: new Date() } },
    });
}

module.exports = {
    createToken,
    findActiveTokenByUserId,
    incrementAttempts,
    markUsed,
    invalidateAllForUser,
    cleanupExpired,
};
