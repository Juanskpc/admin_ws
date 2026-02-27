/**
 * passwordResetService.js — Lógica de negocio para recuperación de contraseña.
 *
 * Flujo:
 *   1. createResetToken(email)  → genera OTP, guarda hash, envía correo.
 *   2. verifyAndReset(email, code, newPassword) → verifica OTP, actualiza contraseña.
 *
 * Seguridad:
 *   - OTP de 6 dígitos generado con crypto.randomInt (CSPRNG).
 *   - Solo el hash bcrypt se almacena en BD; nunca el código en texto.
 *   - Anti-enumeration: siempre responde OK al solicitar reset.
 *   - Máx OTP_MAX_ATTEMPTS intentos fallidos antes de invalidar el token.
 *   - Expiración configurable con OTP_EXPIRES_MINUTES (default: 15).
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const Models        = require('../../app_core/models/conection');
const PwResetDao    = require('../../app_core/dao/passwordResetDao');
const MailService   = require('./mailService');

const BCRYPT_ROUNDS     = 10;
const EXPIRES_MINUTES   = parseInt(process.env.OTP_EXPIRES_MINUTES || '15', 10);
const MAX_ATTEMPTS      = parseInt(process.env.OTP_MAX_ATTEMPTS    || '5',  10);

// ============================================================
// Helpers
// ============================================================

/**
 * Genera un OTP de 6 dígitos numéricos con padding.
 * crypto.randomInt es criptográficamente seguro (CSPRNG).
 */
function generateOTP() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Hashea el OTP con bcrypt.
 * Se usa bcrypt (ya instalado) en lugar de argon2 para no agregar dependencias.
 */
async function hashOTP(otp) {
    return bcrypt.hash(otp, BCRYPT_ROUNDS);
}

/**
 * Busca un usuario activo por email (helper interno).
 * @param {string} email
 * @returns {Object|null}
 */
function findUserByEmail(email) {
    return Models.GenerUsuario.findOne({
        where: { email: email.toLowerCase().trim(), estado: 'A' },
        attributes: ['id_usuario', 'email', 'primer_nombre', 'primer_apellido'],
    });
}

// ============================================================
// API pública
// ============================================================

/**
 * Solicita un OTP de reset para el email dado.
 *
 * SIEMPRE responde sin revelar si el email existe (anti-enumeration).
 * Si el usuario existe: genera OTP, guarda hash, envía correo.
 * Si no existe: no hace nada (respuesta idéntica en ambos casos).
 *
 * @param {string} email - Email del usuario
 * @returns {Promise<void>}
 */
async function createResetToken(email) {
    const normalizedEmail = email.toLowerCase().trim();

    // Buscar usuario (si no existe, salir silenciosamente)
    const usuario = await findUserByEmail(normalizedEmail);
    if (!usuario) {
        // Anti-enumeration: log para monitorización pero sin revelar al cliente
        console.info(`[PasswordReset] Solicitud para email no registrado: ${normalizedEmail}`);
        return;
    }

    // Invalidar todos los tokens activos anteriores del usuario
    await PwResetDao.invalidateAllForUser(usuario.id_usuario);

    // Generar OTP y calcular expiración
    const otp       = generateOTP();
    const tokenHash = await hashOTP(otp);
    const expiresAt = new Date(Date.now() + EXPIRES_MINUTES * 60 * 1000);

    // Persistir hash (nunca el OTP en texto plano)
    await PwResetDao.createToken(usuario.id_usuario, tokenHash, expiresAt);

    // Construir URL opcional para el correo
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';
    const resetUrl    = `${frontendUrl}/auth/reset-password?email=${encodeURIComponent(normalizedEmail)}`;

    // Enviar correo (si MAIL_USER/MAIL_PASS no están configurados en dev,
    // mailService imprime el OTP en consola como fallback)
    const nombre = `${usuario.primer_nombre} ${usuario.primer_apellido}`;
    await MailService.sendPasswordResetEmail(normalizedEmail, nombre, otp, {
        expiresMinutes: EXPIRES_MINUTES,
        resetUrl,
    });

    // Log de monitorización (sin el OTP)
    console.info(`[PasswordReset] OTP enviado para id_usuario=${usuario.id_usuario}`);
}

/**
 * Verifica el OTP y actualiza la contraseña si es válido.
 *
 * @param {string} email       - Email del usuario
 * @param {string} code        - OTP introducido por el usuario
 * @param {string} newPassword - Nueva contraseña en texto plano
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function verifyAndReset(email, code, newPassword) {
    const normalizedEmail = email.toLowerCase().trim();

    // 1. Buscar usuario
    const usuario = await findUserByEmail(normalizedEmail);
    if (!usuario) {
        // Respuesta genérica para evitar enumeración
        return { ok: false, error: 'Código inválido o expirado.' };
    }

    // 2. Buscar token activo (no usado, no expirado)
    const tokenRecord = await PwResetDao.findActiveTokenByUserId(usuario.id_usuario);
    if (!tokenRecord) {
        return { ok: false, error: 'Código inválido o expirado.' };
    }

    // 3. Verificar límite de intentos
    if (tokenRecord.attempts >= MAX_ATTEMPTS) {
        await PwResetDao.markUsed(tokenRecord.id);
        console.warn(`[PasswordReset] Token agotado (max intentos) para id_usuario=${usuario.id_usuario}`);
        return { ok: false, error: `Superaste el máximo de ${MAX_ATTEMPTS} intentos. Solicita un nuevo código.` };
    }

    // 4. Comparar código con hash
    const isValid = await bcrypt.compare(String(code), tokenRecord.token_hash);
    if (!isValid) {
        await PwResetDao.incrementAttempts(tokenRecord.id);
        const remaining = MAX_ATTEMPTS - (tokenRecord.attempts + 1);
        return { ok: false, error: `Código incorrecto. ${remaining > 0 ? `Te quedan ${remaining} intentos.` : 'Token invalidado.'}` };
    }

    // 5. OTP válido → actualizar contraseña
    // El hook beforeUpdate del modelo GenerUsuario hashea automáticamente
    await Models.GenerUsuario.update(
        { password: newPassword },
        { where: { id_usuario: usuario.id_usuario }, individualHooks: true },
    );

    // 6. Marcar token como usado (single-use)
    await PwResetDao.markUsed(tokenRecord.id);

    console.info(`[PasswordReset] Contraseña actualizada para id_usuario=${usuario.id_usuario}`);
    return { ok: true };
}

module.exports = { createResetToken, verifyAndReset };
