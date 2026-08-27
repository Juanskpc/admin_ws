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
 * Cuánto vive una tarea sin que nadie la toque. Tres horas.
 *
 * ## El número, y por qué ése
 *
 * Cubre «me interrumpieron y vuelvo» —una comida, una reunión— y deja fuera «al día
 * siguiente», que es el caso que lo destapó. Y tiene un techo que no es negociable: pasadas
 * **24 h** WhatsApp no deja contestar con texto libre (`WHATSAPP_FUERA_DE_VENTANA`), así que una
 * vida más larga que eso sería prometer algo que el canal no puede cumplir.
 *
 * Es una decisión de producto, no de arquitectura: cambiarla es cambiar este número.
 */
const TAREA_VIDA_MS = Number(process.env.CONVERSACION_TAREA_VIDA_MS) || 3 * 60 * 60 * 1000;

/**
 * La tarea de confirmar una mutación **no** pasa por aquí: tiene su propia vida, más corta
 * (diez minutos, `confirmacion.js`), y su propio mensaje al caducar, que es mejor que el de aquí
 * porque dice lo único que el cliente necesita saber — que **no se hizo nada**. Dos relojes
 * sobre la misma tarea acabarían con el más tonto ganando.
 */
const TAREA_CON_RELOJ_PROPIO = confirmacion.TAREA;

/**
 * ¿La tarea que hay abierta es de hace demasiado como para retomarla sin avisar?
 *
 * **Sin sello legible se considera caducada.** Es la misma dirección en la que falla
 * `confirmacion.caducado`, y por la misma razón: entre retomar un hilo que no toca y empezar de
 * cero, empezar de cero es lo que no puede salir mal. De paso, es lo que hace que las tareas que
 * ya estaban abiertas antes de que existiera el sello —dos, en producción— se cierren solas la
 * primera vez que alguien escriba.
 */
function tareaCaducada(conversacion, ahora = Date.now()) {
    const nombre = conversacion?.tarea_actual;
    if (!nombre || nombre === TAREA_CON_RELOJ_PROPIO) return false;
    if (TAREA_VIDA_MS <= 0) return false;

    const sello = Date.parse(conversacion.tarea_datos?._actualizada_en || '');
    if (!Number.isFinite(sello)) return true;
    return ahora - sello > TAREA_VIDA_MS;
}

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

        // ⚠ Antes de enrutar, porque `tarea_en_curso` es la tercera fila de la tabla y se lleva
        // el turno entero. Una tarea rancia enrutada es un «hola» contestado con el paso 4 del
        // pedido de anoche, que es exactamente lo que pasó el 2026-08-27.
        //
        // Se **muta** `ctx.conversacion`, y no es descuido: el motor guarda el estado leyendo
        // este mismo objeto cuando la decisión no trae `tarea`, así que vaciarlo aquí es lo que
        // cierra la tarea en la base. Hacerlo de otro modo obligaría a que cada rama de abajo se
        // acordara de devolver `tarea: null`, y la que se olvidara dejaría el hilo colgado otra
        // vez.
        const caducada = tareaCaducada(ctx.conversacion);
        let pasoDeCaducidad = null;
        if (caducada) {
            pasoDeCaducidad = {
                tipo: 'regla',
                decision: 'tarea_caducada',
                motivo: {
                    tarea: ctx.conversacion.tarea_actual,
                    vida_ms: TAREA_VIDA_MS,
                    sello: ctx.conversacion.tarea_datos?._actualizada_en ?? null,
                },
            };
            ctx.conversacion.tarea_actual = null;
            ctx.conversacion.tarea_datos = {};
        }

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

        /**
         * Le antepone a la decisión el aviso de que se empezó de cero, si tocó.
         *
         * Decirlo importa, y el precedente está en `confirmacion.js`: cuando algo caduca se dice
         * en voz alta, porque el cliente tiene que saber dónde quedó su asunto. Callarlo y
         * contestar como si nada es justo la versión silenciosa del mismo fallo.
         *
         * Va **antes** de la respuesta y en el mismo turno, no en uno propio: obligar al cliente
         * a repetir lo que acaba de escribir para que se lo atiendan sería cobrarle a él un
         * despiste nuestro.
         */
        const conAviso = (decision) => {
            if (!caducada) return decision;
            return {
                ...decision,
                respuestas: [
                    'Pasó un buen rato desde la última vez, así que empiezo de cero.',
                    ...(decision.respuestas || []),
                ],
            };
        };

        if (ruta.nivel === NIVEL.LLM) {
            try {
                const decision = await llm(ctx);
                return conPaso(conPaso(conAviso(decision), pasoDeRuta), pasoDeCaducidad);
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
                return conPaso(
                    conPaso(conPaso(conAviso(decision), caida), pasoDeRuta),
                    pasoDeCaducidad
                );
            }
        }

        return conPaso(
            conPaso(conAviso(await (flujo ? flujo.manejar(ctx) : determinista(ctx))), pasoDeRuta),
            pasoDeCaducidad
        );
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

/** Antepone un paso a la decisión, sin mutarla: la del manejador es suya. `null` no añade nada. */
function conPaso(decision, paso) {
    if (!paso) return decision;
    return { ...decision, pasos: [paso, ...(decision.pasos || [])] };
}

module.exports = { crearManejadorEscalera, tareaCaducada, TAREA_VIDA_MS };
