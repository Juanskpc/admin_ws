/**
 * mailService.js — Envío de correos transaccionales con nodemailer.
 *
 * Configuración via .env:
 *   MAIL_HOST      → Servidor SMTP (ej: smtp.gmail.com)
 *   MAIL_PORT      → Puerto SMTP (587 para TLS, 465 para SSL)
 *   MAIL_SECURE    → 'true' si puerto 465 (SSL); 'false' para STARTTLS
 *   MAIL_USER      → Usuario SMTP (tu correo)
 *   MAIL_PASS      → Contraseña o App Password (Gmail)
 *   MAIL_FROM      → Remitente (ej: "EscalApp <correo@gmail.com>")
 *   FRONTEND_URL   → URL base del frontend (ej: http://localhost:4200)
 *
 * Para Gmail: habilitar "Contraseñas de aplicación" en la cuenta Google
 *   y usar esa contraseña en MAIL_PASS.
 * Para producción: considera SendGrid, AWS SES o Resend como alternativas.
 */

const nodemailer = require('nodemailer');
const path        = require('path');
const fs          = require('fs');

// Ruta absoluta al logo (en el proyecto frontend)
const LOGO_PATH = path.resolve(__dirname, '../../../admin_app-v21/public/images/escalapplogo.png');

// ============================================================
// Configuración del transporte SMTP
// ============================================================
const transporter = nodemailer.createTransport({
    host:   process.env.MAIL_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.MAIL_PORT || '587', 10),
    secure: process.env.MAIL_SECURE === 'true',
    auth: {
        user: process.env.MAIL_USER || '',
        pass: process.env.MAIL_PASS || '',
    },
    connectionTimeout: 5000,
    greetingTimeout:   3000,
});

// ============================================================
// Plantilla HTML del correo de OTP — Branding EscalApp
// ============================================================

/**
 * @param {string} nombre         - Nombre del usuario
 * @param {string} otp            - Código OTP de 6 dígitos
 * @param {number} expiresMinutes - Minutos hasta expiración
 * @param {string} resetUrl       - URL directa al formulario de reset (opcional)
 * @param {string} logoUrl        - URL pública del logo
 */
