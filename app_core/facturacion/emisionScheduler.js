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
const configuracionDao = require('./configuracionDao');
const { getProveedor } = require('./proveedores');

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

/**
 * Una vez al día: vuelve a copiar los rangos de cada negocio que emite, para que los avisos de
 * «el rango se acaba» y «la resolución vence» salgan aunque nadie entre a la configuración.
 */
async function sincronizarRangos() {
    for (const idNegocio of await configuracionDao.negociosActivos()) {
        try {
            const config = await configuracionDao.obtener(idNegocio);
            const credenciales = await configuracionDao.obtenerCredenciales(idNegocio);
            const rangos = await getProveedor(config.proveedor).listarRangos({ credenciales, ambiente: config.ambiente });
            await configuracionDao.guardarRangos(idNegocio, rangos);
        } catch (err) {
            // Un negocio con las credenciales rotas no puede dejar sin sincronizar a los demás.
            console.error(`[facturacion] sincronizar rangos del negocio ${idNegocio}:`, err.message);
        }
    }
}

function iniciar() {
    if (initialized) return;
    if (process.env.FE_WORKER_ENABLED === 'false') {
        console.info('[facturacion] worker apagado (FE_WORKER_ENABLED=false)');
        return;
    }
    cron.schedule(CRON_SCHEDULE, ciclo);
    cron.schedule('0 6 * * *', () => sincronizarRangos().catch((err) => console.error('[facturacion]', err.message)));
    initialized = true;
}

module.exports = { iniciar, ciclo, sincronizarRangos };
