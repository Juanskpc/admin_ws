'use strict';

/**
 * Stub de notificaciones del módulo Reserva.
 * En Ola 1 solo loguea. En Ola 6 se conectará al transporter de nodemailer existente
 * (admin_ws/app_admin_api/services/mailService.js) con plantillas HTML por evento.
 *
 * Eventos soportados: cita_creada, cita_pendiente_pago, cita_cancelada,
 *                     pago_aprobado, pago_rechazado, cita_nueva_negocio.
 */
async function enviar(evento, payload = {}) {
    const idCita = payload.cita?.id_cita ?? '?';
    const cliente = payload.cita?.cliente_email ?? payload.cita?.cliente_nombre ?? '?';
    console.log(`[Reserva/Notif] evento=${evento} cita=${idCita} cliente=${cliente}`);
    // TODO Ola 6: armar HTML según `evento` y llamar transporter.sendMail.
}

module.exports = { enviar };
