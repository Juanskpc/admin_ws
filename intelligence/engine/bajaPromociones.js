/**
 * La baja de promociones vista desde una conversación (F0 de `docs/promociones-masivas.md`).
 *
 * ## Lo que este archivo NO hace, y es la decisión que importa
 *
 * **No pregunta nada.** Hubo una versión, el 2026-10-12, en la que el asistente le preguntaba a
 * cada cliente si quería recibir promociones, pegado a la confirmación de su pedido. Se eliminó el
 * mismo día por decisión del dueño, y el motivo es bueno: **nadie pregunta eso.** Al cliente de un
 * restaurante que está pidiendo una hamburguesa, una pregunta sobre publicidad no le aporta nada —
 * no la pidió, no la espera y lo único que hace es alargar el mensaje que sí quería leer. La
 * publicidad que recibe cualquiera funciona así: llega, y se ignora o se da de baja.
 *
 * Así que el flujo conversacional de un pedido **queda intacto**, y lo único que vive aquí es la
 * salida. Que no es poco: es lo que convierte «le mandamos publicidad a nuestros clientes» en algo
 * que se puede defender.
 *
 * Es de plataforma —vale para restaurante, para reserva y para el vertical que venga—, por eso
 * está en `engine/` y no en un adaptador. Es la lección de `unirRespuestas`, que nació dentro de
 * `adapters/reserva/flujoCita.js` y hubo que subir aquí cuando se descubrió que nadie la había
 * llevado a restaurante: **una regla de plataforma dentro de un adaptador solo se aplica al
 * adaptador que la escribió.**
 *
 * ## ⚠️ Por qué esto NO es `optout.js`, y por qué eso importa tanto
 *
 * `optout.js` es la baja **dura**: `STOP` / `BAJA` deja la conversación `bloqueada`, el motor no
 * vuelve a procesarla, el asistente se calla para siempre y **el cliente no puede volver por su
 * cuenta** — hace falta un humano. Eso es lo correcto para «no me escriban nunca más».
 *
 * Pero sería una trampa anunciárselo a quien solo no quiere publicidad. El cliente que escribe la
 * palabra que nosotros le enseñamos esperando dejar de recibir promociones **perdería el canal por
 * el que pide la comida**, y se enteraría la próxima vez que tuviera hambre. Por eso:
 *
 *   · la baja blanda **saca de las promociones y deja la conversación viva**, y
 *   · lo que se escribe en la promoción es **«no promos»**, nunca «BAJA».
 *
 * La dura sigue existiendo y gana siempre: se comprueba antes (ver `manejadorEscalera`). Y desde
 * el 2026-10-12 marca además `promos_excluido`, que es un agujero que llevaba abierto desde F8-A:
 * una conversación bloqueada no impedía que una campaña —que mira fichas, no conversaciones— le
 * escribiera igual.
 *
 * ## Dónde se le dice al cliente que puede darse de baja
 *
 * En la **promoción misma**, no antes: pie de la plantilla o botón de respuesta rápida (F2). Es
 * donde lo pone cualquiera que manda publicidad por WhatsApp, es donde el cliente lo busca cuando
 * le molesta, y no le cuesta un mensaje a nadie. Mientras no exista el envío, estas palabras ya
 * funcionan: alguien que las escriba hoy queda fuera de la primera campaña que se mande.
 */
'use strict';

const { esComando } = require('./texto');

/**
 * Lo que el cliente escribe para no recibir más promociones.
 *
 * Exactas, no frases: `esComando` compara la última línea entera. Entender «ya no me manden tanta
 * publicidad por favor» es trabajo del Nivel 4, y fingirlo con una expresión regular produce el
 * peor de los mundos — un parser que acierta lo justo para que nadie note cuándo falla
 * (`texto.js`).
 *
 * ⚠️ **`promociones` a secas no está, y no puede estar.** En un restaurante es justo lo que
 * escribe quien QUIERE ver las promociones del día. Darle de baja a quien pregunta por ellas es
 * exactamente al revés.
 */
const PALABRAS_BAJA = [
    'no promos',
    'no promo',
    'nopromos',
    'no promociones',
    'no quiero promos',
    'no quiero promociones',
    'no mas promos',
    'no mas promociones',
    'sin promociones',
    'sin promos',
    'no publicidad',
    'no quiero publicidad',
    'stop promos',
    'stop promociones',
    'baja promociones',
];

/** ¿Este turno pide la baja de promociones (la blanda)? */
function bajaPedida(texto) {
    return esComando(texto, PALABRAS_BAJA);
}

/**
 * Lo que se le contesta.
 *
 * Cuesta un mensaje de servicio y se manda igual: es **uno por cliente**, y una baja sin acuse se
 * lee como que no se registró —que es justo la duda que lleva a bloquear el número—. La segunda
 * frase está para que no quede ninguna duda de que sigue pudiendo pedir por aquí.
 */
const RESPUESTA =
    'Listo, no te mandamos más promociones ✅ Seguimos aquí para cuando quieras pedir.';

/**
 * La decisión del turno: registrar la baja y decirlo.
 *
 * Determinista: no pasa por el modelo, así que no cuesta IA, y cierra el asunto en un mensaje.
 */
function decision(conversacion) {
    return {
        pasos: [
            {
                tipo: 'regla',
                decision: 'promos_baja',
                motivo: {
                    nivel: 'determinista',
                    por_que:
                        'Baja de promociones: saca la ficha de la audiencia y deja la ' +
                        'conversación viva (la baja dura es STOP/BAJA, ver optout.js).',
                },
            },
        ],
        // Una cadena suelta, que es la forma corta que ya usa `confirmacion.cerrar`. El objeto
        // `{texto, opciones}` existe para los menús con botones y aquí no hace falta.
        respuestas: [RESPUESTA],
        variables: conversacion?.variables || {},
        resultado: 'resuelto',
        nivel: 'determinista',
    };
}

module.exports = { PALABRAS_BAJA, bajaPedida, decision, RESPUESTA };
