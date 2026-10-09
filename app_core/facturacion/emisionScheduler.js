'use strict';
/**
 * El proceso de fondo de la facturación electrónica: cada minuto recoge los pedidos cobrados que
 * se quedaron sin documento y reintenta los que no pudieron enviarse. R4.4 de
 * `docs/plan-fe-restaurante.md`.
 *
 * Sin negocios configurados, cada ciclo son dos consultas que no devuelven nada.
 */
const cron = require('node-cron');

const emisionService = require('./emisionService');

const CRON_SCHEDULE = process.env.FE_WORKER_CRON || '* * * * *';

let initialized = false;
let corriendo = false;

async function ciclo() {
    // Un ciclo lento (Factus caído, veinte documentos esperando) no se solapa con el siguiente.
    if (corriendo) return;
    corriendo = true;
    try {
        await emisionService.reconciliar();
        await emisionService.procesarPendientes();
    } catch (err) {
        console.error('[facturacion] ciclo del worker:', err.message);
    } finally {
        corriendo = false;
    }
}

function iniciar() {
    if (initialized) return;
    if (process.env.FE_WORKER_ENABLED === 'false') {
        console.info('[facturacion] worker apagado (FE_WORKER_ENABLED=false)');
        return;
    }
    cron.schedule(CRON_SCHEDULE, ciclo);
    initialized = true;
}

module.exports = { iniciar, ciclo };
