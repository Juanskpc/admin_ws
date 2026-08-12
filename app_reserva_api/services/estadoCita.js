/**
 * Máquina de estados de la cita — qué transiciones existen y cuáles no.
 *
 * ## Qué arregla
 *
 * `cambiarEstado` hacía `cita.update({ estado: nuevoEstado })` sin mirar de dónde venía. El
 * CHECK de la base restringe el **destino** (los cinco estados válidos) pero no la
 * **transición**, así que se podía completar una cita cancelada o confirmar una que ya se
 * había completado. Las rutas son una por transición (`/confirmar`, `/completar`,
 * `/no-show`, `/cancelar`), de modo que el destino nunca fue libre desde HTTP — el origen sí.
 *
 * Curiosamente la guarda existía en un solo camino: `cancelarPorCliente` sí comprobaba que
 * la cita no estuviera ya cerrada. Estaba escrita una vez, en el sitio equivocado para que
 * sirviera a todos. Aquí está escrita una vez y sirve a todos.
 *
 * ## Por qué importa ahora
 *
 * Un formulario nunca ofrece «completar» sobre una cita cancelada: el botón no está. Un
 * agente que razona sobre una foto vieja de la conversación sí lo intenta —el cliente pudo
 * cancelar por teléfono hace dos turnos— y ADR-010 es explícito: el contexto conversacional
 * es una pista, nunca un hecho. El dominio es quien tiene que decir que no.
 */
'use strict';

/** Estados que la base admite (espejo de `reserva_cita_estado_check`). */
const ESTADO = {
    PENDIENTE: 'pendiente',
    CONFIRMADA: 'confirmada',
    COMPLETADA: 'completada',
    CANCELADA: 'cancelada',
    NO_SHOW: 'no_show',
};

/**
 * Transiciones válidas. Lo que no está aquí, no se puede.
 *
 * `completada`, `cancelada` y `no_show` son **terminales**: una cita cerrada no se reabre.
 * Si un negocio se equivoca marcando un no-show, la respuesta es crear una cita nueva, no
 * resucitar la vieja — reabrirla falsearía el historial y dejaría un hueco de agenda que
 * ya se había liberado y pudo darse a otro cliente.
 *
 * `pendiente → completada` sí se permite: el cliente que llega y se atiende sin que nadie
 * pulse «confirmar» antes es lo normal en un mostrador, no una anomalía.
 */
const TRANSICIONES = {
    [ESTADO.PENDIENTE]: [ESTADO.CONFIRMADA, ESTADO.COMPLETADA, ESTADO.CANCELADA, ESTADO.NO_SHOW],
    [ESTADO.CONFIRMADA]: [ESTADO.COMPLETADA, ESTADO.CANCELADA, ESTADO.NO_SHOW],
    [ESTADO.COMPLETADA]: [],
    [ESTADO.CANCELADA]: [],
    [ESTADO.NO_SHOW]: [],
};

/** Estados en los que la cita todavía puede cambiar. */
const TERMINALES = Object.entries(TRANSICIONES)
    .filter(([, destinos]) => destinos.length === 0)
    .map(([estado]) => estado);

function esTerminal(estado) {
    return TERMINALES.includes(estado);
}

function puedeTransitar(desde, hasta) {
    return (TRANSICIONES[desde] || []).includes(hasta);
}

/**
 * Comprueba la transición o lanza un error tipado.
 *
 * @throws TRANSICION_INVALIDA (409)
 */
function exigirTransicion(desde, hasta) {
    if (desde === hasta) {
        // Repetir la transición no es un error de negocio: quien pulsa dos veces «confirmar»
        // quería una cita confirmada y la tiene. Se distingue con su propio código para que
        // quien llame pueda tratarlo como éxito idempotente si le conviene.
        const e = new Error(`La cita ya está en estado "${hasta}".`);
        e.code = 'TRANSICION_REDUNDANTE';
        e.statusCode = 409;
        throw e;
    }

    if (!puedeTransitar(desde, hasta)) {
        const e = new Error(
            esTerminal(desde)
                ? `Una cita "${desde}" ya está cerrada y no admite más cambios.`
                : `No se puede pasar de "${desde}" a "${hasta}".`
        );
        e.code = 'TRANSICION_INVALIDA';
        e.statusCode = 409;
        throw e;
    }
}

module.exports = { ESTADO, TRANSICIONES, TERMINALES, esTerminal, puedeTransitar, exigirTransicion };
