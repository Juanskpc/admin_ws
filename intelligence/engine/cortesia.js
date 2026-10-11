/**
 * Cortesías al final de una conversación: «gracias», «ok», «listo», un sticker, un 👍.
 *
 * ## Por qué existe (pedido del dueño, 2026-10-01)
 *
 * En la primera noche de Zona Burger el bot contestó «¡Con gusto!» a un «Gracias» y, cuando el
 * cliente volvió a escribir «Gracias», contestó otra vez «¡Con gusto!» — cada vez con una llamada
 * al modelo. No aporta nada al cliente y cuesta créditos. La regla:
 *
 *   1. Una cortesía de cierre no se contesta: silencio, hasta que el cliente escriba algo con
 *      contenido. Da igual que agradezca, que asienta o que mande un sticker.
 *   2. Si el último mensaje del asistente fue una PREGUNTA, la cortesía puede ser la respuesta
 *      («¿la quieres para recoger?» → «ok»): esa NO se toca y sigue su camino normal. Un sticker o
 *      una reacción nunca contestan una pregunta, así que no se salvan por aquí.
 *   3. Con una tarea a medias (un pedido, una cita, una confirmación pendiente) no se toca nada:
 *      ahí «ok» o «listo» significan algo y los lee el flujo.
 *
 * ## Por qué el «¡Con gusto!» también se calló (2026-10-10)
 *
 * Hasta el 2026-10-10 el PRIMER agradecimiento de cierre sí se contestaba, una vez, con una frase
 * fija. Tenía sentido cuando el mensaje era gratis: costaba $0 de modelo y dejaba la conversación
 * cerrada con educación. Ya no lo es. La auditoría de Zona Burger de ese día contó **47 «¡Con
 * gusto! 😊» en seis días**, el 4 % de todo lo que mandó el asistente, y el número iba camino de
 * pasarse del techo de mensajes del plan a fin de mes. Los 47 llegaron detrás de un «Gracias» o un
 * «Muchas gracias» a secas, con la conversación ya terminada.
 *
 * Callar ahí no es descortesía: en WhatsApp nadie contesta al «gracias» final, el cliente ve el
 * visto, y el propio módulo ya callaba el segundo «gracias» y cualquier «ok». Lo que se hizo fue
 * quitar la excepción, no inventar una regla. Si algún día el techo deja de ser el límite y se
 * quiere recuperar la frase, está en `RESPUESTA` y el único cambio es volver a devolverla.
 *
 * El silencio aquí es deliberado y es la excepción a la regla de `manejadorEscalera.js` («el
 * modo de fallo caro es el silencio»): ese silencio es el de un cliente que preguntó algo y se
 * quedó esperando; este es el de no contestarle nada a un «gracias» con el que ya se despidió.
 */
'use strict';

const { normalizar } = require('./texto');

/** Palabras que no piden nada: agradecer, asentir, despedirse, avisar que va en camino. */
const PALABRA_CORTES = new Set([
    'gracias', 'muchas', 'mil', 'muchisimas', 'grs', 'grax', 'thanks', 'thank', 'you',
    'ok', 'okey', 'oki', 'okis', 'okay', 'vale', 'listo', 'lista', 'bueno', 'buena', 'bn',
    'perfecto', 'perfecta', 'dale', 'de', 'una', 'chevere', 'genial', 'excelente', 'super',
    // «sí» NO está, a propósito: un sí suelto casi siempre contesta algo y callarlo es peor
    // que gastar un turno.
    'bien', 'muy', 'entendido', 'entiendo', 'ya',
    'igualmente', 'amen', 'bendiciones', 'dios', 'le', 'lo', 'la', 'te', 'les', 'pague',
    'bendiga', 'que', 'q', 'con', 'gusto', 'a', 'ti', 'usted', 'ustedes', 'tambien',
    'veci', 'vecino', 'vecina', 'mi', 'amor', 'reina', 'rey', 'amigo', 'amiga', 'senor', 'senora',
    'feliz', 'noche', 'dia', 'tarde', 'buenas', 'buen', 'chao', 'chau', 'adios', 'bye', 'nos',
    'vemos', 'hablamos', 'pendiente', 'estoy', 'quedo', 'atento', 'atenta', 'espero', 'esperando',
    'paso', 'voy', 'vamos', 'van', 'llego', 'ahi', 'alla', 'ahorita', 'pasan', 'por', 'el', 'ella',
    'recibido', 'recibi', 'llego', 'todo', 'y', 'aja', 'aa', 'ah', 'oh', 'listico', 'vale',
    // Cierres reales que no estaban (Zona Burger, 2026-10-02): «Otey», «perfecto, ya bajo, vecino»,
    // «Vale igual ya voy subiendo», «Vale veci que pena», «Ya pasó por ellas».
    'otey', 'oki', 'okey', 'okay', 'bajo', 'bajando', 'subo', 'subiendo', 'salgo', 'saliendo',
    'pena', 'igual', 'ellas', 'ellos', 'paso', 'listo', 'lista', 'ok',
]);

