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
 * ## Qué cambió en F7, y qué no
 *
 * En F6 el modelo **solo veía consultas**, así que todo lo que oliera a mutación tenía que acabar
 * en la FSM. Desde F7 el modelo puede pedir mutaciones —y la plataforma le pregunta al cliente
 * antes de ejecutarlas (ADR-010)—, así que el enrutado deja de ser una jaula y vuelve a ser lo
 * que dice ser: una política de costo.
 *
 * Dos filas nuevas, y una que **no** se tocó:
 *
 *   - `confirmacion_pendiente` va primera: si hay una mutación esperando un sí, el turno es un
 *     «sí» o un «no», y eso lo lee el Nivel 1 gratis. Mandarlo al modelo sería pagar por leer
 *     una palabra y, peor, dejarle decidir si se ejecuta lo irreversible.
 *   - `intencion_mutacion` manda al modelo lo que la FSM **no sabe hacer**: cancelar y reagendar.
 *     Antes caían en `intencion_agendar` —«cancelar mi cita» contiene «cita»— y el cliente
 *     recibía un menú de servicios cuando lo que quería era anular. Era el agujero de producto
 *     más visible que dejó F6.
 *   - `intencion_agendar` **sigue yendo a la FSM**. Agendar funciona, es gratis y está probado de
 *     extremo a extremo; sustituirlo por el modelo sería cambiar lo probado por lo probable sin
 *     que nadie lo haya pedido. El día que se quiera, es mover una fila de esta tabla.
 */
'use strict';

const { COMANDO } = require('../engine/texto');

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
 * Palabras que significan «cambia o quita algo que ya tengo». Van **antes** de las de agendar
 * porque casi todas arrastran la palabra «cita» detrás.
 *
 * Ojo con «cancelar» a secas: ésa es un `COMANDO` y la fila `comando_conocido` la caza antes que
 * ésta, que es lo correcto — a mitad de un agendamiento, «cancelar» significa salir del flujo, no
 * anular una cita que todavía no existe.
 *
 * Son **principios de palabra**, no palabras enteras como las de agendar, y la diferencia importa:
 * nadie escribe «mover», escribe «muéveme la cita» o «cancélame lo del martes». Con palabra entera
 * eso caía en la FSM y el cliente recibía un menú de servicios. El riesgo del prefijo es mandar al
 * modelo a alguien que solo preguntaba «¿puedo cancelar si me surge algo?», y eso cuesta unos
 * céntimos y una respuesta correcta.
 */
const INTENCION_MUTACION = ['cancel', 'anul', 'reagend', 'muev', 'mover', 'cambi'];

/**
 * La política de enrutado. Cada fila: por qué existe, cuándo casa y a qué nivel manda.
 *
 * `regla` es enum-like porque se registra como paso en el Ledger: saber **por qué** un turno
 * fue a un nivel es la mitad de poder cambiar la política con datos en vez de con intuición
 * (ADR-018: «el registro por-nivel convierte la decisión de crecer en un dato»).
 */
const POLITICA = [
    {
        regla: 'confirmacion_pendiente',
        motivo:
            'Hay una mutación esperando el sí del cliente. Leer «sí» no necesita un modelo, y ' +
            'dejarle al modelo la decisión de disparar lo irreversible es lo que ADR-010 prohíbe.',
        nivel: NIVEL.DETERMINISTA,
        cuando: (ctx) => Boolean(ctx.confirmacionPendiente),
    },
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
        regla: 'flujo_reclama',
        motivo:
            'El flujo de la vertical dice que este mensaje es suyo. Un pedido armado en el menú ' +
            'digital no es una pregunta: es un dato exacto que una expresión regular lee mejor ' +
            'que un modelo, y más barato.',
        nivel: NIVEL.DETERMINISTA,
        // Quién decide es el adaptador (`flujos.registrar({ reclama })`); esta tabla solo lo
        // pregunta. El núcleo no sabe —ni debe— qué es un código de carrito (ADR-009).
        cuando: (ctx) => Boolean(ctx.flujoReclama),
    },
    {
        regla: 'intencion_mutacion',
        motivo:
            'Quiere cancelar o mover una cita, y la FSM no sabe hacer ni lo uno ni lo otro. ' +
            'Antes esto caía en «intencion_agendar» —la palabra «cita» está en las dos— y el ' +
            'cliente recibía un menú de servicios cuando pedía anular.',
        nivel: NIVEL.LLM,
        cuando: (ctx) => {
            const t = normalizar(ctx.texto);
            return INTENCION_MUTACION.some((p) => new RegExp(`\\b${p}`).test(t));
        },
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
 * @param {boolean} ctx.confirmacionPendiente — hay una mutación esperando el sí del cliente.
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

module.exports = { NIVEL, POLITICA, enrutar, INTENCION_AGENDAR, INTENCION_MUTACION };
