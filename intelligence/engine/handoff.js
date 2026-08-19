/**
 * Handoff — cuando el asistente deja de hablar y le pasa la conversación a una persona.
 *
 * ## El problema que resuelve: la válvula de seguridad era el fallo
 *
 * El handoff existe para no dejar tirado a un cliente cuando el bot no sabe qué hacer. Pero la
 * frase que decía —«déjame consultarlo con alguien del negocio y te confirmo en un momento»—
 * **da por hecho que hay alguien al otro lado**. A las once de la noche, en una barbería de un
 * solo dueño, no lo hay: el cliente recibe esa promesa y luego silencio. Es peor que si el bot se
 * hubiera equivocado, porque una equivocación se corrige y una promesa incumplida del negocio no.
 *
 * Y había un segundo agujero, más tonto y más grave: **el handoff era solo una frase**. El estado
 * `handoff_humano` existe en el esquema desde F5-A y el motor ya lo trata como pasivo —en él el
 * bot se calla, porque uno hablando encima de una persona es peor que uno mudo— pero nadie lo
 * escribía nunca. Así que el bot prometía que intervenía una persona y **seguía contestando él**.
 *
 * ## Las tres decisiones del dueño (2026-08-18), que son las de ADR-023
 *
 * 1. **Decir que no hay nadie, y cuándo lo habrá.** Del horario del negocio si está configurado;
 *    si no, «en el transcurso del día». Textual: «no hay que complicarnos tanto por estas cosas»
 *    — así que aquí no hay festivos, ni turnos por empleado, ni zonas horarias por sucursal.
 * 2. La bandeja donde el humano ve lo pendiente **sigue abierta** y depende del canal.
 * 3. **El bot no vuelve.** Si se escaló, contesta una persona. Nada de recuperar la conversación
 *    pasadas unas horas: sería contradecir lo que ya se le prometió al cliente.
 *
 * ## Por qué el horario llega de fuera y no se consulta aquí
 *
 * Este módulo **no sabe leer un horario**: lo recibe en el contexto del negocio. Es deliberado —
 * ADR-020 clasifica los horarios como *Business Context*, configuración del inquilino, y su sitio
 * es `platform.business_context`, que aún no existe. El día que exista, cambia
 * `contextoNegocio.js` y aquí no se toca nada. Mientras tanto llega `null`, que **no es un fallo**:
 * es la rama «no hay horario» que el dueño ya decidió cómo se contesta.
 */
'use strict';

/** Estado al que pasa la conversación. Está en el CHECK de `intelligence.conversacion` (F5-A). */
const ESTADO_HANDOFF = 'handoff_humano';

/**
 * Cuándo se dice que habrá alguien, cuando el negocio no tiene horario configurado.
 *
 * No es una hora: es una franja honesta. Prometer «a las 9» sin saberlo es repetir el mismo error
 * que este módulo existe para arreglar, solo que con más precisión aparente.
 */
const CUANDO_SIN_HORARIO = 'en el transcurso del día';

function esHora(valor) {
    return typeof valor === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(valor.trim());
}

/**
 * La frase que se le dice al cliente al escalar.
 *
 * @param {{atencion?: {desde?: string, hasta?: string}|null}} negocio — el contexto del negocio.
 * @returns {string}
 */
function mensaje(negocio) {
    const desde = negocio?.atencion?.desde;
    // Solo se nombra una hora si es una hora de verdad. Un valor a medias en la configuración del
    // inquilino no puede convertirse en «te respondemos a partir de las undefined».
    const cuando = esHora(desde) ? `a partir de las ${desde.trim()}` : CUANDO_SIN_HORARIO;

    return (
        'Ahora mismo no tengo a nadie del negocio disponible para responderte. ' +
        `Le paso tu mensaje y te contestan ${cuando}.`
    );
}

/**
 * La decisión que el manejador devuelve al motor para escalar.
 *
 * `resultado: 'handoff'` **no** es cosmético: la pregunta 11 del Ledger (tasa de resolución)
 * cuenta los turnos resueltos, y un escalado no lo es. Hasta hoy se devolvía `'resuelto'` a
 * propósito, para no contar handoffs que nadie atendía; ahora que el escalado apaga al bot de
 * verdad, esa razón desaparece y contarlo mal escondería justo el número que hay que vigilar.
 *
 * @param {Object} base — lo que el manejador ya acumuló: `pasos`, `invocaciones`, `variables`…
 * @param {Object} negocio — contexto del negocio, para componer la frase.
 */
function decision(base, negocio) {
    return {
        ...base,
        respuestas: [mensaje(negocio)],
        estado: ESTADO_HANDOFF,
        resultado: 'handoff',
    };
}

module.exports = { decision, mensaje, ESTADO_HANDOFF, CUANDO_SIN_HORARIO };
