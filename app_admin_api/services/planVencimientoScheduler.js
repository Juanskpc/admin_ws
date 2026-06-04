/**
 * planVencimientoScheduler.js — Tarea programada diaria para verificar vencimientos de plan.
 *
 * Se ejecuta todos los días a las 8:00 AM (hora del servidor).
 * Envía correos y crea notificaciones internas a usuarios cuyo plan vence en 5 o 1 día.
 *
 * Usa node-cron (ya instalado en el proyecto).
 */

'use strict';
const cron = require('node-cron');
const notificacionService = require('../services/notificacionService');

const CRON_SCHEDULE = process.env.PLAN_CHECK_CRON || '0 8 * * *';

let initialized = false;

/**
 * Inicia el scheduler de verificación de vencimientos.
 * Llamar desde app.js después de que la BD esté lista.
 */
function iniciar() {
    if (initialized) return;
    initialized = true;

    console.log(`📅 Scheduler de vencimientos de plan programado: "${CRON_SCHEDULE}"`);

    cron.schedule(CRON_SCHEDULE, async () => {
        await notificacionService.ejecutarVerificacionDiaria();
    }, {
        timezone: process.env.APP_TIMEZONE || 'America/Bogota'
    });

    if (process.env.RUN_PLAN_CHECK_ON_START === 'true') {
        console.log('🔄 Ejecutando verificación de vencimientos al inicio (RUN_PLAN_CHECK_ON_START=true)...');
        setTimeout(() => {
            notificacionService.ejecutarVerificacionDiaria();
        }, 5000);
    }
}

module.exports = { iniciar };
