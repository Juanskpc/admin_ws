'use strict';

const Models = require('../../app_core/models/conection');
const realtime = require('../../app_core/realtime');

/**
 * avisoService — qué se le avisa a las pantallas de reserva cuando algo cambia (SSE).
 *
 * Mismo modelo que el restaurante (`app_restaurante_api/services/avisoService.js`): lo que viaja
 * es una SEÑAL («cambió algo de la agenda del negocio 10») y cada pantalla vuelve a pedir sus
 * datos por el endpoint de siempre, con sus permisos de siempre.
 *
 *   agenda → citas y bloqueos: se crean, se mueven, cambian de estado, se cobran o se borran.
 *
 * ## Por qué con hooks del modelo y no en cada servicio
 *
 * Una cita nace o cambia desde muchos sitios: el panel, el portal público, el asistente de
 * WhatsApp (por el Policy Gate), el cobro, los recordatorios. Avisar a mano en cada uno es
 * garantizar que el día que se añada otro, la agenda deje de enterarse. Todos escriben con
 * `create` / `update` / `destroy` de instancia —no hay SQL crudo sobre estas tablas—, así que
 * los hooks los cubren a todos, también a los que todavía no existen.
 *
 * ## Avisar DESPUÉS del commit
 *
 * El Policy Gate ejecuta las capacidades dentro de una transacción para poder hacer dry-run
 * (simular y deshacer). Un aviso emitido dentro anunciaría una cita que nunca existió. Por eso,
 * con transacción, el aviso se cuelga de `afterCommit` y solo sale si confirma.
 */

const CANAL = 'reserva';

const TEMAS = Object.freeze({
    AGENDA: 'agenda',
});

/** Avisa ya. */
function avisar(idNegocio, ...temas) {
    if (!idNegocio) return 0;
    return realtime.emitir({ canal: CANAL, idNegocio, temas });
}

/** Avisa solo si la transacción confirma (o ya, si no hay transacción). */
function avisarTrasCommit(transaction, idNegocio, ...temas) {
    if (!transaction || typeof transaction.afterCommit !== 'function') {
        return avisar(idNegocio, ...temas);
    }
    transaction.afterCommit(() => avisar(idNegocio, ...temas));
    return 0;
}

let registrado = false;

/**
 * Engancha los avisos a los modelos de la agenda. Idempotente: se puede llamar desde varios
 * sitios de arranque (rutas, asistente) sin duplicar avisos.
 */
function registrarHooks() {
    if (registrado) return;
    registrado = true;

    const alCambiar = (instancia, options) => {
        try {
            avisarTrasCommit(options?.transaction, instancia?.id_negocio, TEMAS.AGENDA);
        } catch (err) {
            // Un aviso que falla no puede tumbar la escritura de una cita.
            console.warn('[reserva/avisos] no se pudo avisar:', err.message);
        }
    };

    for (const modelo of [Models.ReservaCita, Models.ReservaBloqueo]) {
        if (!modelo) continue;
        modelo.addHook('afterCreate', 'avisoAgenda', alCambiar);
        modelo.addHook('afterUpdate', 'avisoAgenda', alCambiar);
        modelo.addHook('afterDestroy', 'avisoAgenda', alCambiar);
    }
}

module.exports = { CANAL, TEMAS, avisar, avisarTrasCommit, registrarHooks };