/** Risas, alargamientos y signos: «jajaja», «okkk», «graciasss», «oooo». */
const RUIDO = /^(j+a+(j+a*)*|j+e+(j+e*)*|h+a+(h+a*)*|o+|a+h*|e+h*|m+|u+f+|o+k+|g+r+a+c+i+a+s+)$/;

/** Marcadores que pone el canal a lo que no es texto. Una imagen o un audio NO son cortesía. */
const MEDIO_COMO_CORTESIA = /^\[(sticker|reaction)\]$/i;

const MAX_PALABRAS = 8;

/** El último mensaje del asistente pide un dato aunque no lleve «?» («necesito tu número…»). */
const PIDE_ALGO =
    /\b(necesito|me falta|me faltan|falta|faltan|me (dices|das|compartes|regalas|confirmas|escribes|pasas|envias|mandas)|dime|escribeme|enviame|mandame|compartenos|compartime|compartirme|pasame|regalame)\b/;

/**
 * ¿El mensaje (toda la ráfaga) es solo cortesía? Cada línea tiene que serlo.
 *
 * `soloMedio` dice que no había **ni una palabra**: solo stickers o reacciones. Importa porque un
 * sticker no contesta una pregunta (ver `decidir`).
 *
 * @returns {{cortesia: boolean, agradece: boolean, soloMedio: boolean}}
 */
