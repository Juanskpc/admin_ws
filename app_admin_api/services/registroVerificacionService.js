/**
 * registroVerificacionService.js — Lógica de negocio para verificación de email
 * en el flujo de registro (landing page).
 *
 * Flujo:
 *   1. sendRegistroCode(email, idPlan) → genera OTP, guarda hash, envía correo.
 *   2. verifyRegistroCode(email, code) → verifica OTP, retorna {ok, idPlan}.
 *
 * El usuario aún NO tiene cuenta. Se envía un código a su email para validar
 * que sea real antes de permitirle llenar el formulario de creación.
 *
 * Tabla: general.gener_codigo_verificacion (tipo = 'REGISTRO')
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const Models          = require('../../app_core/models/conection');
const CodigoVerifDao  = require('../../app_core/dao/codigoVerificacionDao');
const MailService     = require('./mailService');

const TIPO = 'REGISTRO';

const BCRYPT_ROUNDS     = 10;
const EXPIRES_MINUTES   = parseInt(process.env.OTP_EXPIRES_MINUTES || '15', 10);
const MAX_ATTEMPTS      = parseInt(process.env.OTP_MAX_ATTEMPTS    || '5',  10);

// ============================================================
// Helpers
// ============================================================

/** Genera un OTP de 6 dígitos numéricos con CSPRNG. */
function generateOTP() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Hashea el OTP con bcrypt. */
async function hashOTP(otp) {
    return bcrypt.hash(otp, BCRYPT_ROUNDS);
}

// ============================================================
// API pública
// ============================================================

/**
 * Genera un OTP de registro y lo envía al email proporcionado.
 *
 * @param {string} email  - Email de la persona interesada (aún sin cuenta)
 * @param {number} [idPlan] - ID del plan seleccionado (opcional)
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function sendRegistroCode(email, idPlan) {
    const normalizedEmail = email.toLowerCase().trim();

    // Verificar que el email no esté ya registrado
    const existingUser = await Models.GenerUsuario.findOne({
        where: { email: normalizedEmail },
        attributes: ['id_usuario'],
    });

    if (existingUser) {
        return { ok: false, error: 'Este correo ya se encuentra registrado. Inicia sesión o recupera tu contraseña.' };
    }

    // Verificar que el plan exista (si se proporcionó)
    if (idPlan) {
        const plan = await Models.GenerPlan.findOne({
            where: { id_plan: idPlan, estado: 'A' },
            attributes: ['id_plan', 'nombre'],
        });
        if (!plan) {
            return { ok: false, error: 'El plan seleccionado no existe o no está activo.' };
        }
    }

    // Invalidar códigos anteriores para este email y tipo REGISTRO
    await CodigoVerifDao.invalidateAllForEmailAndTipo(normalizedEmail, TIPO);

    // Generar OTP y calcular expiración
    const otp       = generateOTP();
    const tokenHash = await hashOTP(otp);
    const expiresAt = new Date(Date.now() + EXPIRES_MINUTES * 60 * 1000);

    // Persistir hash
    await CodigoVerifDao.createCodigo({
        email:     normalizedEmail,
        tokenHash,
        expiresAt,
        tipo:      TIPO,
        idPlan:    idPlan || null,
    });

    // Enviar correo
    await MailService.sendRegistroVerificationEmail(normalizedEmail, otp, {
        expiresMinutes: EXPIRES_MINUTES,
    });

    console.info(`[RegistroVerificacion] OTP enviado a ${normalizedEmail}`);
    return { ok: true };
}

/**
 * Verifica el OTP de registro.
 *
 * @param {string} email - Email de la persona
 * @param {string} code  - OTP de 6 dígitos
 * @returns {Promise<{ ok: boolean, idPlan?: number, error?: string }>}
 */
async function verifyRegistroCode(email, code) {
    const normalizedEmail = email.toLowerCase().trim();

    // 1. Buscar código activo por email y tipo REGISTRO
    const tokenRecord = await CodigoVerifDao.findActiveByEmailAndTipo(normalizedEmail, TIPO);
    if (!tokenRecord) {
        return { ok: false, error: 'Código inválido o expirado.' };
    }

    // 2. Verificar límite de intentos
    if (tokenRecord.attempts >= MAX_ATTEMPTS) {
        await CodigoVerifDao.markUsed(tokenRecord.id);
        console.warn(`[RegistroVerificacion] Código agotado (max intentos) para email=${normalizedEmail}`);
        return { ok: false, error: `Superaste el máximo de ${MAX_ATTEMPTS} intentos. Solicita un nuevo código.` };
    }

    // 3. Comparar código con hash
    const isValid = await bcrypt.compare(String(code), tokenRecord.token_hash);
    if (!isValid) {
        await CodigoVerifDao.incrementAttempts(tokenRecord.id);
        const remaining = MAX_ATTEMPTS - (tokenRecord.attempts + 1);
        return {
            ok: false,
            error: `Código incorrecto. ${remaining > 0 ? `Te quedan ${remaining} intentos.` : 'Código invalidado.'}`,
        };
    }

    // 4. Código válido → marcar como usado
    await CodigoVerifDao.markUsed(tokenRecord.id);

    console.info(`[RegistroVerificacion] Email verificado: ${normalizedEmail}`);
    return {
        ok: true,
        idPlan: tokenRecord.id_plan || null,
    };
}

module.exports = { sendRegistroCode, verifyRegistroCode };
