/**
 * Cortesías al final de una conversación: «gracias», «ok», «listo», un sticker, un 👍.
 *
 * ## Por qué existe (pedido del dueño, 2026-10-01)
 *
 * En la primera noche de Zona Burger el bot contestó «¡Con gusto!» a un «Gracias» y, cuando el
 * cliente volvió a escribir «Gracias», contestó otra vez «¡Con gusto!» — cada vez con una llamada
 * al modelo. No aporta nada al cliente y cuesta créditos. La regla:
 *
 *   1. La PRIMERA cortesía de cierre que trae un agradecimiento se contesta una sola vez, con una
 *      frase fija ($0, sin modelo). Un «ok», un sticker o un emoji suelto no se contestan.
 *   2. Las siguientes se ignoran (silencio), hasta que el cliente escriba algo con contenido.
 *   3. Si el último mensaje del asistente fue una PREGUNTA, la cortesía puede ser la respuesta
 *      («¿la quieres para recoger?» → «ok»): esa NO se toca y sigue su camino normal.
 *   4. Con una tarea a medias (un pedido, una cita, una confirmación pendiente) no se toca nada:
 *      ahí «ok» o «listo» significan algo y los lee el flujo.
 *
 * El silencio aquí es deliberado y es la excepción a la regla de `manejadorEscalera.js` («el
 * modo de fallo caro es el silencio»): ese silencio es el de un cliente que preguntó algo; este
 * es el de no contestarle a un «gracias» por tercera vez.
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
 * @returns {{cortesia: boolean, agradece: boolean}}
 */
function leer(texto) {
    const lineas = String(texto || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    if (lineas.length === 0) return { cortesia: false, agradece: false };

    let agradece = false;
    for (const linea of lineas) {
        if (MEDIO_COMO_CORTESIA.test(linea)) continue;
        if (/^\[[a-z_]+\]$/i.test(linea)) return { cortesia: false, agradece: false };
        // Un número es un DATO —un teléfono, el número de la casa, una cantidad—, nunca una
        // cortesía. Zona Burger, 2026-10-02: «3218245714» quedaba sin palabras al quitarle lo que
        // no son letras, contaba como cortesía, y el bot se calló con un pedido a medias.
        if (/\d/.test(linea)) return { cortesia: false, agradece: false };
        const palabras = normalizar(linea)
            // Emojis, signos y números fuera: un «🙏🙏» o un «👍» es cortesía, y no son palabras.
            .replace(/[^a-zñ\s]/g, ' ')
            .split(/\s+/)
            .filter(Boolean);
        if (palabras.length > MAX_PALABRAS) return { cortesia: false, agradece: false };
        for (const p of palabras) {
            if (!PALABRA_CORTES.has(p) && !RUIDO.test(p)) return { cortesia: false, agradece: false };
            if (/^(g+r+a+c+i+a+s+|grs|grax|thanks|bendiciones|bendiga|pague)$/.test(p)) agradece = true;
        }
    }
    return { cortesia: true, agradece };
}

/** Variable de sesión: ya se contestó una cortesía y no ha habido nada útil desde entonces. */
const MARCA = 'cortesia_contestada';

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
    const { cortesia, agradece } = leer(ctx.texto);

    if (!cortesia) {
        // Algo con contenido: se olvida la marca para que el próximo «gracias» vuelva a tener
        // su respuesta. Se muta a propósito (como la tarea caducada en `manejadorEscalera`): el
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
    if (!ultimo || /[?¿]/.test(ultimo)) return null;
    // Lo mismo cuando el asistente PIDIÓ algo sin signo de pregunta: «Para mandártelo necesito un
    // número de contacto 📱». Lo que llega después es la respuesta, no una despedida.
    if (PIDE_ALGO.test(normalizar(ultimo))) return null;

    if (variables[MARCA] || !agradece) {
        return {
            pasos: [{
                tipo: 'regla',
                decision: 'cortesia_sin_respuesta',
                motivo: {
                    nivel: 'determinista',
                    por_que: 'Cortesía de cierre ya contestada o sin agradecimiento: contestarla no ' +
                        'le aporta nada al cliente y gasta un turno (pedido del dueño, 2026-10-01).',
                },
            }],
            respuestas: [],
            variables: { ...variables, [MARCA]: true },
            resultado: 'sin_respuesta',
            nivel: 'determinista',
        };
    }

    return {
        pasos: [{
            tipo: 'regla',
            decision: 'cortesia_contestada',
            motivo: { nivel: 'determinista', por_que: 'Primer agradecimiento de cierre: una frase fija, sin modelo.' },
        }],
        respuestas: [RESPUESTA],
        variables: { ...variables, [MARCA]: true },
        resultado: 'resuelto',
        nivel: 'determinista',
    };
}

module.exports = { leer, decidir, MARCA, RESPUESTA };