function leer(texto) {
    const lineas = String(texto || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    if (lineas.length === 0) return { cortesia: false, agradece: false, soloMedio: false };

    let agradece = false;
    let palabrasVistas = 0;
    for (const linea of lineas) {
        if (MEDIO_COMO_CORTESIA.test(linea)) continue;
        if (/^\[[a-z_]+\]$/i.test(linea)) return { cortesia: false, agradece: false, soloMedio: false };
        // Un número es un DATO —un teléfono, el número de la casa, una cantidad—, nunca una
        // cortesía. Zona Burger, 2026-10-02: «3218245714» quedaba sin palabras al quitarle lo que
        // no son letras, contaba como cortesía, y el bot se calló con un pedido a medias.
        if (/\d/.test(linea)) return { cortesia: false, agradece: false, soloMedio: false };
        const palabras = normalizar(linea)
            // Emojis, signos y números fuera: un «🙏🙏» o un «👍» es cortesía, y no son palabras.
            .replace(/[^a-zñ\s]/g, ' ')
            .split(/\s+/)
            .filter(Boolean);
        if (palabras.length > MAX_PALABRAS) return { cortesia: false, agradece: false, soloMedio: false };
        for (const p of palabras) {
            if (!PALABRA_CORTES.has(p) && !RUIDO.test(p)) return { cortesia: false, agradece: false, soloMedio: false };
            if (/^(g+r+a+c+i+a+s+|grs|grax|thanks|bendiciones|bendiga|pague)$/.test(p)) agradece = true;
        }
        palabrasVistas += palabras.length;
    }
    return { cortesia: true, agradece, soloMedio: palabrasVistas === 0 };
}

/** Variable de sesión: ya se vio una cortesía de cierre y no ha habido nada útil desde entonces. */
const MARCA = 'cortesia_contestada';

/**
 * La frase con la que se contestaba el primer agradecimiento hasta el 2026-10-10. Ya no se manda
 * (ver la cabecera); se conserva porque es el único cambio que hay que deshacer para recuperarla.
 */
const RESPUESTA = '¡Con gusto! 😊';

/**
 * La decisión para este turno, o `null` si no aplica (y entonces el turno sigue como siempre).
 *
 * @param {Object} ctx — el del turno: `conversacion`, `texto`.
 * @param {Object} opciones
 * @param {boolean} opciones.hayTarea — tarea o confirmación pendiente.
 * @param {Function} opciones.ultimoDelAsistente — async () => texto del último saliente o null.
 */
async function decidir(ctx, { hayTarea, ultimoDelAsistente }) {
    const variables = ctx.conversacion?.variables || {};
    const { cortesia, soloMedio } = leer(ctx.texto);

    if (!cortesia) {
        // Algo con contenido: se olvida la marca para que la conversación vuelva a empezar
        // limpia. Se muta a propósito (como la tarea caducada en `manejadorEscalera`): el
        // turno que sigue copia estas variables.
        if (variables[MARCA] && ctx.conversacion) {
            const { [MARCA]: _fuera, ...resto } = variables;
            ctx.conversacion.variables = resto;
        }
        return null;
    }

    // Un primer mensaje (un sticker para empezar) merece la bienvenida, no silencio.
    if (!Number(variables.turnos || 0) || variables._sesion_nueva === true) return null;
    if (hayTarea) return null;

    let ultimo;
    try {
        ultimo = String((await ultimoDelAsistente()) || '').trim();
    } catch (_) {
        // Sin poder ver qué dijo el asistente no se puede saber si esto es una respuesta: se
        // deja pasar el turno como siempre. Callar a ciegas no.
        return null;
    }
    // «¿La quieres para recoger?» → «ok»: eso es una respuesta, no una despedida. Cualquier
    // pregunta en el último mensaje cuenta, aunque detrás venga una nota («_El total es…_»).
    //
    // Un sticker o una reacción NO entran por aquí (2026-10-10): no contestan una pregunta. En la
    // auditoría de Zona Burger, 5 de los 22 stickers del periodo despertaron al asistente porque
    // el mensaje anterior llevaba un «?», y lo que salió fue un «😊 ¿Te muestro algo del menú?»
    // que nadie había pedido. Con una tarea a medias el flujo ya lo ha leído antes (`hayTarea`),
    // así que el 👍 que confirma un pedido sigue llegando a quien lo entiende.
    if (!soloMedio) {
        if (!ultimo || /[?¿]/.test(ultimo)) return null;
        // Lo mismo cuando el asistente PIDIÓ algo sin signo de pregunta: «Para mandártelo necesito
        // un número de contacto 📱». Lo que llega después es la respuesta, no una despedida.
        if (PIDE_ALGO.test(normalizar(ultimo))) return null;
    } else if (!ultimo) {
        return null;
    }

    return {
        pasos: [{
            tipo: 'regla',
            decision: 'cortesia_sin_respuesta',
            motivo: {
                nivel: 'determinista',
                por_que: 'Cortesía de cierre: contestarla no le aporta nada al cliente y gasta un ' +
                    'mensaje facturado del número (pedido del dueño 2026-10-01, ampliado al ' +
                    'agradecimiento el 2026-10-10 por el techo de mensajes).',
            },
        }],
        respuestas: [],
        variables: { ...variables, [MARCA]: true },
        resultado: 'sin_respuesta',
        nivel: 'determinista',
    };
}

module.exports = { leer, decidir, MARCA, RESPUESTA };
