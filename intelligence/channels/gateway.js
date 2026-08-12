/**
 * Channel Gateway (ADR-017) — la frontera entre el núcleo y los canales.
 *
 * Tiene dos mitades y conviene no confundirlas:
 *
 *   - **Entrada:** cada adaptador traduce lo que su canal hable a Mensaje Canónico y llama a
 *     `motor.recibir()`. Esa mitad no pasa por aquí: es una llamada directa del adaptador al
 *     motor, porque no hay nada que coordinar.
 *   - **Salida:** el motor deja los mensajes en `intelligence.mensaje` con
 *     `estado_entrega = 'pendiente'` y **se olvida**. Esta mitad —quién los entrega, cuándo,
 *     con cuántos reintentos— es lo que vive en este archivo.
 *
 * ## Por qué la salida es asíncrona, aunque hoy el único canal esté en el mismo proceso
 *
 * ADR-016 lo pone como la corrección que «cambia la naturaleza» del WebChat: si el canal
 * devolviera la respuesta del bot en el mismo HTTP de la ingesta, no habría entregas
 * asíncronas, ni retrasos, ni fallos de entrega, ni reintentos — y los criterios de
 * aceptación del motor se volverían **infalsificables**. Pasarían siempre, no porque el motor
 * esté bien, sino porque el canal nunca lo puso a prueba. Y todos esos bugs aparecerían
 * juntos el día de WhatsApp, que es el peor día para descubrirlos.
 *
 * Así que la salida atraviesa **exactamente el mismo camino** que atravesará WhatsApp:
 * cola de salida en la base → entregador → adaptador → canal.
 *
 * ## Entrega AL MENOS UNA VEZ
 *
 * Igual que el relay del outbox: si el proceso cae después de entregar y antes de marcar, el
 * mensaje se reentrega. Un adaptador debería ser idempotente; el del WebChat lo es porque su
 * buzón indexa por `id_mensaje`.
 *
 * ## Sin backoff, y es una decisión
 *
 * Los reintentos van al ritmo del sondeo, sin espera creciente. Un backoff necesitaría una
 * columna `proximo_intento_en` en una tabla particionada de alto volumen, y hoy no compra
 * nada: el único canal es local y sus fallos son instantáneos. Cuando el primer canal remoto
 * (WhatsApp) empiece a devolver 429, esa columna será lo primero que haga falta.
 */
'use strict';
const Models = require('../../app_core/models/conection');
const repositorio = require('../engine/repositorio');
const { numeroDeEntorno } = require('../engine/cola');

const sequelize = Models.sequelize;

const CONFIG = {
    intervaloMs: numeroDeEntorno('CANAL_ENTREGA_POLL_MS', 1000),
    lote: numeroDeEntorno('CANAL_ENTREGA_LOTE', 50),
    /** Tras agotarlos, el mensaje queda `fallido` (dead letter) y nadie lo reintenta. */
    maxIntentos: numeroDeEntorno('CANAL_ENTREGA_MAX_INTENTOS', 5),
    /** Más viejo que esto no se entrega: responder a algo de anteayer es peor que callar. */
    ventanaHoras: numeroDeEntorno('CANAL_ENTREGA_VENTANA_HORAS', 24),
};

/** Map<nombre, adaptador> */
const adaptadores = new Map();
let temporizador = null;
let entregando = false;

/**
 * Registra un adaptador de canal — el `ChannelPort` de ADR-017.
 *
 * @param {Object} adaptador
 * @param {string} adaptador.nombre — el mismo valor que viaja en `mensaje.canal`.
 * @param {Function} adaptador.entregar — async ({ idMensaje, idConversacion, idNegocio,
 *        idExterno, mensaje: { texto, opciones } }) => void. Si lanza, se reintenta.
 *        **Renderiza** las opciones como sepa su canal: botones, chips o una enumeración.
 */
