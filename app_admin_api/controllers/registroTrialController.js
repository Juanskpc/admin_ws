/**
 * registroTrialController.js
 *
 * POST /auth/registro/prueba/verificar
 *   Verifica el OTP y, si es válido, crea automáticamente la cuenta trial:
 *   usuario con cédula como contraseña temporal + sucursal + plan 7 días.
 */

const { body, validationResult } = require('express-validator');
const RegistroTrialService = require('../services/registroTrialService');
const Respuesta = require('../../app_core/helpers/respuesta');

const verificarYCrearValidators = [
    body('email')
        .isEmail().withMessage('Formato de email inválido')
        .normalizeEmail(),
    body('code')
        .notEmpty().withMessage('El código es requerido')
        .matches(/^\d{6}$/).withMessage('El código debe ser de 6 dígitos numéricos'),
];

async function verificarYCrear(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
    }

    const { email, code } = req.body;

    try {
        const result = await RegistroTrialService.verificarYCrearCuentaTrial(email, code);

        if (!result.ok) {
            return Respuesta.error(res, result.error, 400);
        }

        return Respuesta.success(res,
            '¡Cuenta creada exitosamente! Revisa tu correo para ver tus credenciales de acceso.',
            result.data,
            201,
        );
    } catch (err) {
        console.error('[RegistroTrial] Error inesperado:', err.message);
        return Respuesta.error(res, 'Error al crear la cuenta. Inténtalo de nuevo más tarde.');
    }
}

module.exports = { verificarYCrear, verificarYCrearValidators };
