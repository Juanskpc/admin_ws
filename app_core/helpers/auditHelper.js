/**
 * auditHelper.js — Auditoría de eventos de aplicación (Tipo B).
 *
 * Registra en auditoria.audit_evento hechos que NO mapean a un cambio de fila:
 * login exitoso/fallido, OTP verificado, cambio de contraseña, suspensión,
 * cambio de plan, apertura/cierre de caja, etc.
 *
 * Uso típico en un service/controller:
 *   const Audit = require('../../app_core/helpers/auditHelper');
 *   await Audit.registrarEvento({
 *       modulo: 'auth', accion: 'login_fail', resultado: 'error',
 *       detalle: { email }, ip: req.ip,
 *   });
 *
 * Política de errores:
 *   - SIN `transaction`: el fallo se registra con console.warn y se traga
 *     (la auditoría nunca rompe la operación de negocio).
 *   - CON `transaction`: el error se propaga — en PostgreSQL una query fallida
 *     aborta la transacción de todas formas, y para eventos que deben ser
 *     atómicos con el cambio (ej. cambio de plan) el rollback es lo correcto.
 */
'use strict';
const Models = require('../models/conection');
const { getAuditContext } = require('../middleware/auditContext');

/**
 * Registra un evento de auditoría.
 *
 * @param {object} evento
 * @param {string} evento.modulo        Área funcional: 'auth', 'planes', 'usuarios', 'caja', ...
 * @param {string} evento.accion        Acción puntual: 'login_ok', 'otp_verificado', 'plan_cambiado', ...
 * @param {string} [evento.resultado]   'ok' (default) | 'error' | 'denegado'
 * @param {number} [evento.idUsuario]   Actor; default: contexto del request (JWT)
 * @param {number} [evento.idNegocio]   Tenant afectado; default: contexto del request
 * @param {string} [evento.ip]          IP origen; default: contexto del request
 * @param {object} [evento.detalle]     Payload libre (se guarda como JSONB). NO incluir credenciales.
 * @param {object} [evento.transaction] Transacción Sequelize para atomicidad con el cambio de negocio
 */
async function registrarEvento({
    modulo,
    accion,
    resultado = 'ok',
    idUsuario,
    idNegocio,
    ip,
    detalle,
    transaction,
} = {}) {
    const ctx = getAuditContext();
    const params = {
        modulo,
        accion,
        resultado,
        idUsuario: idUsuario ?? ctx.idUsuario,
        idNegocio: idNegocio ?? ctx.idNegocio,
        ip: ip ?? ctx.ip,
        detalle: detalle != null ? JSON.stringify(detalle) : null,
    };

    try {
        await Models.sequelize.query(
            `INSERT INTO auditoria.audit_evento
                 (modulo, accion, resultado, id_usuario, id_negocio, ip, detalle)
             VALUES
                 (:modulo, :accion, :resultado, :idUsuario, :idNegocio, :ip, :detalle::jsonb)`,
            { replacements: params, transaction }
        );
    } catch (err) {
        if (transaction) throw err; // dentro de una transacción el caller decide (rollback)
        console.warn(`auditHelper: no se pudo registrar evento ${modulo}/${accion}:`, err.message);
    }
}

module.exports = { registrarEvento };
