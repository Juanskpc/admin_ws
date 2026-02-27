const { body, validationResult } = require('express-validator');
const PwResetService = require('../services/passwordResetService');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * resetPasswordController — POST /admin/auth/reset-password
 *
 * Verifica el OTP e, si es válido, actualiza la contraseña del usuario.
 */

/** Validaciones del body */
const resetPasswordValidators = [
    body('email')
        .isEmail().withMessage('Formato de email inválido')
        .normalizeEmail(),
    body('code')
        .notEmpty().withMessage('El código es requerido')
        .matches(/^\d{6}$/).withMessage('El código debe ser de 6 dígitos numéricos'),
    body('newPassword')
        .isLength({ min: 8 }).withMessage('La contraseña debe tener mínimo 8 caracteres')
        .matches(/(?=.*[A-Z])/).withMessage('Debe tener al menos una mayúscula')
        .matches(/(?=.*\d)/).withMessage('Debe tener al menos un número'),
];

/**
 * Handler principal.
 */
async function resetPassword(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
    }

    const { email, code, newPassword } = req.body;

    try {
        const result = await PwResetService.verifyAndReset(email, code, newPassword);

        if (!result.ok) {
            return Respuesta.error(res, result.error || 'Código inválido o expirado.', 400);
        }

        return Respuesta.success(res, 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.');
    } catch (err) {
        console.error('[ResetPassword] Error interno:', err.message);
        return Respuesta.error(res, 'Error al procesar la solicitud. Inténtalo de nuevo.');
    }
}

module.exports = { resetPassword, resetPasswordValidators };
