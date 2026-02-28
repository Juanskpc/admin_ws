const { body, validationResult } = require('express-validator');
const RegistroVerifService = require('../services/registroVerificacionService');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * registroVerificacionController — Endpoints para verificación de email
 * en el flujo de registro desde la landing page.
 *
 *   POST /auth/registro/enviar-codigo   → Genera y envía OTP al email
 *   POST /auth/registro/verificar-codigo → Verifica el OTP
 */

// ============================================================
// Enviar código de verificación
// ============================================================

/** Validaciones: enviar código */
const enviarCodigoValidators = [
    body('email')
        .isEmail().withMessage('Formato de email inválido')
        .normalizeEmail(),
    body('id_plan')
        .optional()
        .isInt({ min: 1 }).withMessage('ID de plan inválido'),
];

/**
 * POST /auth/registro/enviar-codigo
 * Body: { email, id_plan? }
 */
async function enviarCodigo(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
    }

    const { email, id_plan } = req.body;

    try {
        const result = await RegistroVerifService.sendRegistroCode(email, id_plan);

        if (!result.ok) {
            return Respuesta.error(res, result.error, 400);
        }

        return Respuesta.success(res, 'Hemos enviado un código de verificación a tu correo electrónico.');
    } catch (err) {
        console.error('[RegistroVerificacion] Error al enviar código:', err.message);
        if (process.env.NODE_ENV !== 'production') {
            console.error('[RegistroVerificacion] Detalle:', err);
        }
        return Respuesta.error(res, 'Error al enviar el código. Inténtalo de nuevo.');
    }
}

// ============================================================
// Verificar código
// ============================================================

/** Validaciones: verificar código */
const verificarCodigoValidators = [
    body('email')
        .isEmail().withMessage('Formato de email inválido')
        .normalizeEmail(),
    body('code')
        .notEmpty().withMessage('El código es requerido')
        .matches(/^\d{6}$/).withMessage('El código debe ser de 6 dígitos numéricos'),
];

/**
 * POST /auth/registro/verificar-codigo
 * Body: { email, code }
 * Response: { success, message, data: { id_plan } }
 */
async function verificarCodigo(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
    }

    const { email, code } = req.body;

    try {
        const result = await RegistroVerifService.verifyRegistroCode(email, code);

        if (!result.ok) {
            return Respuesta.error(res, result.error, 400);
        }

        return res.status(200).json({
            success: true,
            message: 'Código verificado correctamente. Puedes continuar con el registro.',
            data: {
                email,
                id_plan: result.idPlan,
                verificado: true,
            },
        });
    } catch (err) {
        console.error('[RegistroVerificacion] Error al verificar código:', err.message);
        return Respuesta.error(res, 'Error al verificar el código. Inténtalo de nuevo.');
    }
}

module.exports = {
    enviarCodigo,
    enviarCodigoValidators,
    verificarCodigo,
    verificarCodigoValidators,
};