function buildResetEmailHtml(nombre, otp, expiresMinutes, resetUrl, logoUrl) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>Recuperar contraseña · EscalApp</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; margin: 0; padding: 0; }
    .wrapper { padding: 40px 16px; }
    .container { max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.08); overflow: hidden; }
    .header { background: #0d1b2a; padding: 28px 32px; text-align: center; }
    .header img { max-height: 52px; width: auto; display: inline-block; }
    .header-title { color: #ffffff; font-size: 13px; letter-spacing: 1px; text-transform: uppercase; margin: 10px 0 0; opacity: .7; }
    .body { padding: 36px 32px; }
    .greeting { font-size: 16px; color: #1a1a2e; font-weight: 600; margin: 0 0 8px; }
    .body p { color: #4a5568; font-size: 14px; line-height: 1.7; margin: 0 0 16px; }
    .otp-box { text-align: center; background: #f7f9ff; border: 2px dashed #4361ee; border-radius: 10px; padding: 24px 20px; margin: 24px 0; }
    .otp-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #718096; margin: 0 0 10px; font-weight: 600; }
    .otp-code { font-size: 44px; font-weight: 800; letter-spacing: 12px; color: #4361ee; font-family: 'Courier New', monospace; line-height: 1; }
    .otp-expires { font-size: 12px; color: #a0aec0; margin-top: 10px; }
    .btn-wrap { text-align: center; margin: 8px 0 24px; }
    .btn { display: inline-block; background: #4361ee; color: #ffffff !important; text-decoration: none; padding: 13px 32px; border-radius: 8px; font-weight: 700; font-size: 14px; }
    .divider { border: none; border-top: 1px solid #e8ecf0; margin: 24px 0; }
    .tips { background: #fffbeb; border-left: 4px solid #f6ad55; border-radius: 6px; padding: 14px 16px; margin-bottom: 20px; }
    .tips p { font-size: 13px; color: #744210; margin: 0; line-height: 1.6; }
    .warning { font-size: 12px; color: #a0aec0; line-height: 1.6; }
    .footer { background: #f7f9ff; padding: 18px 32px; text-align: center; }
    .footer p { font-size: 11px; color: #a0aec0; margin: 0; line-height: 1.6; }
    .footer strong { color: #718096; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">

      <!-- Header con logo -->
      <div class="header">
        ${logoUrl
            ? `<img src="${logoUrl}" alt="EscalApp" />`
            : `<span style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:1px;">EscalApp</span>`
        }
        <p class="header-title">Recuperación de contraseña</p>
      </div>

      <!-- Cuerpo -->
      <div class="body">
        <p class="greeting">Hola, ${nombre} 👋</p>
        <p>
          Recibimos una solicitud para restablecer la contraseña de tu cuenta en
          <strong>EscalApp</strong>. Usa el siguiente código de verificación de un solo uso:
        </p>

        <div class="otp-box">
          <p class="otp-label">Código de verificación</p>
          <div class="otp-code">${otp}</div>
          <p class="otp-expires">⏱ Válido por <strong>${expiresMinutes} minutos</strong></p>
        </div>

        ${resetUrl
            ? `<div class="btn-wrap"><a class="btn" href="${resetUrl}">Ir al formulario →</a></div>`
            : ''
        }

        <div class="tips">
          <p>
            📌 <strong>Recuerda:</strong> el código tiene 6 dígitos y expira en ${expiresMinutes} minutos.
            Si no lo ves en tu bandeja principal, revisa <strong>Spam o Correo no deseado</strong>.
            Tienes máximo <strong>5 intentos</strong> antes de que el código sea invalidado.
          </p>
        </div>

        <hr class="divider" />
        <p class="warning">
          Si tú no solicitaste este cambio, puedes ignorar este correo con seguridad.
          Tu contraseña <strong>no cambiará</strong> a menos que ingreses este código.
          Nunca compartiremos este código con nadie. Si alguien te lo solicita, podría ser un intento de fraude.
        </p>
      </div>

      <!-- Footer -->
      <div class="footer">
        <p>
          © ${new Date().getFullYear()} <strong>EscalApp</strong> · Todos los derechos reservados<br />
          Este correo fue generado automáticamente, por favor no respondas a este mensaje.
        </p>
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
EscalApp — Recuperación de contraseña
======================================

Hola, ${nombre}.

Tu código para restablecer la contraseña es:

  ${otp}

Válido por ${expiresMinutes} minutos. Máximo 5 intentos.

Si no solicitaste este código, ignora este mensaje.
Tu contraseña no cambiará a menos que uses este código.

© ${new Date().getFullYear()} EscalApp
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
    const from           = process.env.MAIL_FROM || '"EscalApp" <escalappsystem@gmail.com>';
    // En desarrollo sin SMTP configurado → imprimir OTP en consola
    if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn('⚠️  MAIL_USER/MAIL_PASS no configurados. OTP (solo dev):', otp);
            return;
        }
        throw new Error('Configuración de correo incompleta (MAIL_USER / MAIL_PASS)');
    }

    // Logo como adjunto CID (funciona en todos los clientes de correo)
    const attachments = [];
    let   logoSrc     = '';
    if (fs.existsSync(LOGO_PATH)) {
        attachments.push({ filename: 'escalapplogo.png', path: LOGO_PATH, cid: 'escalapplogo' });
        logoSrc = 'cid:escalapplogo';
    }

    const info = await transporter.sendMail({
        from,
        to:          email,
        subject:     `Tu código EscalApp es: ${otp}`,
        text:        buildResetEmailText(nombre, otp, expiresMinutes),
        html:        buildResetEmailHtml(nombre, otp, expiresMinutes, resetUrl, logoSrc),
        attachments,
    });

    console.info(`✉️  Correo enviado a ${email} — messageId: ${info.messageId}`);
}

/**
 * Verifica la conexión SMTP al iniciar el servidor (opcional).
 * Llama desde app.js en development para confirmar credenciales.
 */
async function verifyTransport() {
    try {
        await transporter.verify();
        console.info('✉️  SMTP OK — Conexión con', process.env.MAIL_HOST, 'verificada');
    } catch (err) {
        if (err.message.includes('BadCredentials') || err.message.includes('535')) {
            console.error('❌ SMTP: Credenciales inválidas. Gmail requiere una "Contraseña de aplicación".');
            console.error('   → myaccount.google.com/security → Verificación 2 pasos → Contraseñas de aplicación');
        } else {
            console.warn('⚠️  SMTP: No se pudo verificar el transporte:', err.message);
        }
    }
}

// ============================================================
// Correo de verificación para registro de prueba (Trial)
// ============================================================

function buildRegistroVerifHtml(otp, expiresMinutes, logoUrl) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>Verifica tu correo · EscalApp</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; margin: 0; padding: 0; }
    .wrapper { padding: 40px 16px; }
    .container { max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.08); overflow: hidden; }
    .header { background: #0d1b2a; padding: 28px 32px; text-align: center; }
    .header img { max-height: 52px; width: auto; display: inline-block; }
    .header-title { color: #ffffff; font-size: 13px; letter-spacing: 1px; text-transform: uppercase; margin: 10px 0 0; opacity: .7; }
    .body { padding: 36px 32px; }
    .greeting { font-size: 16px; color: #1a1a2e; font-weight: 600; margin: 0 0 8px; }
    .body p { color: #4a5568; font-size: 14px; line-height: 1.7; margin: 0 0 16px; }
    .otp-box { text-align: center; background: #f7f9ff; border: 2px dashed #4361ee; border-radius: 10px; padding: 24px 20px; margin: 24px 0; }
    .otp-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #718096; margin: 0 0 10px; font-weight: 600; }
    .otp-code { font-size: 44px; font-weight: 800; letter-spacing: 12px; color: #4361ee; font-family: 'Courier New', monospace; line-height: 1; }
    .otp-expires { font-size: 12px; color: #a0aec0; margin-top: 10px; }
    .tips { background: #f0fff4; border-left: 4px solid #48bb78; border-radius: 6px; padding: 14px 16px; margin-bottom: 20px; }
    .tips p { font-size: 13px; color: #276749; margin: 0; line-height: 1.6; }
    .divider { border: none; border-top: 1px solid #e8ecf0; margin: 24px 0; }
    .warning { font-size: 12px; color: #a0aec0; line-height: 1.6; }
    .footer { background: #f7f9ff; padding: 18px 32px; text-align: center; }
    .footer p { font-size: 11px; color: #a0aec0; margin: 0; line-height: 1.6; }
    .footer strong { color: #718096; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        ${logoUrl
            ? `<img src="${logoUrl}" alt="EscalApp" />`
            : `<span style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:1px;">EscalApp</span>`
        }
        <p class="header-title">Verifica tu correo electrónico</p>
      </div>
      <div class="body">
        <p class="greeting">¡Casi listo para tu prueba gratuita!</p>
        <p>
          Ingresa el siguiente código en la página de registro para confirmar tu correo
          y crear tu cuenta en <strong>EscalApp</strong>.
        </p>
        <div class="otp-box">
          <p class="otp-label">Código de verificación</p>
          <div class="otp-code">${otp}</div>
          <p class="otp-expires">⏱ Válido por <strong>${expiresMinutes} minutos</strong></p>
        </div>
        <div class="tips">
          <p>
            ✅ Una vez verificado, tu cuenta se crea automáticamente.<br />
            Tu usuario y contraseña temporal serán tu número de cédula.
          </p>
        </div>
        <hr class="divider" />
        <p class="warning">
          Si no solicitaste este registro, puedes ignorar este correo con seguridad.
          Nunca compartas este código con nadie.
        </p>
      </div>
      <div class="footer">
        <p>
          © ${new Date().getFullYear()} <strong>EscalApp</strong> · Todos los derechos reservados<br />
          Este correo fue generado automáticamente, por favor no respondas a este mensaje.
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Envía el correo de verificación de email para el registro trial.
 * @param {string} email          - Destinatario
 * @param {string} otp            - Código OTP en texto plano
 * @param {object} [opts]
 * @param {number} [opts.expiresMinutes=10]
 */
async function sendRegistroVerificationEmail(email, otp, opts = {}) {
    const expiresMinutes = opts.expiresMinutes ?? 10;
    const from           = process.env.MAIL_FROM || '"EscalApp" <escalappsystem@gmail.com>';

    if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn('⚠️  MAIL sin configurar. OTP de registro (solo dev):', otp);
            return;
        }
        throw new Error('Configuración de correo incompleta');
    }

    const attachments = [];
    let logoSrc = '';
    if (fs.existsSync(LOGO_PATH)) {
        attachments.push({ filename: 'escalapplogo.png', path: LOGO_PATH, cid: 'escalapplogo' });
        logoSrc = 'cid:escalapplogo';
    }

    const info = await transporter.sendMail({
        from,
        to:      email,
        subject: `Tu código de verificación EscalApp: ${otp}`,
        text:    `EscalApp — Verificación de registro\n\nTu código es: ${otp}\nVálido por ${expiresMinutes} minutos.\n\nSi no solicitaste este registro, ignora este correo.`,
        html:    buildRegistroVerifHtml(otp, expiresMinutes, logoSrc),
        attachments,
    });

    console.info(`✉️  Código de registro enviado a ${email} — messageId: ${info.messageId}`);
}

// ============================================================
// Correo de bienvenida con credenciales generadas
// ============================================================

function buildWelcomeEmailHtml(nombre, numIdentificacion, loginUrl, logoUrl) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>¡Bienvenido a EscalApp!</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; margin: 0; padding: 0; }
    .wrapper { padding: 40px 16px; }
    .container { max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.08); overflow: hidden; }
    .header { background: linear-gradient(135deg, #0d1b2a 0%, #1a3a5c 100%); padding: 28px 32px; text-align: center; }
    .header img { max-height: 52px; width: auto; display: inline-block; }
    .header-title { color: #ffffff; font-size: 15px; font-weight: 700; margin: 12px 0 0; }
    .body { padding: 36px 32px; }
    .body p { color: #4a5568; font-size: 14px; line-height: 1.7; margin: 0 0 16px; }
    .cred-box { background: #f7f9ff; border: 1px solid #c3cfff; border-radius: 10px; padding: 20px 24px; margin: 24px 0; }
    .cred-row { display: flex; align-items: center; margin-bottom: 12px; }
    .cred-row:last-child { margin-bottom: 0; }
    .cred-label { font-size: 12px; color: #718096; text-transform: uppercase; letter-spacing: 1px; font-weight: 600; width: 100px; flex-shrink: 0; }
    .cred-value { font-size: 18px; font-weight: 800; color: #4361ee; font-family: 'Courier New', monospace; letter-spacing: 2px; }
    .warning-box { background: #fffbeb; border-left: 4px solid #f6ad55; border-radius: 6px; padding: 14px 16px; margin-bottom: 20px; }
    .warning-box p { font-size: 13px; color: #744210; margin: 0; line-height: 1.6; }
    .btn-wrap { text-align: center; margin: 24px 0 8px; }
    .btn { display: inline-block; background: #4361ee; color: #ffffff !important; text-decoration: none; padding: 14px 36px; border-radius: 8px; font-weight: 700; font-size: 15px; }
    .divider { border: none; border-top: 1px solid #e8ecf0; margin: 24px 0; }
    .footer { background: #f7f9ff; padding: 18px 32px; text-align: center; }
    .footer p { font-size: 11px; color: #a0aec0; margin: 0; line-height: 1.6; }
    .footer strong { color: #718096; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        ${logoUrl
            ? `<img src="${logoUrl}" alt="EscalApp" />`
            : `<span style="color:#ffffff;font-size:22px;font-weight:800;">EscalApp</span>`
        }
        <p class="header-title">🎉 ¡Tu cuenta está lista!</p>
      </div>
      <div class="body">
        <p>Hola, <strong>${nombre}</strong>. Tu prueba gratuita de 7 días en <strong>EscalApp</strong> ya está activa. Estas son tus credenciales de acceso:</p>
        <div class="cred-box">
          <div class="cred-row">
            <span class="cred-label">Usuario</span>
            <span class="cred-value">${numIdentificacion}</span>
          </div>
          <div class="cred-row">
            <span class="cred-label">Contraseña</span>
            <span class="cred-value">${numIdentificacion}</span>
          </div>
        </div>
        <div class="warning-box">
          <p>
            ⚠️ <strong>Importante:</strong> Tu contraseña temporal es igual a tu número de cédula.
            Por seguridad, cámbiala la primera vez que inicies sesión desde
            <em>Perfil → Cambiar contraseña</em>.
          </p>
        </div>
        <div class="btn-wrap">
          <a class="btn" href="${loginUrl}">Iniciar sesión ahora →</a>
        </div>
        <hr class="divider" />
        <p style="font-size:12px;color:#a0aec0;">
          Tu prueba gratuita dura <strong>7 días</strong> con acceso al Plan Básico.
          Al finalizar podrás elegir el plan que mejor se adapte a tu negocio.
        </p>
      </div>
      <div class="footer">
        <p>
          © ${new Date().getFullYear()} <strong>EscalApp</strong> · Todos los derechos reservados<br />
          Este correo fue generado automáticamente, por favor no respondas a este mensaje.
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Envía el correo de bienvenida con las credenciales auto-generadas.
 * @param {string} email             - Destinatario
 * @param {string} nombre            - Nombre del usuario
 * @param {string} numIdentificacion - Cédula (usada como usuario y contraseña temporal)
 */
async function sendWelcomeEmail(email, nombre, numIdentificacion) {
    const from     = process.env.MAIL_FROM || '"EscalApp" <escalappsystem@gmail.com>';
    const loginUrl = `${process.env.FRONTEND_URL || 'https://escalapp.cloud'}/admin/`;

    if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn(`⚠️  MAIL sin configurar. Bienvenida (dev): usuario=${numIdentificacion}, pass=${numIdentificacion}`);
            return;
        }
        throw new Error('Configuración de correo incompleta');
    }

    const attachments = [];
    let logoSrc = '';
    if (fs.existsSync(LOGO_PATH)) {
        attachments.push({ filename: 'escalapplogo.png', path: LOGO_PATH, cid: 'escalapplogo' });
        logoSrc = 'cid:escalapplogo';
    }

    const info = await transporter.sendMail({
        from,
        to:      email,
        subject: '¡Tu cuenta de EscalApp está lista! — Credenciales de acceso',
        text:    `Hola ${nombre},\n\nTu cuenta de EscalApp está lista.\n\nUsuario: ${numIdentificacion}\nContraseña temporal: ${numIdentificacion}\n\nCambia tu contraseña al iniciar sesión.\n\nAccede aquí: ${loginUrl}`,
        html:    buildWelcomeEmailHtml(nombre, numIdentificacion, loginUrl, logoSrc),
        attachments,
    });

    console.info(`✉️  Correo de bienvenida enviado a ${email} — messageId: ${info.messageId}`);
}

// ============================================================
// Notificación al administrador sobre nuevo registro trial
// ============================================================

/**
 * Notifica al administrador de un nuevo usuario que se registró en modo trial.
 * @param {object} datos
 * @param {string} datos.nombre
 * @param {string} datos.numIdentificacion
 * @param {string} datos.email
 * @param {string} datos.tipoNegocio
 * @param {string} datos.fechaRegistro
 */
async function sendAdminNotificationEmail(datos) {
    const adminEmail = process.env.MAIL_ADMIN || process.env.MAIL_FROM;
    if (!adminEmail) {
        console.warn('⚠️  MAIL_ADMIN no configurado. Omitiendo notificación de admin.');
        return;
    }
    if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn('⚠️  MAIL sin configurar. Notificación admin (dev):', datos);
            return;
        }
        return;
    }

    const from    = process.env.MAIL_FROM || '"EscalApp" <escalappsystem@gmail.com>';
    const subject = `[EscalApp] Nuevo usuario trial: ${datos.nombre}`;
    const text    = `
Nuevo usuario registrado en modo trial.

Nombre:           ${datos.nombre}
Cédula:           ${datos.numIdentificacion}
Correo:           ${datos.email}
Tipo de negocio:  ${datos.tipoNegocio}
Fecha de registro: ${datos.fechaRegistro}
`.trim();

    await transporter.sendMail({ from, to: adminEmail, subject, text });
    console.info(`✉️  Notificación admin enviada a ${adminEmail}`);
}

module.exports = { sendPasswordResetEmail, sendRegistroVerificationEmail, sendWelcomeEmail, sendAdminNotificationEmail, verifyTransport };
