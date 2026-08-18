/**
 * Orquestador — decide qué peldaño de la escalera de costo resuelve cada turno (ADR-018).
 *
 * ## La política es una tabla, no un `if/else`
 *
 * ADR-018 permite exactamente tres cosas para «quedar diseñado para cuatro niveles», y esta es
 * la primera: **el enrutado es una política, una tabla de reglas, no condicionales cableados en
 * el manejador. Añadir un nivel es añadir filas.** Si mañana aparece un modelo local barato como
 * Nivel 2, se inserta una fila con su predicado y nada más cambia.
 *
 * La tabla se evalúa **en orden y gana la primera que casa**, como un cortafuegos. El orden es
 * parte de la política: `tarea_en_curso` va antes que todo lo demás a propósito.
 *
 * ## Por qué el Nivel 1 va primero y no «cuando el modelo no sabe»
 *
 * Tentaba lo contrario: preguntar siempre al LLM y usar la FSM de reserva. Sería más listo y
 * mucho peor. El Nivel 1 es el único peldaño que **nunca falla, nunca cuesta, nunca alucina y
 * nunca se cae** (ADR-018), y a mitad de un agendamiento —con una hora apartada y un hold
 * corriendo— entregarle el volante a un modelo cambia un flujo determinista y probado por uno
 * que puede irse por otro lado. El LLM entra donde la FSM no llega: preguntas libres.
 *
 * ## Lo que esta fase NO enruta
 *
 * Nada de mutación. En F6 el modelo **solo ve capacidades de consulta** (`tipo === 'consulta'`),
 * así que un cliente que quiere agendar acaba siempre en la FSM. No es una limitación del
 * enrutado: es que las capacidades de mutación no existen para el modelo, que es la defensa
 * arquitectónica contra inyección de prompt del master-plan —«el peor error posible es una
 * respuesta equivocada, no una cita destruida»—.
 */
'use strict';

const { COMANDO } = require('../engine/manejadorDeterminista');

/** Los peldaños. Se nombran por lo que son, no por el modelo que los sirve hoy. */
const NIVEL = {
    DETERMINISTA: 'determinista',
    LLM: 'llm',
};

function normalizar(texto) {
    return String(texto || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .trim();
}

const TODOS_LOS_COMANDOS = new Set(
    Object.values(COMANDO)
        .flat()
        .map((c) => normalizar(c))
);

/**
 * Palabras que significan «quiero agendar». No pretenden entender: pretenden **no** mandar al
 * LLM un turno que la FSM resuelve gratis y mejor. Un falso negativo aquí cuesta unos céntimos
 * y una respuesta correcta; un falso positivo manda a la FSM a alguien que solo preguntaba, y la
 * FSM lo mete en un menú. Por eso la lista es corta y explícita.
 */
const INTENCION_AGENDAR = [
    'agendar',
    'agenda',
    'cita',
    'citas',
    'reservar',
    'reserva',
    'turno',
    'separar',
    'apartar',
];

/**
 * La política de enrutado. Cada fila: por qué existe, cuándo casa y a qué nivel manda.
 *
 * `regla` es enum-like porque se registra como paso en el Ledger: saber **por qué** un turno
 * fue a un nivel es la mitad de poder cambiar la política con datos en vez de con intuición
 * (ADR-018: «el registro por-nivel convierte la decisión de crecer en un dato»).
 */
const POLITICA = [
    {
        regla: 'nivel4_no_disponible',
        motivo:
            'No hay Nivel 4 utilizable (sin credencial, apagado, o el negocio no tiene ' +
            'capacidades de consulta habilitadas). El Nivel 1 no depende de nada externo.',
        nivel: NIVEL.DETERMINISTA,
        cuando: (ctx) => !ctx.llmDisponible,
    },
    {
        regla: 'tarea_en_curso',
        motivo:
            'Hay un agendamiento a medias. La FSM tiene el estado y las invariantes; soltarle ' +
            'el volante a un modelo a mitad de un hold es cambiar lo probado por lo probable.',
        nivel: NIVEL.DETERMINISTA,
        cuando: (ctx) => Boolean(ctx.tareaEnCurso),
    },
    {
        regla: 'comando_conocido',
        motivo: 'Saludo, menú, cancelar, sí/no: el Nivel 1 lo resuelve sin gastar un token.',
        nivel: NIVEL.DETERMINISTA,
        cuando: (ctx) => TODOS_LOS_COMANDOS.has(normalizar(ctx.texto)),
    },
    {
        regla: 'intencion_agendar',
        motivo:
            'Quiere agendar. En F6 el modelo no tiene capacidades de mutación, así que ' +
            'mandarlo al LLM solo produciría una promesa que nadie puede cumplir.',
        nivel: NIVEL.DETERMINISTA,
        cuando: (ctx) => {
            const t = normalizar(ctx.texto);
            return INTENCION_AGENDAR.some((p) => new RegExp(`\\b${p}\\b`).test(t));
        },
    },
    {
        regla: 'pregunta_libre',
        motivo: 'Ni comando ni flujo: es lo que la FSM contesta con un menú y el LLM contesta.',
        nivel: NIVEL.LLM,
        cuando: () => true,
    },
];

/**
 * Enruta un turno.
 *
 * @param {Object}  ctx
 * @param {string}  ctx.texto          — el mensaje agrupado del cliente.
 * @param {boolean} ctx.tareaEnCurso
 * @param {boolean} ctx.llmDisponible  — lo decide la composición, no este archivo.
 * @returns {{nivel: string, regla: string, motivo: string}}
 */
function enrutar(ctx) {
    for (const fila of POLITICA) {
        if (fila.cuando(ctx)) {
            return { nivel: fila.nivel, regla: fila.regla, motivo: fila.motivo };
        }
    }
    // Inalcanzable mientras la última fila sea el comodín. Si alguien la quita, que falle aquí
    // y no en un turno sin nivel asignado.
    throw new Error('La política de enrutado no tiene fila por defecto.');
}

module.exports = { NIVEL, POLITICA, enrutar, INTENCION_AGENDAR };
