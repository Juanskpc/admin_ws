/**
 * El asistente reporta a quien lo está usando para nada.
 *
 * ## Por qué el bot opina de su interlocutor
 *
 * Desde que el Nivel 4 contesta, cada turno cuesta dinero de verdad, y el número del negocio es
 * público. Quien descubre que al otro lado hay un modelo de lenguaje tiene barra libre: no hace
 * falta mala fe, basta aburrimiento. El dueño del negocio lo ve en su bandeja —y desde F8-D
 * puede reportarlo a mano— pero hay dos cosas que él no ve y el motor sí: cuántos turnos han
 * subido al modelo y cuánto se ha gastado sin que pase nada.
 *
 * Esto es exactamente eso: el bot deja escrito lo que midió. Nada más.
 *
 * ## Los tres límites que hacen que esto no sea peligroso
 *
 * 1. **No bloquea, no calla al bot, no cambia el estado de la conversación.** El cliente no nota
 *    absolutamente nada. Si esta heurística se equivoca —y se va a equivocar— el coste es una
 *    fila que alguien descarta de un clic, no un cliente al que se dejó de contestar. Bloquear
 *    sigue siendo `estado = 'bloqueada'` y sigue exigiendo a una persona.
 * 2. **Un reporte por conversación, y mientras siga abierto no pone otro.** Lo garantiza
 *    `uq_reporte_asistente_abierto` en la base. Sin eso sería un contador de mensajes
 *    disfrazado de reputación.
 * 3. **Nunca rompe un turno.** Se llama dentro del turno para que la fila sea atómica con él,
 *    pero cualquier fallo aquí se traga con un WARNING: el día que la tabla no esté migrada, o
 *    que una consulta se ponga lenta, lo que no puede pasar es que un cliente se quede sin
 *    respuesta porque el bot estaba juzgándolo. Misma postura defensiva que `auditoria.fn_audit`.
 *
 * ## Por qué estas señales y no «el LLM que decida»
 *
 * Preguntarle al modelo «¿este usuario está abusando?» cuesta otra llamada por turno para
 * responder a una pregunta que ya está en el Ledger, y lo haría con menos información: los
 * números de abajo miran **24 horas**, no el turno actual. Una heurística barata y legible gana
 * aquí, y además se puede explicar a un cliente enfadado — `senales` guarda los números exactos
 * con los que se decidió.
 *
 * ## Las reglas
 *
 * Las tres comparten una misma idea: *hablar mucho no es sospechoso; hablar mucho sin que nunca
 * pase nada, sí*. `capacidades_ok` —cuántas veces el asistente llegó a hacer algo: un pedido,
 * una cita, una consulta— es la que distingue al cliente pesado del que juega.
 *
 *   · `sin_avance`   — muchos turnos, ninguna capacidad ejecutada, nada resuelto.
 *   · `automatizado` — el mismo texto repetido una y otra vez. Copiar y pegar es la forma más
 *                      barata de tener un bot gratis, y ninguna persona escribe así.
 *   · `spam`         — se gastó dinero de verdad en el modelo y no salió nada de ello.
 *
 * Los umbrales son generosos a propósito. Un cliente indeciso preguntando por el menú puede
 * gastar diez o quince turnos sin comprar nada, y eso es un cliente, no un abuso. Se ajustan por
 * entorno sin tocar código, y `INTELLIGENCE_REPORTE_AUTO=false` lo apaga entero.
 */
'use strict';
const repositorio = require('./repositorio');

function numeroDeEntorno(nombre, porDefecto) {
    const valor = Number(process.env[nombre]);
    return Number.isFinite(valor) && valor > 0 ? valor : porDefecto;
}

