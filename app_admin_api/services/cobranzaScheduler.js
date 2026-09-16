/**
 * cobranzaScheduler — el cobro automático de las mensualidades.
 *
 * Corre a las 08:15 de Bogotá, quince minutos después del aviso de vencimientos, para no pelear
 * con él por la misma base a la misma hora.
 *
 * ## Nace apagado
 *
 * `COBRANZA_AUTO_ENABLED` por defecto es false. Un cron que cobra de verdad no debe arrancar
 * solo porque alguien levantó el servidor con un `.env` heredado: la primera vez que cobre tiene
 * que ser una decisión de una persona. Y con `manual` como única pasarela activa, hoy no habría
 * nada que cobrar de todas formas.
 *
 * ## Qué hace, en orden
 *
 * 1. Toma las suscripciones **automáticas** (pasarela recurrente, no retenedoras) cuyo
 *    `proximo_cobro` ya venció.
 * 2. Se asegura de que exista la factura del período — reutilizando `generarFacturaPeriodo`,
 *    que ya es idempotente por partida doble.
 * 3. La cobra por su pasarela.
 *
 * Las tres cosas van **negocio a negocio y con try/catch por negocio**: que la tarjeta de un
 * cliente falle no puede dejar sin cobrar a los demás. Es el error clásico del cron de
 * facturación —un `for` sin protección— y no se nota hasta fin de mes.
 *
 * ## Lo que NO hace
 *
 * No suspende por tiempo: la suspensión sale de los reintentos fallidos, en
 * `cobranzaService.registrarIntentoFallido`. Y nunca toca `manual`: ahí no hay nada que cobrar
 * sin un humano.
 */
'use strict';
const cron = require('node-cron');

const Models = require('../../app_core/models/conection');
const CobranzaService = require('./cobranzaService');
const { getAdaptador } = require('../../app_core/cobranza');

const sequelize = Models.sequelize;
const CRON_SCHEDULE = process.env.COBRANZA_CRON || '15 8 * * *';

let initialized = false;

/**
 * Las suscripciones que toca cobrar hoy.
 *
 * El filtro por pasarela recurrente y por `es_retenedor` va en SQL y no en JavaScript porque es
 * una regla de negocio dura: **a un cliente que retiene en la fuente no se le debita el 100%**
 * (docs/obligaciones-escalapp.md §3). Dejarlo para un `filter()` posterior es dejar abierta la
 * puerta a que alguien lo olvide en el siguiente refactor.
 */
async function suscripcionesPorCobrar() {
    return sequelize.query(
        `
        SELECT s.id_suscripcion, s.id_negocio, s.pasarela, s.estado, s.proximo_cobro
          FROM cobranza.cob_suscripcion s
          JOIN cobranza.cob_pasarela p ON p.codigo = s.pasarela
         WHERE s.estado IN ('activa', 'en_gracia')
           AND s.es_retenedor = false
           AND p.estado = 'A'
           AND p.soporta_recurrente = true
           AND s.proximo_cobro IS NOT NULL
           AND s.proximo_cobro <= CURRENT_DATE
         ORDER BY s.proximo_cobro ASC;
        `,
        { type: sequelize.QueryTypes.SELECT }
    );
}

async function ejecutarCicloDeCobro() {
    const pendientes = await suscripcionesPorCobrar();
    if (pendientes.length === 0) {
        console.info('[Cobranza/cron] Nada por cobrar hoy.');
        return { revisadas: 0, cobradas: 0, fallidas: 0 };
    }

    console.info(`[Cobranza/cron] ${pendientes.length} suscripción(es) por cobrar.`);
    let cobradas = 0;
    let fallidas = 0;

    for (const s of pendientes) {
        try {
            const adaptador = getAdaptador(s.pasarela);
            if (adaptador.estaConfigurada && !adaptador.estaConfigurada()) {
                console.warn(
                    `[Cobranza/cron] negocio ${s.id_negocio}: '${s.pasarela}' sin credenciales, omitida.`
                );
                continue;
            }

            const { factura } = await CobranzaService.generarFacturaPeriodo(s.id_negocio);
            if (factura.estado === 'pagada') continue;

            const resultado = await CobranzaService.cobrarFactura(factura.id_factura);
            if (resultado.estado === 'aprobada') cobradas += 1;
            if (resultado.estado === 'rechazada') fallidas += 1;

            console.info(
                `[Cobranza/cron] negocio ${s.id_negocio} · ${factura.referencia} → ${resultado.estado}`
            );
        } catch (err) {
            fallidas += 1;
            // Un negocio que revienta no puede llevarse por delante a los demás.
            console.error(`[Cobranza/cron] negocio ${s.id_negocio} falló:`, err.message);
        }
    }

    return { revisadas: pendientes.length, cobradas, fallidas };
}

function iniciar() {
    if (initialized) return;

    if (process.env.COBRANZA_AUTO_ENABLED !== 'true') {
        console.log('💤 Cobro automático DESACTIVADO (COBRANZA_AUTO_ENABLED != true)');
        return;
    }

    initialized = true;
    console.log(`💳 Scheduler de cobro programado: "${CRON_SCHEDULE}"`);

    cron.schedule(
        CRON_SCHEDULE,
        async () => {
            try {
                await ejecutarCicloDeCobro();
            } catch (err) {
                console.error('[Cobranza/cron] ciclo abortado:', err.message);
            }
        },
        { timezone: process.env.APP_TIMEZONE || 'America/Bogota' }
    );
}

module.exports = { iniciar, ejecutarCicloDeCobro, suscripcionesPorCobrar };
