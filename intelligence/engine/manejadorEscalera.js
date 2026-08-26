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
 *
 * **Con una excepción, y es la única:** la baja (`STOP`/`BAJA`) se atiende antes de consultar la
 * tabla. No es una decisión de costo —no hay peldaño que elegir— sino una obligación legal, y
 * ponerla como una fila más implicaría que algún día otra fila podría ganarle. Ver `optout.js`.
 */
'use strict';

const { NIVEL, enrutar } = require('../model/orquestador');
const flujos = require('./flujos');
const contextoNegocio = require('../core/contextoNegocio');
const { manejarDeterminista } = require('./manejadorDeterminista');
const { TAREA_AGENDAR } = require('./manejadorDeterminista');
const confirmacion = require('./confirmacion');
// La baja (STOP/BAJA) va por encima de la tabla de enrutado: no es una decisión de costo, es una
// obligación legal, y ninguna otra regla puede ganarle. Ver la cabecera de `optout.js`.
const optout = require('./optout');

/**
 * @param {Object}   deps
 * @param {Function} deps.determinista — el Nivel 1. Siempre presente.
 * @param {Function} [deps.llm]        — el Nivel 4. Ausente = escalera de un peldaño, que es
 *                                       exactamente el sistema de F5 y sigue siendo válido.
 */
function crearManejadorEscalera({
    determinista = manejarDeterminista,
    llm = null,
    // Inyectable por la misma razón que los otros dos: un test del enrutado no debería
    // necesitar una base de datos para comprobar a qué peldaño va un mensaje.
    resolverNegocio = (id) => contextoNegocio.obtener(id),
} = {}) {
    return async function manejarEscalera(ctx) {
        // Antes de enrutar, antes de leer la tarea, antes de todo. Un turno que pide la baja no se
        // enruta a ningún peldaño: se bloquea y se calla (F8-A, master-plan §Fase 8).
        if (optout.pedida(ctx.texto)) {
            return optout.decision(ctx.conversacion);
        }

        // ⚠️ El flujo de la vertical se resuelve ANTES de enrutar, no después.
        //
        // Hasta el 2026-08-26 se resolvía dentro de `deterministaDelNegocio`, o sea **después**
        // de que la tabla ya hubiera decidido el nivel. Con eso, la tabla no podía preguntarle
        // al flujo si el mensaje era suyo, y un pedido armado en el menú digital —que el flujo
        // de restaurante sabe leer exactamente— se iba al modelo por el comodín. Ver
        // `flujos.reclamaEl`.
        //
        // Cuesta una consulta por clave primaria en los turnos que van al modelo, donde ya se
        // hacía otra igual para el prompt. Al lado de una llamada de dos segundos al proveedor,
        // no se nota.
        const flujo = await flujoDelNegocio(ctx);

        const ruta = enrutar({
            texto: ctx.texto,
            // Cualquier tarea abierta, no solo la de agendar.
            //
            // Era `=== TAREA_AGENDAR` de cuando esa era la única que existía. Una tarea abierta
            // significa que un flujo determinista tiene el hilo a medias, sea cual sea: con la
            // comparación literal, la primera tarea de otra vertical se habría ido al modelo a
            // mitad de camino, que es la forma más cara de perder el estado que ya tenías.
            tareaEnCurso: Boolean(ctx.conversacion?.tarea_actual),
            // Una mutación esperando el sí del cliente (F7). Se calcula aquí y se le pasa a la
            // tabla como un hecho más: el enrutado no lee la base ni sabe qué es una tarea.
            confirmacionPendiente: Boolean(confirmacion.pendiente(ctx.conversacion)),
            llmDisponible: Boolean(llm),
            // «Este mensaje es mío» — lo decide el adaptador, no esta tabla (ADR-009).
            flujoReclama: flujos.reclamaEl(flujo, ctx.texto),
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
                const decision = await (flujo ? flujo.manejar(ctx) : determinista(ctx));
                return conPaso(conPaso(decision, caida), pasoDeRuta);
            }
        }

        return conPaso(await (flujo ? flujo.manejar(ctx) : determinista(ctx)), pasoDeRuta);
    };

    /**
     * El flujo determinista que le toca a ESTE negocio, o `null` si nadie lo declaró.
     *
     * Hasta el 2026-08-24 había uno solo y era el de agendar citas. El día que el canal apuntó a
     * un restaurante, el primer «hola» pidió `consultar_servicios` —una capacidad de citas—
     * sobre un negocio que no la tiene: `CAPACIDAD_NO_HABILITADA`, turno en error y **cliente sin
     * respuesta**. El motor daba por supuesto de qué iba el negocio.
     *
     * Ahora se pregunta. Los flujos los declaran los adaptadores (`engine/flujos.js`), así que
     * este archivo sigue sin nombrar ninguna vertical.
     *
     * **Si nadie declaró flujo para ese tipo de negocio**, devuelve `null` y quien llama usa el
     * que se inyectó por defecto —hoy el de citas—, avisando por consola. Es el comportamiento
     * que había antes de todo esto, así que no rompe nada existente; pero se grita, porque un
     * gimnasio recibiendo el menú de una peluquería es un fallo que de otro modo solo se ve en
     * la cara del cliente.
     */
    async function flujoDelNegocio(ctx) {
        // Si no se puede averiguar de qué negocio se trata —la base no responde, o esto corre
        // en un test sin Postgres— NO se pierde el turno: se atiende con el flujo por defecto,
        // que es exactamente lo que se hacía antes de que existiera el enrutado por vertical.
        // Enrutar es una mejora; que enrutar pueda tumbar una conversación no lo sería.
        let negocio = null;
        try {
            negocio = await resolverNegocio(ctx.conversacion?.id_negocio);
        } catch (error) {
            console.warn(`[intelligence] No se pudo leer el tipo de negocio: ${error.message}`);
        }

        const flujo = negocio && flujos.para(negocio.tipoNegocio);
        if (flujo) return flujo;

        if (negocio?.tipoNegocio && flujos.listar().length > 0) {
            console.warn(
                `[intelligence] El negocio ${negocio.id} es de tipo "${negocio.tipoNegocio}" y ` +
                    'ninguna vertical declaró flujo para él. Se atiende con el flujo por defecto, ' +
                    'que probablemente hable de otra cosa. Declara sus TIPOS_NEGOCIO en el adaptador.'
            );
        }
        return null;
    }
}

/** Antepone un paso a la decisión, sin mutarla: la del manejador es suya. */
function conPaso(decision, paso) {
    return { ...decision, pasos: [paso, ...(decision.pasos || [])] };
}

module.exports = { crearManejadorEscalera };
