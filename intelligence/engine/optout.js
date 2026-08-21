/**
 * Baja de la lista — `STOP` / `BAJA` (F8-A).
 *
 * ## Por qué esto está por encima de la tabla de enrutado
 *
 * El master-plan lo pide literalmente: *«Opt-out (`STOP`/`BAJA`) como **Nivel 1, inmediato e
 * irrevocable por el modelo**. Es obligación legal, no una preferencia.»*
 *
 * La tabla del orquestador decide **qué peldaño** resuelve un turno; es una política de costo. Aquí
 * no hay peldaño que elegir: nadie llega a pensar. Por eso la comprobación va **antes** de
 * `enrutar()` y no como una fila más — una fila implicaría que algún día otra fila podría ganarle,
 * y a esta no puede ganarle ninguna.
 *
 * ## Y el bot se calla del todo, sin despedirse
 *
 * Se decidió no mandar un «listo, te damos de baja». Muchas jurisdicciones permiten esa
 * confirmación y ninguna la exige, y mandarla obliga a abrir una excepción en el entregador para
 * dejar salir *un* mensaje de una conversación ya bloqueada. Una excepción en la regla «a este
 * contacto no se le escribe más» es exactamente la clase de excepción que un día se usa para otra
 * cosa. Silencio: es lo que la persona pidió.
 *
 * **Consecuencia que hay que conocer:** al quedar `bloqueada`, el motor deja de procesar sus
 * mensajes (`ESTADOS_PROCESABLES` no la incluye) y `asegurarConversacion` **no** la reactiva
 * aunque vuelva a escribir. Así que un cliente que escribió `STOP` por error **no puede volver por
 * su cuenta**: hace falta un humano. Es deliberado — fallar cerrado en una obligación legal— y es
 * trabajo de la Consola poder deshacerlo (F8-B).
 *
 * ## Las palabras
 *
 * Cortas, exactas y en las dos lenguas del canal. Se comparan contra la última línea del turno,
 * igual que un «sí»: `texto.js` es el único sitio del proyecto que sabe leer lo que escribió una
 * persona, y tener dos lecturas distintas sería tener dos bots.
 *
 * No se aceptan frases («ya no quiero que me escriban»): eso lo entiende el Nivel 4, no una lista
 * de palabras, y confundir «no me escribas más» con «no» en medio de una confirmación sería peor
 * que no reconocerlo. Si mañana hace falta, es el LLM quien lo detecta y llama a esto.
 */
'use strict';
const { esComando } = require('./texto');

/** Estado al que pasa la conversación. Está en el CHECK de `intelligence.conversacion` (F5-A). */
const ESTADO_BLOQUEADA = 'bloqueada';

/**
 * Las palabras de baja. `STOP` es el estándar de facto en WhatsApp y SMS; `BAJA` y `CANCELAR
 * SUSCRIPCION` son las formas en español que un cliente colombiano escribiría.
 *
 * ⚠️ **`CANCELAR` a secas no está, y no puede estar.** En Nivel 1 esa palabra ya significa «sal de
 * este flujo», y en F7 significa además «no ejecutes la mutación que estás confirmando». Meterla
 * aquí convertiría a alguien que quiere salir de un menú en alguien dado de baja para siempre.
 */
const PALABRAS = [
    'stop',
    'baja',
    'darme de baja',
    'no mas mensajes',
    'no más mensajes',
    'cancelar suscripcion',
    'cancelar suscripción',
    'unsubscribe',
];

/** ¿Este turno es una baja? */
function pedida(texto) {
    return esComando(texto, PALABRAS);
}

/**
 * La decisión del turno: bloquear y no decir nada.
 *
 * `respuestas: []` hace que el motor cierre el turno como `sin_respuesta`, y **está bien**: desde
 * fuera no hubo respuesta. Contarlo como `resuelto` inflaría la pregunta 11 del Ledger con turnos
 * en los que el asistente no resolvió nada, y contarlo como error escondería que el sistema hizo
 * justo lo que debía.
 */
function decision(conversacion) {
    return {
        pasos: [{ tipo: 'regla', decision: 'baja_solicitada', motivo: { silencio: true } }],
        respuestas: [],
        variables: conversacion?.variables || {},
        // La tarea se tira: quien se da de baja no está a medias de agendar nada.
        tarea: null,
        estado: ESTADO_BLOQUEADA,
        resultado: 'sin_respuesta',
        nivel: 'determinista',
    };
}

module.exports = { pedida, decision, PALABRAS, ESTADO_BLOQUEADA };
