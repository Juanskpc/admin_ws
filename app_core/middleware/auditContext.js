/**
 * auditContext.js — Contexto de auditoría por petición (AsyncLocalStorage).
 *
 * El middleware `auditContext` envuelve cada request en un store ALS que guarda
 * la referencia al `req`. Como `verificarToken` corre DESPUÉS (por ruta) y asigna
 * `req.usuario`, el actor se lee de forma PEREZOSA en getAuditContext(): al momento
 * de abrir una transacción ya está disponible.
 *
 * Consumidores:
 *   - conection.js: al abrir cada transacción Sequelize fija las GUC
 *     `app.id_usuario` / `app.id_negocio` (SET LOCAL) que lee auditoria.fn_audit().
 *   - auditHelper.js: completa actor/tenant en eventos si no se pasan explícitos.
 *
 * El JWT solo trae `id_usuario`; el tenant NO viene en el token. Los services
 * que conocen el negocio de la operación pueden fijarlo con setAuditNegocio(id)
 * — si no, fn_audit() lo resuelve desde la columna id_negocio de la fila.
 *
 * Limitación conocida: las queries por el pool pg nativo (reporteDao) y los
 * jobs de cron corren fuera de un request → sin actor (id_usuario NULL).
 */
'use strict';
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/** Middleware global: registrar ANTES de las rutas en app.js. */
function auditContext(req, res, next) {
    als.run({ req, idNegocio: null }, next);
}

/**
 * Fija el negocio (tenant) de la operación en curso.
 * Llamar desde services/controllers que conocen el id_negocio afectado.
 */
function setAuditNegocio(idNegocio) {
    const store = als.getStore();
    if (store) store.idNegocio = idNegocio;
}

/**
 * Devuelve el contexto de auditoría vigente (o nulls fuera de un request).
 * @returns {{ idUsuario: number|null, idNegocio: number|null, ip: string|null }}
 */
function getAuditContext() {
    const store = als.getStore();
    const req = store?.req;
    return {
        idUsuario: req?.usuario?.id_usuario ?? null,
        idNegocio: store?.idNegocio ?? null,
        ip: req?.ip ?? null,
    };
}

module.exports = { auditContext, setAuditNegocio, getAuditContext };
