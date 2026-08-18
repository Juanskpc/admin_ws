/**
 * La escalera de costo, montada (F6, ADR-018).
 *
 * Es el manejador que se le da al motor a partir de F6: consulta la política de enrutado
 * (`model/orquestador.js`), llama al peldaño que salga, y —esto es lo importante— **si el
 * peldaño de arriba se cae, baja al de abajo**.
 *
 * ## Por qué el respaldo es unidireccional
 *
 * El Nivel 1 «nunca falla, nunca cuesta, nunca alucina y nunca se cae» (ADR-018), y esa frase
 * solo vale algo si el sistema la usa. Un turno cuyo LLM revienta —proveedor caído, sin
 * credencial, cuota agotada— acaba en la FSM y el cliente recibe un menú en vez de un silencio.
 * Al revés no: un turno que la FSM resuelve **no** se manda al modelo «por si acaso lo hace
 * mejor», porque eso convierte el Nivel 1 en un preámbulo caro y la escalera deja de ahorrar.
 *
 * ## Lo que este archivo NO decide
 *
 * No decide a qué nivel va nada: eso es la tabla del orquestador, y está en un archivo aparte
 * precisamente para que añadir un nivel sea añadir filas y no editar este `if`. Aquí solo se
 * ejecuta lo que la tabla dijo.
 */
'use strict';

const { NIVEL, enrutar } = require('../model/orquestador');
const { manejarDeterminista } = require('./manejadorDeterminista');
const { TAREA_AGENDAR } = require('./manejadorDeterminista');

/**
 * @param {Object}   deps
 * @param {Function} deps.determinista — el Nivel 1. Siempre presente.
 * @param {Function} [deps.llm]        — el Nivel 4. Ausente = escalera de un peldaño, que es
 *                                       exactamente el sistema de F5 y sigue siendo válido.
 */
function crearManejadorEscalera({ determinista = manejarDeterminista, llm = null } = {}) {
    return async function manejarEscalera(ctx) {
        const ruta = enrutar({
            texto: ctx.texto,
            tareaEnCurso: ctx.conversacion?.tarea_actual === TAREA_AGENDAR,
            llmDisponible: Boolean(llm),
        });

        const pasoDeRuta = {
            tipo: 'regla',
            decision: ruta.regla,
            motivo: { nivel: ruta.nivel, por_que: ruta.motivo },
        };

        if (ruta.nivel === NIVEL.LLM) {
            try {
                const decision = await llm(ctx);
                return conPaso(decision, pasoDeRuta);
            } catch (error) {
                // El manejador de Nivel 4 ya atrapa los fallos del proveedor y responde con el
                // handoff. Llegar aquí significa que se rompió algo que no previó, y aun así el
                // cliente tiene que salir con una respuesta.
                const caida = {
                    tipo: 'error',
                    decision: (error.code || 'NIVEL4_FALLO').slice(0, 80),
                    motivo: { mensaje: error.message, se_baja_a: NIVEL.DETERMINISTA },
                };
                const decision = await determinista(ctx);
                return conPaso(conPaso(decision, caida), pasoDeRuta);
            }
        }

        return conPaso(await determinista(ctx), pasoDeRuta);
    };
}

/** Antepone un paso a la decisión, sin mutarla: la del manejador es suya. */
function conPaso(decision, paso) {
    return { ...decision, pasos: [paso, ...(decision.pasos || [])] };
}

module.exports = { crearManejadorEscalera };
