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

const { NIVEL, enrutar, esPreguntaLibre } = require('../model/orquestador');

/**
 * Tope del cuerpo de un mensaje interactivo de WhatsApp (1024) con margen. Por encima, la
 * respuesta del modelo y el menú salen en dos mensajes en vez de recortar la respuesta.
 */
const TOPE_CUERPO_UNIDO = 950;
const flujos = require('./flujos');
const contextoNegocio = require('../core/contextoNegocio');
const confirmacion = require('./confirmacion');
// La baja (STOP/BAJA) va por encima de la tabla de enrutado: no es una decisión de costo, es una
// obligación legal, y ninguna otra regla puede ganarle. Ver la cabecera de `optout.js`.
const optout = require('./optout');
const cortesia = require('./cortesia');
const repositorio = require('./repositorio');
// Para cuando ningún peldaño tiene nada que decir. Un turno sin respuesta es el fallo caro de
// este sistema; decir «te contestan luego» siempre es mejor que callarse.
const handoff = require('./handoff');

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
 * @param {Function} [deps.determinista] — el Nivel 1 de respaldo, para un negocio cuyo tipo
 *                   **nadie declaró**. Lo inyecta la composición (`intelligence/index.js`), que
 *                   es quien conoce los adaptadores; este archivo no lo importa a propósito.
 *
 *                   Hasta el 2026-09-29 el valor por defecto era el flujo de citas, importado
 *                   aquí. O sea que el núcleo dependía de una vertical (lo que ADR-009 prohíbe)
 *                   y, de paso, un gimnasio sin flujo propio recibía el menú de una peluquería
 *                   — justo lo que `flujos.js` dice que no debe pasar. Sin respaldo inyectado,
 *                   ahora se cae a `handoff`: «te contesta una persona», que es la verdad.
 * @param {Function} [deps.llm]        — el Nivel 4. Ausente = escalera de un peldaño, que es
 *                                       exactamente el sistema de F5 y sigue siendo válido.
 */