function registrar(adaptador) {
    if (!adaptador || !adaptador.nombre || typeof adaptador.entregar !== 'function') {
        throw new Error('Un adaptador de canal necesita { nombre, entregar(sobre) }.');
    }
    adaptadores.set(adaptador.nombre, adaptador);
}

function obtener(nombre) {
    return adaptadores.get(nombre) || null;
}

function limpiar() {
    adaptadores.clear();
}

/**
 * Entrega un lote. Cada mensaje se reclama, entrega y marca dentro de la misma transacción,
 * de modo que un mensaje problemático no arrastra a los demás.
 *
 * @returns {Promise<{procesados: number, entregados: number, fallidos: number}>}
 */
async function entregarUnaVez() {
    if (adaptadores.size === 0) return { procesados: 0, entregados: 0, fallidos: 0 };

    const t = await sequelize.transaction();
    let entregados = 0;
    let fallidos = 0;
    let pendientes;

    try {
        pendientes = await repositorio.reclamarSalientesPendientes({
            lote: CONFIG.lote,
            ventanaHoras: CONFIG.ventanaHoras,
            transaction: t,
        });

        for (const mensaje of pendientes) {
            const adaptador = obtener(mensaje.canal);
            let entregado = false;
            let motivo = null;

            if (!adaptador) {
                // No es un fallo del canal: es que nadie sabe hablar ese canal en este
                // proceso. Se cuenta como intento igual, porque si nunca aparece el
                // adaptador, insistir eternamente solo llena la tabla de trabajo muerto.
                motivo = `sin adaptador registrado para el canal "${mensaje.canal}"`;
            } else {
                try {
                    await adaptador.entregar({
                        idMensaje: mensaje.id_mensaje,
                        idConversacion: mensaje.id_conversacion,
                        idNegocio: mensaje.id_negocio,
                        idTurno: mensaje.id_turno,
                        idExterno: mensaje.id_externo,
                        intento: (mensaje.intentos_entrega || 0) + 1,
                        mensaje: { texto: mensaje.contenido, opciones: mensaje.opciones || [] },
                    });
                    entregado = true;
                } catch (error) {
                    motivo = error.message;
                }
            }

            const marca = await repositorio.marcarEntrega(
                mensaje,
                { entregado, maxIntentos: CONFIG.maxIntentos },
                { transaction: t }
            );

            if (entregado) {
                entregados++;
            } else {
                fallidos++;
                console.error(
                    `[canalGateway] Entrega de ${mensaje.id_mensaje} (${mensaje.canal}) falló` +
                        `${marca.agotado ? ' y agotó los intentos → dead letter' : ', se reintentará'}: ${motivo}`
                );
            }
        }

        await t.commit();
    } catch (error) {
        await t.rollback();
        throw error;
    }

    return { procesados: pendientes.length, entregados, fallidos };
}

/** Un tick. Nunca deja escapar un error: el entregador no puede morirse solo. */
async function tick() {
    if (entregando) return;
    entregando = true;
    try {
        await entregarUnaVez();
    } catch (error) {
        console.error('[canalGateway] Error entregando mensajes:', error.message);
    } finally {
        entregando = false;
    }
}

function iniciar() {
    if (temporizador) return;

    if (adaptadores.size === 0) {
        console.log('[canalGateway] Sin adaptadores registrados — no se entrega nada.');
        return;
    }

    temporizador = setInterval(tick, CONFIG.intervaloMs);
    // `unref` sí, a diferencia del debounce del motor: esto es un sondeo, y un sondeo no debe
    // impedir que un script termine.
    temporizador.unref?.();
    console.log(
        `[canalGateway] Iniciado — canal(es): ${[...adaptadores.keys()].join(', ')}, ` +
            `sondeo cada ${CONFIG.intervaloMs}ms.`
    );
}

function detener() {
    if (temporizador) {
        clearInterval(temporizador);
        temporizador = null;
    }
}

module.exports = { CONFIG, registrar, obtener, limpiar, entregarUnaVez, iniciar, detener };