const CONFIG = {
    /** La ventana que se mira. Un día: lo que dura una racha de alguien con tiempo libre. */
    horas: numeroDeEntorno('INTELLIGENCE_REPORTE_HORAS', 24),
    /** Por debajo de esto no se mira nada: es una conversación normal. */
    turnosMinimos: numeroDeEntorno('INTELLIGENCE_REPORTE_TURNOS', 25),
    /** El mismo texto, tantas veces. Nadie escribe así sin querer. */
    repeticiones: numeroDeEntorno('INTELLIGENCE_REPORTE_REPETICIONES', 8),
    /** Dólares gastados en el modelo sin que el asistente llegara a hacer nada. */
    costoUsd: numeroDeEntorno('INTELLIGENCE_REPORTE_COSTO_USD', 0.5),
};

/** `false` explícito lo apaga. Cualquier otra cosa lo deja encendido. */
function activado() {
    return String(process.env.INTELLIGENCE_REPORTE_AUTO ?? 'true').toLowerCase() !== 'false';
}

/**
 * Una vez que se descubre que la tabla no está, se deja de preguntar.
 *
 * Es el caso de un entorno con la bandeja anterior a los reportes: sin esto, cada turno pagaría
 * una consulta que se sabe que va a fallar, y llenaría el log de avisos idénticos.
 */
let tablaAusente = false;

/** Código de Postgres para «esa tabla no existe». */
const TABLA_NO_EXISTE = '42P01';

/**
 * Qué motivo corresponde a estas señales, o `null` si no hay nada que reportar.
 *
 * Separada y pura para poder probarla sin base de datos: las reglas son producto y van a cambiar
 * con lo que se vea en producción; la fontanería de abajo, no.
 */
function motivoPara(senales) {
    const nadaHecho = senales.capacidades_ok === 0 && senales.resueltos === 0;

    if (senales.repeticion_maxima >= CONFIG.repeticiones) return 'automatizado';
    if (senales.costo_usd >= CONFIG.costoUsd && nadaHecho) return 'spam';
    if (senales.turnos >= CONFIG.turnosMinimos && nadaHecho) return 'sin_avance';
    return null;
}

/**
 * Mira la conversación y, si toca, deja el reporte. Se llama una vez por turno.
 *
 * El filtro barato va primero: solo se consulta cuando el turno ha llegado al modelo
 * (`nivel === 'llm'`). Los turnos deterministas no cuestan tokens —son la inmensa mayoría— y
 * cobrarles una consulta al Ledger para descubrir que no pasa nada sería pagar por nada
 * justamente en el camino que se eligió porque es gratis.
 *
 * @returns {Promise<{reportado: boolean, motivo: string|null}>}
 */
async function evaluar({ conversacion, nivel, transaction = null } = {}) {
    if (!activado() || tablaAusente) return { reportado: false, motivo: null };
    if (nivel !== 'llm' || !conversacion) return { reportado: false, motivo: null };

    try {
        const senales = await repositorio.senalesDeUso(conversacion.id_conversacion, {
            horas: CONFIG.horas,
            transaction,
        });

        const motivo = motivoPara(senales);
        if (!motivo) return { reportado: false, motivo: null };

        const reportado = await repositorio.reportarAutomaticamente(
            { conversacion, motivo, senales: { ...senales, umbrales: CONFIG } },
            { transaction }
        );
        return { reportado, motivo };
    } catch (error) {
        const codigo = error?.parent?.code || error?.original?.code || error?.code;
        if (codigo === TABLA_NO_EXISTE) {
            tablaAusente = true;
            console.warn(
                '[intelligence] intelligence.reporte no está migrada: el reporte automático ' +
                    'queda desactivado. Corre `npm run migrate:intelligence-reportes`.'
            );
            return { reportado: false, motivo: null };
        }
        // Un turno no se rompe por esto. Nunca.
        console.warn('[intelligence] no se pudo evaluar el uso de la conversación:', error.message);
        return { reportado: false, motivo: null };
    }
}

/** Para los tests: devuelve el estado a como estaba al arrancar el proceso. */
function _reiniciar() {
    tablaAusente = false;
}

module.exports = { evaluar, motivoPara, CONFIG, _reiniciar };
