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
 * ## Con backoff desde F8-B, y antes no
 *
 * Hasta F8-A los reintentos iban al ritmo del sondeo, sin espera creciente, y estaba anotado
 * aquí por qué: el backoff necesitaba una columna `proximo_intento_en` en una tabla
 * particionada de alto volumen y no compraba nada mientras el único canal fuera local y sus
 * fallos instantáneos. Con WhatsApp devolviendo 429 de verdad, sí compra: sin espera, los
 * cinco intentos se consumen en cinco segundos y el mensaje acaba en *dead letter* sin que
 * Meta haya tenido tiempo de dejar de limitarnos. La columna existe desde
 * `migrate:intelligence-recordatorios` y la curva la aplica `repositorio.marcarEntrega`.
 *
 * ## Y el gateway ya distingue «vuelve a intentarlo» de «no insistas»
 *
 * `api.js` marcaba sus errores con `reintentable` desde F8-A y esto los trataba a todos igual.
 * Ahora un error que se declara no reintentable va al dead letter en el primer intento: un
 * número que no está en WhatsApp, o una ventana de 24 h cerrada, no se arreglan insistiendo.
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
    /** Techo del backoff. Cinco minutos: más allá, el mensaje caduca solo por `ventanaHoras`. */
    backoffMaxSegundos: numeroDeEntorno('CANAL_ENTREGA_BACKOFF_MAX_SEG', 300),
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
 *        idExterno, mensaje: { texto, opciones, plantilla } }) => {idExternoCanal?} | void.
 *        **Renderiza** las opciones como sepa su canal: botones, chips o una enumeración, y la
 *        `plantilla` si su canal las exige (F8-B) o la ignora si le basta el texto.
 *        Si lanza, se reintenta — salvo que el error traiga `reintentable: false`, que va
 *        directo al dead letter. Lo que devuelva se guarda como `mensaje.id_externo`: es el id
 *        del mensaje EN EL CANAL, y sin él un acuse posterior no se puede atar a nada.
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
            let reintentable = true;
            let idExternoCanal = null;

            if (!adaptador) {
                // No es un fallo del canal: es que nadie sabe hablar ese canal en este
                // proceso. Se cuenta como intento igual, porque si nunca aparece el
                // adaptador, insistir eternamente solo llena la tabla de trabajo muerto.
                motivo = `sin adaptador registrado para el canal "${mensaje.canal}"`;
            } else {
                try {
                    const acuse = await adaptador.entregar({
                        idMensaje: mensaje.id_mensaje,
                        idConversacion: mensaje.id_conversacion,
                        idNegocio: mensaje.id_negocio,
                        idTurno: mensaje.id_turno,
                        idExterno: mensaje.id_externo,
                        intento: (mensaje.intentos_entrega || 0) + 1,
                        mensaje: {
                            texto: mensaje.contenido,
                            opciones: mensaje.opciones || [],
                            // Un saliente que el negocio inicia viaja con su plantilla (F8-B).
                            // El canal que no tenga plantillas se queda con el texto, que ya
                            // viene compuesto: eso es renderizar segun el canal (ADR-017).
                            plantilla: mensaje.plantilla || null,
                        },
                    });
                    entregado = true;
                    // Lo que el canal devuelve al aceptar: el `wamid` de Meta. Sin guardarlo,
                    // un `status: failed` posterior no se puede atar a ninguna fila nuestra.
                    idExternoCanal = acuse?.idExternoCanal ?? acuse?.wamid ?? null;
                } catch (error) {
                    motivo = error.message;
                    reintentable = error.reintentable !== false;
                }
            }

            const marca = await repositorio.marcarEntrega(
                mensaje,
                {
                    entregado,
                    maxIntentos: CONFIG.maxIntentos,
                    reintentable,
                    backoffMaxSegundos: CONFIG.backoffMaxSegundos,
                    idExternoCanal,
                },
                { transaction: t }
            );

            if (entregado) {
                entregados++;
            } else {
                fallidos++;
                const desenlace = !marca.agotado
                    ? `, se reintentará en ${marca.esperaSegundos}s`
                    : reintentable
                      ? ' y agotó los intentos → dead letter'
                      : ' y no es reintentable → dead letter';
                console.error(
                    `[canalGateway] Entrega de ${mensaje.id_mensaje} (${mensaje.canal}) falló` +
                        `${desenlace}: ${motivo}`
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
