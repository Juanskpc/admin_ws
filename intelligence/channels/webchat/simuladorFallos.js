/**
 * Simulador de fallos del WebChat — **entregable explícito de F5-C**, no un extra (ADR-016).
 *
 * ## Por qué existe
 *
 * Las virtudes de un canal propio —control absoluto, sin webhooks, sin latencia, sin
 * límites— son exactamente **las mismas propiedades que ocultan los bugs que WhatsApp va a
 * exponer**. Un WebChat amable hace que el test de ráfaga, el de continuidad y el orden FIFO
 * pasen siempre, y no porque el motor esté bien, sino porque nadie lo puso a prueba.
 *
 * Así que el WebChat es el único canal que podemos hacer **peor que la realidad a propósito**.
 * Cada interruptor de aquí caza un bug concreto del motor:
 *
 * | Fallo | Qué caza |
 * |---|---|
 * | `duplicar`         | Deduplicación por `id_externo` |
 * | `reordenar`        | Que el turno se lea en el orden en que se escribió, no en el que llegó |
 * | `retrasoSalidaMs`  | Continuidad: que el motor no asuma entrega inmediata |
 * | `fallarSalida`     | Reintentos y *dead letter* |
 *
 * (La ráfaga no necesita interruptor: la manda el cliente. Y «matar el worker a mitad de
 * turno» no es del canal — lo cubre `motor.recuperar()` desde F5-B.)
 *
 * ## Está apagado por defecto y es por sesión
 *
 * Por sesión y no global porque si no, no se podría mirar una conversación sana mientras otra
 * está siendo maltratada. Y apagado por defecto porque un canal hostil por accidente es un
 * canal roto.
 *
 * No hay nada persistido: la configuración vive en memoria y se pierde al reiniciar. Es
 * correcto — es una herramienta de desarrollo, no un ajuste del negocio.
 */
'use strict';

/** Nada de esto se activa solo. */
const APAGADO = {
    duplicar: false,
    reordenar: false,
    retrasoSalidaMs: 0,
    /** Cuántos intentos de entrega seguidos fallan. `0` = ninguno. */
    fallarSalida: 0,
};

/** Tope del retraso inyectable. Ver la nota sobre transacciones largas, abajo. */
const RETRASO_MAXIMO_MS = 30000;

/** Map<clave, config> */
const configuraciones = new Map();
/** Map<clave, mensaje retenido> — el buffer del reordenamiento. */
const retenidos = new Map();
/** Map<idMensaje, intentos fallados hasta ahora> — para `fallarSalida`. */
const fallosServidos = new Map();

const clave = (idNegocio, idExterno) => `${idNegocio}:${idExterno}`;

function configurar(idNegocio, idExterno, fallos = {}) {
    const config = {
        ...APAGADO,
        ...configuraciones.get(clave(idNegocio, idExterno)),
        ...fallos,
    };

    config.duplicar = Boolean(config.duplicar);
    config.reordenar = Boolean(config.reordenar);
    config.retrasoSalidaMs = Math.max(
        0,
        Math.min(RETRASO_MAXIMO_MS, Number(config.retrasoSalidaMs) || 0)
    );
    config.fallarSalida = Math.max(0, Number(config.fallarSalida) || 0);

    configuraciones.set(clave(idNegocio, idExterno), config);
    return config;
}

function leer(idNegocio, idExterno) {
    return configuraciones.get(clave(idNegocio, idExterno)) || { ...APAGADO };
}

function limpiar() {
    configuraciones.clear();
    retenidos.clear();
    fallosServidos.clear();
}

/**
 * Decide qué mensajes canónicos entrega el «canal» a partir del que acaba de llegar.
 *
 * Devuelve una **lista** porque un solo mensaje del cliente puede convertirse en cero (se
 * retuvo para reordenar), dos (se duplicó) o dos en orden invertido (se soltó el retenido
 * después del nuevo).
 *
 * El reordenamiento es real, no cosmético: se retiene el primero y se entrega **después** del
 * segundo. Como cada mensaje lleva su `enviadoEn` del cliente, el motor puede reconstruir el
 * orden verdadero — y si no pudiera, el turno se leería del revés. Eso es justo lo que este
 * interruptor existe para demostrar.
 *
 * @returns {Array<Object>} mensajes canónicos, en el orden en que el canal los entrega.
 */
function aplicarEntrada(mensaje) {
    const config = leer(mensaje.idNegocio, mensaje.idExterno);
    const k = clave(mensaje.idNegocio, mensaje.idExterno);
    let salida = [mensaje];

    if (config.reordenar) {
        const retenido = retenidos.get(k);
        if (!retenido) {
            retenidos.set(k, mensaje);
            return [];
        }
        retenidos.delete(k);
        salida = [mensaje, retenido];
    }

    if (config.duplicar) {
        // El MISMO `idExternoMensaje`: si cambiara, no sería un duplicado del canal sino un
        // mensaje distinto, y no probaría la deduplicación en absoluto.
        salida = salida.flatMap((m) => [m, { ...m }]);
    }

    return salida;
}

/** Lo que quedó retenido y nadie soltó. Se usa al apagar `reordenar` para no perder mensajes. */
function soltarRetenido(idNegocio, idExterno) {
    const k = clave(idNegocio, idExterno);
    const retenido = retenidos.get(k);
    if (retenido) retenidos.delete(k);
    return retenido || null;
}

/**
 * Aplica los fallos de salida antes de entregar. Lanza si toca fallar.
 *
 * El retraso se duerme dentro de la transacción del entregador, que por eso está topado a 30
 * segundos: es aceptable en una herramienta de desarrollo y sería inaceptable en producción,
 * donde una transacción abierta media hora agota el pool.
 */
async function aplicarSalida({ idNegocio, idExterno, idMensaje }) {
    const config = leer(idNegocio, idExterno);

    if (config.fallarSalida > 0) {
        const servidos = fallosServidos.get(idMensaje) || 0;
        if (servidos < config.fallarSalida) {
            fallosServidos.set(idMensaje, servidos + 1);
            const error = new Error(
                `[simulador] entrega fallada a propósito (${servidos + 1}/${config.fallarSalida})`
            );
            error.code = 'SIMULADOR_ENTREGA_FALLIDA';
            throw error;
        }
    }

    if (config.retrasoSalidaMs > 0) {
        await new Promise((r) => setTimeout(r, config.retrasoSalidaMs));
    }
}

module.exports = {
    APAGADO,
    RETRASO_MAXIMO_MS,
    configurar,
    leer,
    limpiar,
    aplicarEntrada,
    soltarRetenido,
    aplicarSalida,
};
