'use strict';

const { body, validationResult } = require('express-validator');
const PwResetService = require('../services/passwordResetService');
const Respuesta = require('../../app_core/helpers/respuesta');

// ──────────────────────────────────────────────────────────────────────────────
// Validators
// ──────────────────────────────────────────────────────────────────────────────
const verifyOtpValidators = [
    body('email')
        .isEmail().withMessage('Email inválido.')
        .normalizeEmail(),
    body('code')
        .matches(/^\d{6}$/).withMessage('El código debe ser exactamente 6 dígitos numéricos.'),
];

// ──────────────────────────────────────────────────────────────────────────────
// Controller
// ──────────────────────────────────────────────────────────────────────────────
async function verifyOtp(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos inválidos.', 400, errors.array());
    }

    const { email, code } = req.body;

    try {
        const result = await PwResetService.verifyOTPOnly(email, code);
        if (!result.ok) {
            return Respuesta.error(res, result.error, 400);
        }
        return Respuesta.success(res, 'Código verificado correctamente.');
    } catch (err) {
        console.error('[VerifyOtp] Error inesperado:', err.message);
        return Respuesta.error(res, 'Error al verificar el código.', 500);
    }
}

module.exports = { verifyOtp, verifyOtpValidators };
