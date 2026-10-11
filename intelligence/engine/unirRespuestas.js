/**
 * ── Dos mensajes que podían ser uno ──────────────────────────────────────────────────────
 *
 * Un turno puede decidir varias respuestas: un aviso y después una pregunta, el dato que pidió el
 * cliente y después el recordatorio de que su pedido sigue sin confirmar. Eran dos mensajes porque
 * daba igual: salían gratis. Desde el 1 de octubre de 2026 Meta cobra los *service messages*
 * pasada la asignación mensual del número, así que el aviso suelto tiene precio — y leerlo pegado a
 * la pregunta no es peor, es mejor: una notificación en lugar de dos para la misma cosa.
 *
 * ## Por qué vive en el motor y no en cada flujo
 *
 * Nació en `adapters/reserva/flujoCita.js` el 2026-10-02 y se quedó ahí. El 2026-10-10 la auditoría
 * de Zona Burger encontró 9 turnos del vertical **restaurante** que habían salido partidos en dos
 * mensajes, 8 de ellos la misma pareja: la respuesta del modelo y, suelto detrás, el «Todavía no he
 * enviado tu pedido. ¿Lo confirmo?» que le pega `manejadorEscalera.conSiPendiente`. La regla 1 de
 * `docs/whatsapp-costo-mensajes.md` §4 ya decía que esto va en un solo sitio «porque en cada rama
 * por separado sería olvidarlo en la que nadie probó» — y así fue, en el vertical que más mensajes
 * manda. Aplicado en el motor vale para todos los flujos, todos los verticales y también para el
 * turno del modelo, que es el que más veces devuelve dos cosas.
 *
 * ## Las dos reglas que no se pueden saltar
 *
 *   1. **Solo hacia delante, y una respuesta con opciones no absorbe a la siguiente.** El menú
 *      tiene que quedar al final, que es donde el canal lo pinta: un botón en medio del texto no
 *      se renderiza.
 *   2. **Si no cabe, se mandan los dos.** El tope depende de dónde acabe el texto, porque el
 *      cuerpo de un mensaje interactivo de WhatsApp admite mucho menos que un texto suelto.
 *
 * Es idempotente: pasar por aquí algo ya unido no lo cambia.
 */
'use strict';

/**
 * Tope del cuerpo de un mensaje interactivo de WhatsApp (1024 de Meta) y de un mensaje de texto
 * suelto (4096 de Meta, 4000 de `mensajeCanonico.MAX_TEXTO`), los dos con margen. Son del canal,
 * pero la decisión de **juntar o no** es de aquí.
 */
const TOPE_CUERPO = 950;
const TOPE_TEXTO = 3500;

/**
 * Junta las respuestas de una decisión en los menos mensajes posibles.
 *
 * @param {{respuestas?: Array<string|{texto: string, opciones?: Array}>}} decision
 * @returns {Object} la misma decisión con `respuestas` unidas (sin mutar la original)
 */
function unirRespuestas(decision) {
    const respuestas = decision?.respuestas || [];
    if (respuestas.length <= 1) return decision;

    const unidas = [];
    for (const cruda of respuestas) {
        const actual = typeof cruda === 'string' ? { texto: cruda } : { ...cruda };
        const previa = unidas[unidas.length - 1];
        if (previa && !previa.opciones?.length && typeof actual.texto === 'string') {
            const juntas = `${previa.texto}\n\n${actual.texto}`;
            if (juntas.length <= (actual.opciones?.length ? TOPE_CUERPO : TOPE_TEXTO)) {
                unidas[unidas.length - 1] = { ...actual, texto: juntas };
                continue;
            }
        }
        unidas.push(actual);
    }
    return { ...decision, respuestas: unidas };
}

module.exports = { unirRespuestas, TOPE_CUERPO, TOPE_TEXTO };