function crearManejadorEscalera({
    determinista = null,
    llm = null,
    // Inyectable por la misma razón que los otros dos: un test del enrutado no debería
    // necesitar una base de datos para comprobar a qué peldaño va un mensaje.
    resolverNegocio = (id) => contextoNegocio.obtener(id),
} = {}) {
    /**
     * El contador de turnos de la conversación, puesto en UN solo sitio.
     *
     * ## Por qué vive aquí y no en cada manejador
     *
     * `variables.turnos` lo incrementaba `conMemoria`, que solo corre en el Nivel 1. O sea que su
     * nombre mentía: contaba **los turnos deterministas**, no los turnos. Para quien caía al
     * modelo se quedaba en cero para siempre, y la regla «el primer mensaje ve la bienvenida»
     * —que lee justamente este contador— habría vuelto a saludar una y otra vez.
     *
     * Se escribe **después** de la decisión y pisando lo que traiga: el valor que calcula
     * `conMemoria` es el mismo `previas + 1`, así que para el Nivel 1 no cambia nada y para el
     * Nivel 4 arregla el contador. Un contador con dos dueños es un contador roto.
     */
    function conTurnoContado(ctx, decision) {
        if (!decision) return decision;
        const previos = Number(ctx.conversacion?.variables?.turnos || 0);
        // La marca de sesión nueva (`repositorio.asegurarConversacionSinReglas`) es de UN turno:
        // se consume aquí para que no reabra la conversación en el mensaje siguiente.
        const { _sesion_nueva: _consumida, ...variables } = decision.variables || {};
        return { ...decision, variables: { ...variables, turnos: previos + 1 } };
    }

    return async function manejarEscalera(ctx) {
        return conTurnoContado(ctx, await decidir(ctx));
    };

    async function decidir(ctx) {
        // Antes de enrutar, antes de leer la tarea, antes de todo. Un turno que pide la baja no se
        // enruta a ningún peldaño: se bloquea y se calla (F8-A, master-plan §Fase 8).
        if (optout.pedida(ctx.texto)) {
            return optout.decision(ctx.conversacion);
        }

        // «Gracias» → «¡Con gusto!» → «Gracias»: la segunda no se contesta, y la primera sale
        // gratis, sin modelo. Ver `cortesia.js` para lo que NO se toca (una respuesta a una
        // pregunta del asistente, una tarea a medias, el primer mensaje).
        const cierre = await cortesia.decidir(ctx, {
            hayTarea:
                Boolean(ctx.conversacion?.tarea_actual) ||
                Boolean(confirmacion.pendiente(ctx.conversacion)),
            ultimoDelAsistente: async () => {
                const historial = await repositorio.historialReciente(
                    ctx.conversacion.id_conversacion,
                    { idTurno: ctx.turno?.id_turno ?? null, limite: 6 }
                );
                const ultimo = [...historial].reverse().find((m) => m.rol === 'asistente');
                return ultimo ? ultimo.texto : null;
            },
        });
        if (cierre) return cierre;

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

        let ruta = enrutar({
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
            // Primer mensaje de la conversación (el contador de turnos, que `conTurnoContado`
            // lleva para todos los niveles, sigue en cero; también tras un reinicio por
            // inactividad, que vacía `variables`) y el flujo pidió atenderlo.
            // Desde 2026-09-29 también cuando el cliente vuelve tras un rato de silencio
            // (`_sesion_nueva`): quien escribe al día siguiente también tiene que ver el menú.
            primerMensaje: flujos.abreLaConversacion(flujo)
                && (!Number(ctx.conversacion?.variables?.turnos || 0)
                    || ctx.conversacion?.variables?._sesion_nueva === true)
                && !ctx.conversacion?.tarea_actual,
        });

        // El turno iba al modelo, pero el flujo puede decir «este lo contesto yo» por el estado
        // del negocio (en restaurante: fuera de servicio). Solo se pregunta cuando la ruta ya era
        // el modelo — cuesta una consulta, y en los demás casos el flujo ya tiene el turno.
        if (ruta.nivel === NIVEL.LLM && (await flujos.atiendeSinModelo(flujo, ctx))) {
            ruta = {
                nivel: NIVEL.DETERMINISTA,
                regla: 'flujo_sin_modelo',
                motivo: `el flujo lo contesta sin el modelo (antes: ${ruta.regla})`,
            };
        }

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

        // ── Apertura con pregunta libre: respuesta personalizada + menú, en un solo mensaje ──
        //
        // Pedido del negocio (2026-09-29): el primer contacto tiene que dar a conocer los
        // servicios SIEMPRE, pero sin ignorar lo que el cliente dijo. Un saludo o «quiero
        // agendar» lo resuelve el menú solo (gratis); una pregunta («¿qué precios manejan?»,
        // «¿cómo vamos?») la contesta el modelo y el menú va pegado a esa misma respuesta.
        if (ruta.regla === 'apertura' && llm && flujo && esPreguntaLibre(ctx.texto)) {
            const unida = await aperturaConModelo(ctx, flujo);
            if (unida) return conPaso(conPaso(conAviso(unida), pasoDeRuta), pasoDeCaducidad);
        }

        if (ruta.nivel === NIVEL.LLM) {
            try {
                const decision = await llm(ctx);
                // Un Nivel 4 que devuelve una decisión válida y **vacía** deja al cliente igual
                // de solo que uno que revienta, y no pasa por el `catch`. Se trata igual: se
                // baja al peldaño de abajo y, si tampoco hay nada, se dice algo.
                if (sinNadaQueDecir(decision)) {
                    return conPaso(
                        conPaso(
                            conPaso(
                                conAviso(await respaldoQueSiempreHabla(ctx, flujo)),
                                { tipo: 'regla', decision: 'nivel4_mudo', motivo: {} }
                            ),
                            pasoDeRuta
                        ),
                        pasoDeCaducidad
                    );
                }
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
                // ⚠️ El respaldo puede no tener nada que decir, y entonces el turno se apaga.
                //
                // Pasó el 2026-08-27: el modelo mandó `items` serializado, la pregunta de
                // confirmación reventó al hacer `.reduce`, se bajó al flujo de restaurante, el
                // flujo no reconoció el mensaje y **cedió al modelo** — que es justo lo que
                // acababa de fallar. Tres turnos seguidos sin una palabra, y el cliente
                // creyendo que el bot se colgó.
                //
                // El paracaídas tiene que abrirse aunque el de reserva también falle.
                const decision = await respaldoQueSiempreHabla(ctx, flujo);

                return conPaso(
                    conPaso(conPaso(conAviso(decision), caida), pasoDeRuta),
                    pasoDeCaducidad
                );
            }
        }

        let decision;
        try {
            decision = await ejecutarNivel1(ctx, flujo);
        } catch (error) {
            // ⚠️ Un flujo que lanza NO puede dejar al cliente sin respuesta (producción,
            // 2026-09-29): el «Sí» que confirmaba una cita reventó en el dominio, el motor marcó el
            // turno en error y no salió ni una palabra. Se contesta algo cierto, se conserva la
            // tarea (el motor la guarda al no venir `tarea` en la decisión) y el error queda en el
            // rastro del turno para diagnosticarlo.
            console.warn(`[intelligence] el flujo determinista falló: ${error.code || ''} ${error.message}`);
            return conPaso(
                conPaso(
                    conAviso({
                        pasos: [{
                            tipo: 'error',
                            decision: String(error.code || 'FLUJO_FALLO').slice(0, 80),
                            motivo: { mensaje: error.message },
                        }],
                        respuestas: [
                            'Perdona, tuve un problema con ese paso. Inténtalo de nuevo o escríbeme ' +
                                '«menú» para empezar otra vez.',
                        ],
                        // Las de siempre, enteras: `variables` reemplaza en vez de fusionar, y sin
                        // esto `conTurnoContado` dejaría solo el contador y se perdería el nombre.
                        variables: { ...(ctx.conversacion?.variables || {}) },
                        resultado: 'error',
                        nivel: NIVEL.DETERMINISTA,
                    }),
                    pasoDeRuta
                ),
                pasoDeCaducidad
            );
        }

        // ── La cesión al modelo, por fin recogida ──────────────────────────────────────────
        //
        // `delegar()` se llamaba «cedido_al_modelo» desde el 2026-08-24 y **nadie recogía la
        // cesión**: el turno terminaba con cero mensajes y `sin_respuesta`. El 2026-08-27 el
        // dueño se lo encontró de frente — escribió algo que la FSM no supo leer y el bot se
        // quedó mudo.
        //
        // ## Por qué esto NO contradice ADR-018
        //
        // ADR-018 prohíbe subir al modelo un turno **que el Nivel 1 resolvió**, «por si acaso lo
        // hace mejor»: eso convertiría la FSM en un preámbulo caro. Aquí es lo contrario. El
        // Nivel 1 **declara que no puede** —devuelve cero mensajes— y la alternativa a subir no
        // es una respuesta barata: es ninguna. La escalera sube cuando el peldaño se acaba, que
        // es para lo que existe.
        //
        // Y no se sube dos veces: si la ruta ya era LLM, esta rama no se ejecuta.
        if (sinNadaQueDecir(decision)) {
            const cesion = {
                tipo: 'regla',
                decision: 'cesion_recogida',
                motivo: { de: NIVEL.DETERMINISTA, a: llm ? NIVEL.LLM : null, regla: ruta.regla },
            };
            // Sin Nivel 4 montado no hay a quien ceder, y el turno cae directo al handoff. Es
            // peor respuesta que la del modelo y sigue siendo infinitamente mejor que ninguna:
            // el sistema de F5 entero funcionaba así y el silencio nunca fue parte del diseño.
            if (llm) {
                try {
                    const delModelo = await llm(ctx);
                    if (!sinNadaQueDecir(delModelo)) {
                        return conPaso(
                            conPaso(conPaso(conAviso(delModelo), cesion), pasoDeRuta),
                            pasoDeCaducidad
                        );
                    }
                } catch (error) {
                    console.warn(`[intelligence] la cesión al modelo falló: ${error.message}`);
                }
            }
            // Nadie tiene nada. Antes que callar, se dice.
            return conPaso(
                conPaso(
                    conPaso(
                        conAviso({
                            ...decision,
                            respuestas: [handoff.mensaje(await negocioDe(ctx))],
                            resultado: 'handoff',
                        }),
                        cesion
                    ),
                    pasoDeRuta
                ),
                pasoDeCaducidad
            );
        }

        return conPaso(conPaso(conAviso(decision), pasoDeRuta), pasoDeCaducidad);
    };

    /**
     * El Nivel 1: el flujo que declaró la vertical de ESTE negocio y, si nadie declaró ninguno,
     * el respaldo que haya inyectado la composición.
     *
     * Sin flujo ni respaldo devuelve una decisión **vacía** a propósito, no un error: quien
     * llama ya sabe tratar el vacío —lo sube al modelo o lo convierte en handoff—, y así un tipo
     * de negocio sin flujo acaba en «te contesta una persona» en vez de en el menú de otra
     * vertical o en una excepción.
     */
    /**
     * La respuesta del modelo con el menú del flujo pegado. Devuelve `null` si no se pudo armar
     * (el modelo falló o no dijo nada) y entonces la apertura sigue por el menú solo.
     *
     * Si el modelo abrió algo que necesita el hilo —una confirmación de mutación—, manda su
     * decisión entera: el menú encima rompería esa tarea.
     */
    async function aperturaConModelo(ctx, flujo) {
        let delModelo;
        try {
            delModelo = await llm(ctx);
        } catch (error) {
            console.warn(`[intelligence] apertura: el modelo falló, sigue el menú solo: ${error.message}`);
            return null;
        }
        if (sinNadaQueDecir(delModelo)) return null;
        if (delModelo.tarea) return delModelo;

        const menu = await ejecutarNivel1({ ...ctx, sinSaludo: true }, flujo);
        const [primera, ...resto] = menu?.respuestas || [];
        const textoModelo = (delModelo.respuestas || [])
            .map((r) => (typeof r === 'string' ? r : r?.texto || ''))
            .filter(Boolean)
            .join('\n\n');
        if (!primera || !textoModelo) return null;

        const cuerpoMenu = typeof primera === 'string' ? primera : primera.texto || '';
        const unido = `${textoModelo}\n\n${cuerpoMenu}`;
        const respuestas = unido.length <= TOPE_CUERPO_UNIDO && typeof primera !== 'string'
            ? [{ ...primera, texto: unido }, ...resto]
            : [textoModelo, primera, ...resto];

        return {
            ...menu,
            pasos: [...(delModelo.pasos || []), ...(menu.pasos || [])],
            invocaciones: [...(delModelo.invocaciones || []), ...(menu.invocaciones || [])],
            respuestas,
            // Hubo tokens: el turno es del modelo aunque la tarea la abra el flujo.
            nivel: delModelo.nivel || NIVEL.LLM,
        };
    }

    async function ejecutarNivel1(ctx, flujo) {
        if (flujo) return flujo.manejar(ctx);
        if (determinista) return determinista(ctx);
        return { nivel: NIVEL.DETERMINISTA };
    }

    /**
     * El peldaño de abajo, con la garantía de que sale una frase.
     *
     * Se usa en los dos caminos por los que el Nivel 4 puede dejar tirado a alguien —revienta, o
     * contesta vacío— porque para quien escribió son el mismo suceso: no llegó nada.
     */
    async function respaldoQueSiempreHabla(ctx, flujo) {
        let decision;
        try {
            decision = await ejecutarNivel1(ctx, flujo);
        } catch (error) {
            // El respaldo del respaldo. Si esto también lanza, ya no queda nadie debajo.
            console.warn(`[intelligence] el respaldo determinista falló: ${error.message}`);
            decision = { nivel: NIVEL.DETERMINISTA };
        }
        if (!sinNadaQueDecir(decision)) return decision;
        return {
            ...decision,
            respuestas: [handoff.mensaje(await negocioDe(ctx))],
            resultado: 'handoff',
        };
    }

    /** El contexto del negocio, para que el handoff diga cuándo contestan. Nunca revienta. */
    async function negocioDe(ctx) {
        try {
            return await resolverNegocio(ctx.conversacion?.id_negocio);
        } catch (_) {
            return null;
        }
    }

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

/**
 * ¿Esta decisión deja a la persona sin una sola palabra?
 *
 * No es lo mismo que fallar. Un manejador puede devolver una decisión perfectamente válida con
 * cero mensajes —`delegar()` del flujo de restaurante lo hace, y se llama a sí mismo
 * «cedido al modelo»—, y el resultado para quien escribió es idéntico al de un error: silencio.
 *
 * En este sistema **el modo de fallo caro es el silencio, no la excepción**. Así que se mira lo
 * único que el cliente percibe: si salieron mensajes o no.
 */
function sinNadaQueDecir(decision) {
    return !decision || (decision.respuestas || []).length === 0;
}

/** Antepone un paso a la decisión, sin mutarla: la del manejador es suya. `null` no añade nada. */
function conPaso(decision, paso) {
    if (!paso) return decision;
    return { ...decision, pasos: [paso, ...(decision.pasos || [])] };
}

module.exports = { crearManejadorEscalera, tareaCaducada, TAREA_VIDA_MS };
