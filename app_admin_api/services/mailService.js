/**
 * mailService.js — Envío de correos transaccionales con nodemailer.
 *
 * Configuración via .env:
 *   MAIL_HOST      → Servidor SMTP (ej: smtp.gmail.com)
 *   MAIL_PORT      → Puerto SMTP (587 para TLS, 465 para SSL)
 *   MAIL_SECURE    → 'true' si puerto 465 (SSL); 'false' para STARTTLS
 *   MAIL_USER      → Usuario SMTP (tu correo)
 *   MAIL_PASS      → Contraseña o App Password (Gmail)
 *   MAIL_FROM      → Remitente (ej: "Admin App <noreply@miapp.com>")
 *   FRONTEND_URL   → URL base del frontend (ej: http://localhost:4200)
 *
 * Para Gmail: habilitar "Contraseñas de aplicación" en la cuenta Google
 *   y usar esa contraseña en MAIL_PASS.
 * Para producción: considera SendGrid, AWS SES o Resend como alternativas.
 */

const nodemailer = require('nodemailer');

// ============================================================
// Configuración del transporte SMTP
// ============================================================
const transporter = nodemailer.createTransport({
    host:   process.env.MAIL_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.MAIL_PORT || '587', 10),
    secure: process.env.MAIL_SECURE === 'true', // true = 465, false = STARTTLS
    auth: {
        user: process.env.MAIL_USER || '',
        pass: process.env.MAIL_PASS || '',
    },
    // Timeout para evitar bloqueos en entornos sin conexión
    connectionTimeout: 5000,
    greetingTimeout:   3000,
});

// ============================================================
// Plantilla HTML del correo de OTP
// ============================================================

/**
 * @param {string} nombre         - Nombre del usuario
 * @param {string} otp            - Código OTP de 6 dígitos
 * @param {number} expiresMinutes - Minutos hasta expiración
 * @param {string} resetUrl       - URL directa al formulario de reset (opcional)
 */
function buildResetEmailHtml(nombre, otp, expiresMinutes, resetUrl) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>Recuperar contraseña</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; margin: 0; padding: 0; }
    .container { max-width: 480px; margin: 40px auto; background: #fff; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,.08); overflow: hidden; }
    .header { background: #1565c0; color: #fff; padding: 28px 32px; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 700; }
    .body { padding: 32px; }
    .otp-box { text-align: center; background: #f0f4ff; border: 2px dashed #1565c0; border-radius: 8px; padding: 20px; margin: 24px 0; }
    .otp-code { font-size: 40px; font-weight: 700; letter-spacing: 10px; color: #1565c0; font-family: 'Courier New', monospace; }
    .otp-expires { font-size: 13px; color: #616161; margin-top: 8px; }
    .btn { display: inline-block; background: #1565c0; color: #fff !important; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; font-size: 14px; margin: 8px 0; }
    .warning { font-size: 12px; color: #9e9e9e; border-top: 1px solid #e0e0e0; margin-top: 24px; padding-top: 16px; }
    p { color: #424242; font-size: 15px; line-height: 1.6; margin: 0 0 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔐 Recuperar contraseña</h1>
    </div>
    <div class="body">
      <p>Hola, <strong>${nombre}</strong>.</p>
      <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta. Usa el siguiente código de un solo uso:</p>

      <div class="otp-box">
        <div class="otp-code">${otp}</div>
        <div class="otp-expires">⏱ Válido por <strong>${expiresMinutes} minutos</strong></div>
      </div>

      ${resetUrl ? `<p style="text-align:center"><a class="btn" href="${resetUrl}">Ir al formulario de restablecimiento</a></p>` : ''}

      <p>Si no solicitaste este código, ignora este mensaje. Tu contraseña <strong>no será cambiada</strong> a menos que ingreses este código.</p>

      <div class="warning">
        <strong>⚠️ Seguridad:</strong> Nunca compartiremos este código con nadie. Si alguien te lo pide, es un intento de fraude.
        Revisa también tu carpeta de <strong>spam</strong> si no lo encuentras.
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Versión de texto plano del correo (para clientes sin HTML).
 */
function buildResetEmailText(nombre, otp, expiresMinutes) {
    return `
Hola, ${nombre}.

Tu código para restablecer la contraseña es:

  ${otp}

Válido por ${expiresMinutes} minutos.

Si no solicitaste este código, ignora este mensaje.
`.trim();
}

// ============================================================
// API pública
// ============================================================

/**
 * Envía el correo de recuperación de contraseña con el OTP.
 *
 * @param {string} email          - Destinatario
 * @param {string} nombre         - Nombre del usuario (para personalizar)
 * @param {string} otp            - Código OTP en texto plano (solo para envío)
 * @param {object} [opts]         - Opciones adicionales
 * @param {number} [opts.expiresMinutes=15] - Minutos de expiración
 * @param {string} [opts.resetUrl]          - URL directa al formulario
 * @returns {Promise<void>}
 */
async function sendPasswordResetEmail(email, nombre, otp, opts = {}) {
    const expiresMinutes = opts.expiresMinutes ?? 15;
    const resetUrl       = opts.resetUrl       ?? '';
    const from           = process.env.MAIL_FROM || '"Admin App" <noreply@adminapp.com>';

    // Verificación de configuración mínima en desarrollo
    if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
        // En dev sin SMTP configurado, mostrar OTP en consola como alternativa
        if (process.env.NODE_ENV !== 'production') {
            console.warn('⚠️  MAIL_USER/MAIL_PASS no configurados. OTP (solo dev):', otp);
            return; // No lanzar error en dev para no romper el flujo
        }
        throw new Error('Configuración de correo incompleta (MAIL_USER / MAIL_PASS)');
    }

    const info = await transporter.sendMail({
        from,
        to:      email,
        subject: '🔐 Tu código para restablecer contraseña',
        text:    buildResetEmailText(nombre, otp, expiresMinutes),
        html:    buildResetEmailHtml(nombre, otp, expiresMinutes, resetUrl),
    });

    console.info(`✉️  Correo enviado a ${email} — messageId: ${info.messageId}`);
}

module.exports = { sendPasswordResetEmail };
