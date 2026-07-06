/**
 * auditParticionScheduler.js — Mantenimiento mensual de particiones de auditoría.
 *
 * 1) Al arrancar el servidor: asegura las particiones del mes actual + siguiente
 *    (idempotente y barato; cubre reinicios que se pierdan el cron).
 * 2) Cron mensual (día 1, 3:15 AM Bogotá por defecto):
 *    - crea la partición del mes siguiente
 *    - aplica retención: purga filas de esquemas de negocio (> AUDIT_RETENCION_NEGOCIO_MESES)
 *      y elimina particiones completas (> AUDIT_RETENCION_MESES). DROP de partición es
 *      instantáneo — sin DELETEs masivos contra RDS.
 *
 * Variables de entorno (opcionales):
 *   AUDIT_PARTICION_CRON            default '15 3 1 * *'
 *   AUDIT_RETENCION_MESES           default 24  (todo el histórico)
 *   AUDIT_RETENCION_NEGOCIO_MESES   default 6   (filas de esquemas ≠ general)
 *
 * Usa node-cron (ya instalado). Patrón idéntico a planVencimientoScheduler.
 */
'use strict';
const cron = require('node-cron');
const Models = require('../models/conection');

const CRON_SCHEDULE = process.env.AUDIT_PARTICION_CRON || '15 3 1 * *';
const RETENCION_TOTAL = parseInt(process.env.AUDIT_RETENCION_MESES || '24', 10);
const RETENCION_NEGOCIO = parseInt(process.env.AUDIT_RETENCION_NEGOCIO_MESES || '6', 10);

let initialized = false;

async function asegurarParticiones() {
    await Models.sequelize.query(`SELECT auditoria.fn_asegurar_particiones(1);`);
}

async function mantenimientoMensual() {
    try {
        await asegurarParticiones();
        const [rows] = await Models.sequelize.query(
            `SELECT auditoria.fn_aplicar_retencion(:total, :negocio) AS resumen;`,
            { replacements: { total: RETENCION_TOTAL, negocio: RETENCION_NEGOCIO } }
        );
        console.log(`🗂️  Auditoría — ${rows?.[0]?.resumen || 'mantenimiento ejecutado'}`);
    } catch (err) {
        console.error('Error en mantenimiento de particiones de auditoría:', err.message);
    }
}

/**
 * Inicia el scheduler de particiones de auditoría.
 * Llamar desde app.js después de que la BD esté lista.
 * No-op silencioso si el esquema auditoria aún no existe (migración no ejecutada).
 */
function iniciar() {
    if (initialized) return;
    initialized = true;

    console.log(`🗂️  Scheduler de particiones de auditoría programado: "${CRON_SCHEDULE}"`);

    cron.schedule(CRON_SCHEDULE, mantenimientoMensual, {
        timezone: process.env.APP_TIMEZONE || 'America/Bogota',
    });

    // Asegurar particiones al arrancar (tolerante a que la migración no exista aún)
    setTimeout(() => {
        asegurarParticiones().catch(err => {
            console.warn('Auditoría: particiones no aseguradas al arranque (¿falta migrate:auditoria-base?):', err.message);
        });
    }, 5000);
}

module.exports = { iniciar };
