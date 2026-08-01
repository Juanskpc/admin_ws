/**
 * Relay del outbox (ADR-012) — drena `platform.outbox` y entrega a los consumidores.
 *
 * Sondea la tabla, entrega cada evento a todos los consumidores registrados y lo marca.
 * Si alguno falla, reprograma el evento con backoff exponencial; tras agotar los reintentos
 * lo deja en `fallido` (dead letter) para intervención manual.
 *
 * ## Entrega AL MENOS UNA VEZ — los consumidores DEBEN ser idempotentes
 *
 * No es un detalle de implementación, es una consecuencia declarada del ADR: si el relay
 * cae después de entregar y antes de marcar, el evento se reentrega. Además el estado de
 * entrega es **uno por evento**, no uno por consumidor: si hay dos consumidores y el
 * segundo falla, el primero volverá a recibir el evento en el reintento.
 *
 * Se eligió no llevar estado por consumidor (que exigiría otra tabla) porque hoy no hay
 * ningún consumidor: sería construir para nadie. Cuando existan varios y la reentrega
 * duela, esa tabla es un añadido aditivo detrás de esta misma interfaz.
 *
 * ## Orden
 *
 * No se garantiza orden global ni por negocio. Ningún ADR lo pide y garantizarlo cuesta
 * serializar la entrega. Un consumidor que necesite orden debe deducirlo de `ocurrido_en`.
 *
 * ## Sin consumidores
 *
 * Si no hay ninguno registrado, el relay **no sondea**: los eventos se quedan pendientes en
 * la tabla en vez de darse por entregados. Es deliberado — marcar como entregado lo que
 * nadie recibió sería perder eventos en silencio, justo lo que ADR-012 quiere evitar.
 */
const db = require('../models/conection');
const outboxDao = require('../dao/outboxDao');

const sequelize = db.sequelize;

const CONFIG = {
    intervaloMs: Number(process.env.OUTBOX_POLL_MS) || 5000,
    lote: Number(process.env.OUTBOX_BATCH) || 50,
    maxIntentos: Number(process.env.OUTBOX_MAX_INTENTOS) || 6,
    backoffMaxSegundos: Number(process.env.OUTBOX_BACKOFF_MAX_SEG) || 3600,
};

/** Map<nombre, { patron, manejar }> */
const consumidores = new Map();
let temporizador = null;
let drenando = false;

/**
 * Registra un consumidor.
 *
 * @param {string}   nombre    — identificador estable; se usa en los logs y en los errores.
 * @param {Object}   opciones
 * @param {RegExp|string[]} [opciones.patron] — qué tipos consume. Por defecto, todos.
 * @param {Function} opciones.manejar — async (evento) => void. Debe ser IDEMPOTENTE.
 *                                      Si lanza, el evento se reintenta.
 */
function registrarConsumidor(nombre, { patron = null, manejar }) {
    if (typeof manejar !== 'function') {
        throw new Error(`El consumidor "${nombre}" debe aportar una función manejar(evento).`);
    }
    consumidores.set(nombre, { patron, manejar });
}

function limpiarConsumidores() {
    consumidores.clear();
}

function leInteresa({ patron }, tipo) {
    if (!patron) return true;
    if (Array.isArray(patron)) return patron.includes(tipo);
    return patron.test(tipo);
}

/**
 * Procesa un lote. Cada evento se reclama, entrega y marca dentro de su propia transacción,
 * de modo que un evento problemático no arrastra a los demás del lote.
 *
 * @returns {Promise<{procesados: number, entregados: number, fallidos: number}>}
 */
async function drenarUnaVez() {
    if (consumidores.size === 0) {
        return { procesados: 0, entregados: 0, fallidos: 0 };
    }

    const t = await sequelize.transaction();
    let eventos;
    try {
        eventos = await outboxDao.reclamarPendientes(CONFIG.lote, { transaction: t });
    } catch (error) {
        await t.rollback();
        throw error;
    }

    let entregados = 0;
    let fallidos = 0;

    try {
        for (const evento of eventos) {
            const destinatarios = [...consumidores.entries()].filter(([, c]) =>
                leInteresa(c, evento.tipo)
            );

            try {
                for (const [nombre, consumidor] of destinatarios) {
                    try {
                        await consumidor.manejar(evento);
                    } catch (error) {
                        throw new Error(`consumidor "${nombre}": ${error.message}`);
                    }
                }
                await outboxDao.marcarEntregado(evento.id_evento, { transaction: t });
                entregados++;
            } catch (error) {
                const { agotado } = await outboxDao.marcarFallo(evento.id_evento, error.message, {
                    intentos: evento.intentos,
                    maxIntentos: CONFIG.maxIntentos,
                    backoffMaxSegundos: CONFIG.backoffMaxSegundos,
                    transaction: t,
                });
                fallidos++;
                console.error(
                    `[outboxRelay] Evento ${evento.id_evento} (${evento.tipo}) falló` +
                        `${agotado ? ' y agotó los reintentos → dead letter' : ', se reintentará'}: ${error.message}`
                );
            }
        }

        await t.commit();
    } catch (error) {
        await t.rollback();
        throw error;
    }

    return { procesados: eventos.length, entregados, fallidos };
}

/** Un tick del temporizador. Nunca deja escapar un error: el relay no puede morirse solo. */
async function tick() {
    if (drenando) return;
    drenando = true;
    try {
        await drenarUnaVez();
    } catch (error) {
        console.error('[outboxRelay] Error drenando el outbox:', error.message);
    } finally {
        drenando = false;
    }
}

function iniciar() {
    if (temporizador) return;

    if (process.env.OUTBOX_RELAY_ENABLED === 'false') {
        console.log('[outboxRelay] Deshabilitado por OUTBOX_RELAY_ENABLED=false.');
        return;
    }

    if (consumidores.size === 0) {
        // Estado normal hoy: la tubería existe, todavía no hay quien beba de ella.
        console.log(
            '[outboxRelay] Sin consumidores registrados — el relay queda inactivo. ' +
                'Los eventos se acumularán como pendientes (no se pierden).'
        );
        return;
    }

    temporizador = setInterval(tick, CONFIG.intervaloMs);
    temporizador.unref?.();
    console.log(
        `[outboxRelay] Iniciado — ${consumidores.size} consumidor(es), ` +
            `sondeo cada ${CONFIG.intervaloMs}ms, lote ${CONFIG.lote}.`
    );
}

function detener() {
    if (temporizador) {
        clearInterval(temporizador);
        temporizador = null;
    }
}

module.exports = {
    registrarConsumidor,
    limpiarConsumidores,
    drenarUnaVez,
    iniciar,
    detener,
    CONFIG,
};
