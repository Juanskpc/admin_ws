const { body, validationResult } = require('express-validator');
const PwResetService = require('../services/passwordResetService');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * forgotPasswordController — POST /admin/auth/forgot-password
 *
 * Genera un OTP y lo envía por correo al usuario.
 * SIEMPRE responde con el mismo mensaje genérico (anti-enumeration).
 */

/** Validaciones del body */
const forgotPasswordValidators = [
    body('email')
        .isEmail().withMessage('Formato de email inválido')
        .normalizeEmail(),
];

/**
 * Handler principal.
 * No revelar si el email existe o no (anti-enumeration).
 */
async function forgotPassword(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        // Respuesta genérica incluso en validación para no revelar información
        return res.status(200).json({
            success: true,
            message: 'Si existe una cuenta asociada a ese correo, hemos enviado un código para restablecer la contraseña.',
        });
    }

    const { email } = req.body;

    try {
        // createResetToken maneja internamente el caso de email inexistente
        await PwResetService.createResetToken(email);
    } catch (err) {
        // No exponer detalles del error al cliente
        console.error('[ForgotPassword] Error interno:', err.message);
        // Si es un error de configuración de correo y estamos en dev, continuar
        if (process.env.NODE_ENV !== 'production') {
            console.error('[ForgotPassword] Detalle:', err);
        }
    }

    // Respuesta genérica siempre igual (anti-enumeration)
    return res.status(200).json({
        success: true,
        message: 'Si existe una cuenta asociada a ese correo, hemos enviado un código para restablecer la contraseña.',
    });
}

module.exports = { forgotPassword, forgotPasswordValidators };
