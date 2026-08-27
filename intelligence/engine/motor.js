/**
 * Conversation Engine (F5-B — ADR-014).
 *
 * Estructura la interacción en cuatro niveles —Contacto → Conversación → Turno → Pasos— y
 * garantiza que **una conversación se procesa de forma coherente** aunque el canal entregue
 * los mensajes de cualquier manera: duplicados, desordenados, en ráfaga o a la vez.
 *
 * ## El problema que existe para resolver
 *
 * Alguien escribe «quiero cita», «para mañana», «con Laura». Son tres entregas, potencialmente
 * en paralelo. Procesadas a la vez producen tres respuestas contradictorias y, en el peor
 * caso, **dos citas**. Tres mecanismos, los tres de ADR-014:
 *
 *   1. **Cola FIFO particionada por conversación** (`cola.js`) — una conversación avanza en
 *      orden; conversaciones distintas, en paralelo.
 *   2. **Lock pesimista por conversación** (`repositorio.bloquear`) — mientras dura el turno,
 *      nadie más toma esa conversación. Es lo que hace que la garantía valga también entre
 *      procesos, donde una cola en memoria no alcanza.
 *   3. **Debounce de 2-4 s** (`cola.js`) — varios mensajes seguidos son **un solo turno**. No
 *      es una optimización: es como escribe la gente.
 *
 * ## Qué NO hay aquí, a propósito
 *
 * - **Ningún canal.** El motor recibe mensajes ya normalizados. El Channel Gateway y el
 *   Mensaje Canónico son F5-C (ADR-017); hasta entonces, quien alimenta al motor es el arnés
 *   `scripts/conversacion.js`.
 * - **Ninguna decisión de conversación.** Qué contestar es del manejador, que se inyecta. El
 *   motor determinista —FSM, regex, menús— es F5-D (ADR-015). En F5-B el único manejador es
 *   el andamio de `manejadorEco.js`.
 * - **Ninguna llamada a un LLM.** Sigue vigente la prohibición de la Ola B: F5 entero cuesta
 *   $0.00 en tokens, y ése es un criterio de aceptación, no una casualidad.
 *
 * ## Nada de esto está montado en `app.js`
 *
 * El test del apagón sigue en pie (ADR-005): borrar `intelligence/` deja el backend igual.
 * Los clientes de hoy son la CLI y los tests. Cuando F5-C traiga el WebChat, ése será el
 * primer punto en que Intelligence se exponga por HTTP.
 *
 * ## Escribir en el Ledger no es opcional
 *
 * ADR-022: ninguna fase termina si su comportamiento no es observable. Cada turno deja fila
 * con su latencia, su resultado y sus pasos, incluidos los que fallan — sobre todo los que
 * fallan.
 */
'use strict';
const Models = require('../../app_core/models/conection');
const repositorio = require('./repositorio');
const mensajeCanonico = require('../core/mensajeCanonico');
const { ColaParticionada, numeroDeEntorno } = require('./cola');

const sequelize = Models.sequelize;

const CONFIG = {
    /** Días hacia atrás que se consideran «pendiente». Ver `repositorio.mensajesPendientes`. */
    ventanaPendientesDias: numeroDeEntorno('CONVERSACION_VENTANA_DIAS', 7),
    /** A partir de aquí, un turno en `procesando` se da por muerto. Cero es válido: ver tests. */
    turnoColgadoMinutos: numeroDeEntorno('CONVERSACION_TURNO_COLGADO_MIN', 10),
    /**
     * Cuánto puede tardar un turno antes de avisarle a la persona que seguimos aquí.
     *
     * El número sale de una medición, no de una intuición. En producción el Nivel 1 resuelve en
     * 58 ms de media y 105 ms en el p90 —su peor caso observado fueron 552 ms—, mientras que el
     * turno más rápido de los que suben al modelo tarda 1735 ms. Entre 552 y 1735 hay sitio de
     * sobra, y 800 ms cae ahí: **ningún turno determinista llega a encender el indicador y
     * todos los del modelo lo encienden**, sin que el motor haya preguntado a qué nivel va nada.
     *
     * Que el umbral exista, en vez de avisar siempre, es lo que evita el parpadeo: un
     * «escribiendo…» que aparece y desaparece en 60 ms se ve peor que no ponerlo.
     *
     * `0` lo apaga.
     */
    avisoActividadMs: numeroDeEntorno('CONVERSACION_AVISO_ACTIVIDAD_MS', 800),
};

/** Motivos por los que un despertar no produce turno. Se miden, así que son enum-like. */
const OMITIDO = {
    OCUPADA: 'CONVERSACION_OCUPADA',
    SIN_MENSAJES: 'SIN_MENSAJES_PENDIENTES',
    ESTADO_NO_PROCESABLE: 'ESTADO_NO_PROCESABLE',
};

let manejador = null;
let cola = null;
let senalDeActividad = null;

/**
 * Instala el manejador de turnos. Es el punto de extensión del motor y su contrato completo:
 *
 * ```
 * async manejar({ conversacion, mensajes, turno, consumo }) => {
 *     pasos?:      [{ tipo, decision, motivo }]   // el porqué, para el Ledger
 *     invocaciones?: [{ capacidad, vertical, argumentos, resultado, errorCodigo, latenciaMs }]
 *                                                 // qué capacidades ejecutó (ADR-022)
 *     respuestas?: ['texto', ...]                 // lo que se le dice a la persona
 *     variables?:  {}                             // memoria de sesión (reemplaza, no fusiona)
 *     tarea?:      { nombre, datos } | null       // null cierra la tarea en curso
 *     estado?:     'activa' | 'dormida' | ...     // estado de la conversación al terminar
 *     resultado?:  'resuelto' | 'handoff' | 'sin_respuesta'
 *     nivel?:      'determinista' | 'llm' | 'humano'
 * }
 * ```
 *
 * En `tarea.datos` el motor añade y mantiene una clave reservada, `_actualizada_en` (ver
 * `sellarTarea`): la hora del último turno que tocó la tarea. Un manejador no la escribe, pero
 * puede leerla — `manejadorEscalera.js` la usa para no retomar un hilo de ayer.
 *
 * `consumo` es un **recolector que aporta el motor**: `consumo.costos.push({...})` por cada
 * llamada a un modelo (ver `intelligence/model/precios.js` para la forma). Es un array y no un
 * valor de retorno por una razón de ADR-022: el costo **factura**, y si viajara en la decisión
 * se perdería justo cuando el manejador falla — que es cuando ya se gastaron los tokens. El
 * motor lo escribe pase lo que pase, fuera del savepoint. El manejador sigue sin tocar la base.
 *
 * El manejador **no toca la base de datos ni conoce el esquema**: devuelve una decisión y el
 * motor la escribe. Esa frontera es la que permite que F5-D enchufe una FSM y F6 un LLM sin
 * reescribir el motor — y la que hace que un manejador se pueda probar sin Postgres.
 */
function registrarManejador(fn) {
    if (typeof fn !== 'function') {
        throw new Error('El manejador de turnos debe ser una función manejar(contexto).');
    }
    manejador = fn;
}

/**
 * Instala cómo se le dice a la persona «sigo aquí» cuando un turno se alarga.
 *
 * ## Por qué se inyecta en vez de importar el gateway
 *
 * Porque el motor no conoce canales, y ésa no es una preferencia de estilo: es lo que ADR-017
 * compra. En el momento en que este archivo hiciera `require('../channels/gateway')`, el núcleo
 * pasaría a saber que existen los canales, y el argumento para no meter después un
 * `if (canal === 'whatsapp')` se quedaría sin base. La composición vive en
 * `intelligence/index.js#arrancarCanales`, igual que la lista de canales.
 *
 * Hay una segunda razón, más práctica: sin esto, probar que un turno lento avisa exigiría
 * levantar un canal. Con esto, es pasar una función que apunte en un array.
 *
 * **Nadie la registra = no se avisa.** El motor funciona igual, que es como funcionó hasta hoy.
 *
 * @param {Function|null} fn — async ({ canal, idConversacion, idExterno, idExternoMensaje,
 *        idNegocio }) => boolean. No debería lanzar; si lanza, se traga aquí.
 */
function registrarSenalDeActividad(fn) {
    if (fn !== null && typeof fn !== 'function') {
        throw new Error('La señal de actividad debe ser una función o null.');
    }
    senalDeActividad = fn;
}

/**
 * Arma el aviso de «esto se está alargando» y devuelve con qué cancelarlo.
 *
 * ## Por qué un temporizador y no «si el nivel es LLM, avisa»
 *
 * Porque el motor no sabe —ni debe— a qué peldaño va un turno: eso lo decide la tabla de
 * enrutado dentro del manejador, y el motor solo ve una promesa que tarda. Preguntárselo
 * obligaría a que el manejador se lo contase antes de decidir, que es el orden contrario al
 * que tiene.
 *
 * Y sale mejor de lo que se pedía: así avisa también un turno determinista que se atasca en
 * una capacidad lenta, un caso que una condición sobre el nivel no habría cubierto nunca.
 *
 * ## `unref`, como el sondeo del gateway y al revés que el debounce
 *
 * Este temporizador no representa trabajo pendiente: representa un detalle cosmético sobre un
 * trabajo que **ya está en curso** y que alguien está esperando con un `await`. Si el proceso
 * quiere morir mientras tanto, que muera; retenerlo por un «escribiendo…» sería justo el error
 * contrario al que documenta `cola.js` para el debounce.
 */
function armarAvisoDeActividad({ conversacion, mensajes }) {
    if (!senalDeActividad || CONFIG.avisoActividadMs <= 0) return null;

    const marca = { mostrada: false, aLosMs: CONFIG.avisoActividadMs };
    // El último entrante es al que se responde. En WhatsApp el indicador cuelga de un mensaje
    // concreto; un canal que no lo necesite puede ignorarlo.
    const ultimo = mensajes[mensajes.length - 1];

    const reloj = setTimeout(() => {
        Promise.resolve()
            .then(() =>
                senalDeActividad({
                    canal: conversacion.canal,
                    idConversacion: conversacion.id_conversacion,
                    idExterno: conversacion.id_externo,
                    idExternoMensaje: ultimo ? ultimo.id_externo : null,
                    idNegocio: conversacion.id_negocio,
                })
            )
            .then((mostrada) => {
                marca.mostrada = Boolean(mostrada);
            })
            // Que no se encienda un indicador no puede tumbar el turno que iba a acompañar. Es
            // la forma de fallo que este proyecto ya pagó dos veces (ver ESTADO §4-0).
            .catch((error) => {
                console.warn(`[motor] el aviso de actividad falló: ${error.message}`);
            });
    }, CONFIG.avisoActividadMs);
    reloj.unref?.();

    return { marca, cancelar: () => clearTimeout(reloj) };
}

function obtenerCola() {
    if (!cola) {
        cola = new ColaParticionada({ procesar: (id, ctx) => procesarConversacion(id, ctx) });
        cola.on('error', (error, idConversacion) => {
            console.error(`[motor] Turno de ${idConversacion} falló: ${error.message}`);
        });
    }
    return cola;
}

// ── Entrada ─────────────────────────────────────────────────────────────────────────────

/**
 * Recibe un **Mensaje Canónico entrante**: lo deduplica, lo guarda y despierta la conversación.
 *
 * Es la única puerta de entrada al motor, y toma la forma que ADR-017 fija para todos los
 * canales: el adaptador traduce lo que su canal hable y aquí llega siempre lo mismo. Por eso
 * no hay ni un `if (canal === ...)` en el núcleo.
 *
 * Guardar y procesar están separados a conciencia. Esta función es corta y confirma enseguida
 * —el canal necesita su acuse rápido, y ADR-016 exige que la ingesta responda **sin** la
 * respuesta del bot— y el turno ocurre después, tras el debounce. Si el proceso muere entre
 * medias, el mensaje ya está en la base y `recuperar()` lo retoma.
 *
 * @param {Object} entrada — ver `core/mensajeCanonico.js#normalizarEntrada`.
 * @param {boolean} [entrada.despertar=true] — false deja el mensaje guardado sin procesarlo.
 */
async function recibir(entrada) {
    const { despertar = true } = entrada || {};
    const { canal, idNegocio, idExterno, texto, idExternoMensaje, enviadoEn, crudo } =
        mensajeCanonico.normalizarEntrada(entrada);
    const contenido = texto;

    const t = await sequelize.transaction();
    let resultado;
    try {
        const { idMensaje, duplicado } = await repositorio.reservarIngesta(
            { idNegocio, canal, idExternoMensaje },
            { transaction: t }
        );

        const conversacion = await repositorio.asegurarConversacion(
            { idNegocio, canal, idExterno },
            { transaction: t }
        );

        if (duplicado) {
            // El canal reentregó. Ni se guarda otra vez ni se despierta: un duplicado que
            // despierta la conversación produce un turno vacío, que es ruido en el Ledger.
            resultado = {
                id_mensaje: idMensaje,
                id_conversacion: conversacion.id_conversacion,
                duplicado: true,
            };
        } else {
            await repositorio.insertarMensajeEntrante(
                {
                    idMensaje,
                    idConversacion: conversacion.id_conversacion,
                    idNegocio,
                    canal,
                    idExternoMensaje,
                    contenido,
                    crudo,
                    enviadoEn,
                },
                { transaction: t }
            );
            resultado = {
                id_mensaje: idMensaje,
                id_conversacion: conversacion.id_conversacion,
                duplicado: false,
                estado: conversacion.estado,
            };
        }

        await t.commit();
    } catch (error) {
        await t.rollback();
        throw error;
    }

    if (despertar && !resultado.duplicado) {
        obtenerCola().despertar(resultado.id_conversacion);
    }
    return resultado;
}

// ── El turno ────────────────────────────────────────────────────────────────────────────

/**
 * Procesa un turno de una conversación. Es el corazón del motor y el único sitio donde se
 * abre la transacción larga.
 *
 * Todo ocurre dentro del lock: leer los mensajes, abrir el turno, decidir y responder. El
 * lock se suelta al confirmar, no antes. Es caro —retiene una conexión del pool durante todo
 * el turno— y es el precio del aislamiento que ADR-014 eligió a conciencia frente a un
 * optimismo que «rara vez» colisiona.
 */
async function procesarConversacion(idConversacion, contexto = {}) {
    if (!manejador) {
        throw new Error(
            'No hay manejador de turnos registrado. Instálalo con motor.registrarManejador() ' +
                '— en F5-B el andamio es intelligence/engine/manejadorEco.js.'
        );
    }

    const t = await sequelize.transaction();
    const iniciado = Date.now();
    let turno = null;

    try {
        const conversacion = await repositorio.bloquear(idConversacion, { transaction: t });

        if (!conversacion) {
            // Otro proceso la tiene. No se espera: se reencola y se atiende otra. Cuando el
            // otro suelte, sus propios mensajes ya estarán procesados o quedarán pendientes,
            // y este despertar los recogerá.
            await t.rollback();
            obtenerCola().despertar(idConversacion, contexto);
            return { omitido: OMITIDO.OCUPADA };
        }

        if (!repositorio.ESTADOS_PROCESABLES.includes(conversacion.estado)) {
            await t.rollback();
            return { omitido: OMITIDO.ESTADO_NO_PROCESABLE, estado: conversacion.estado };
        }

        const mensajes = await repositorio.mensajesPendientes(idConversacion, {
            ventanaDias: CONFIG.ventanaPendientesDias,
            transaction: t,
        });

        if (mensajes.length === 0) {
            // Normal, no es un error: el debounce agrupó y un despertar tardío llegó cuando
            // el turno anterior ya se los había llevado.
            await t.rollback();
            return { omitido: OMITIDO.SIN_MENSAJES };
        }

        turno = await repositorio.abrirTurno(
            {
                idConversacion,
                idNegocio: conversacion.id_negocio,
                intentos: contexto.intentos || 1,
            },
            { transaction: t }
        );

        // Se asignan ANTES de decidir y fuera del savepoint. Si el manejador falla, los
        // mensajes se quedan con este turno fallido en vez de volver a la cola: reintentar
        // sin fin algo que falla por una razón determinista es un bucle, no una recuperación.
        await repositorio.asignarMensajesATurno(mensajes, turno.id_turno, { transaction: t });

        const decision = await decidir({ conversacion, mensajes, turno, transaction: t });

        await repositorio.cerrarTurno(
            turno,
            {
                resultado: decision.resultado,
                errorCodigo: decision.errorCodigo,
                errorDetalle: decision.errorDetalle,
                latenciaMs: Date.now() - iniciado,
                nivel: decision.nivel,
            },
            { transaction: t }
        );

        await t.commit();

        return {
            id_turno: turno.id_turno,
            secuencia: turno.secuencia,
            mensajes: mensajes.length,
            respuestas: decision.respuestas,
            resultado: decision.resultado,
        };
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

/** Clave reservada del motor dentro de `tarea_datos`. Ver `sellarTarea`. */
const SELLO_TAREA = '_actualizada_en';

/**
 * Le pone hora a la tarea cada vez que se guarda.
 *
 * ## Por qué hace falta, dicho por lo que pasó sin esto
 *
 * La tarea no caducaba. Una conversación con `agendar_cita` a medias del 24 a las 21:41 seguía
 * abierta tres días después, y el 27 alguien escribió tras **19 h 45 min** de silencio y el
 * turno entró derecho por `tarea_en_curso`: el bot contestó el paso 4 del pedido de ayer a
 * quien acababa de decir «hola». La confirmación sí caducaba —diez minutos, `confirmacion.js`—
 * y la tarea que la contiene no, que es la asimetría que lo hacía difícil de ver.
 *
 * ## Por qué dentro de `tarea_datos` y no en una columna nueva
 *
 * Porque viaja con la cosa cuya edad se mide: si un manejador reemplaza la tarea, el sello se
 * renueva solo, y si la cierra, desaparece con ella. Una columna habría que acordarse de tocarla
 * en los dos sitios. Es además el patrón que ya usa `confirmacion.js` con `preguntado_en`, y no
 * necesita migración — que sobre una base de producción viva no es poca cosa.
 *
 * La clave lleva guión bajo para que se lea como lo que es: contabilidad del motor, no un dato
 * del flujo. Quien decide **cuánto** vive una tarea no es este archivo (el motor no decide qué se
 * contesta): es `manejadorEscalera.js`, que es quien enruta.
 */
function sellarTarea(tarea) {
    if (!tarea) return {};
    const datos = tarea.datos || {};
    // Sin nombre no hay tarea que fechar: el motor la está cerrando, y un sello sobre una
    // tarea cerrada solo confundiría a quien lo lea después.
    if (!tarea.nombre) return datos;
    return { ...datos, [SELLO_TAREA]: new Date().toISOString() };
}

/**
 * Ejecuta el manejador y escribe lo que decidió: pasos, respuestas y estado conversacional.
 *
 * ## Por qué un SAVEPOINT y no un try/catch a secas
 *
 * En Postgres cualquier error aborta la transacción entera: tras un fallo del manejador, un
 * `try/catch` normal atrapa el error pero deja la transacción envenenada, y el `UPDATE` que
 * marca el turno como fallido revienta también. El turno se perdería justo cuando más falta
 * hace registrarlo — la pregunta 8 del Ledger es «qué falló». Con el savepoint, el fallo se
 * deshace hasta este punto y el turno se cierra con su error dentro de la misma transacción.
 */
async function decidir({ conversacion, mensajes, turno, transaction }) {
    const salida = {
        respuestas: [],
        resultado: 'resuelto',
        errorCodigo: null,
        errorDetalle: null,
        nivel: null,
    };

    // Lo que el manejador gastó en modelos. Vive FUERA del savepoint a propósito: si el
    // manejador revienta después de llamar al LLM, la decisión se pierde pero el gasto ya
    // ocurrió, y un gasto sin registrar es un agujero en la factura (ADR-022).
    const consumo = { costos: [] };

    // Fuera del savepoint y fuera del try del manejador: cancelarlo no puede depender de que
    // el manejador haya ido bien. Un turno que revienta a los tres segundos ya encendió el
    // indicador, y lo que toca entonces es apagar el temporizador, no olvidarse de él.
    const aviso = armarAvisoDeActividad({ conversacion, mensajes });

    try {
        await sequelize.transaction({ transaction }, async (savepoint) => {
            let decision;
            try {
                decision =
                    (await manejador({
                        conversacion,
                        mensajes,
                        turno,
                        consumo,
                        // El texto agrupado, que es lo que el debounce existe para producir.
                        texto: mensajes.map((m) => m.contenido).join('\n'),
                    })) || {};
            } finally {
                aviso?.cancelar();
            }

            let secuencia = 0;

            // Se registra si llegó a encenderse, no si se armó: ADR-022 pide que el
            // comportamiento sea observable, y «el cliente vio que estábamos trabajando» es
            // justo lo que habrá que mirar para saber si esto sirvió de algo. Va de primero
            // porque ocurrió antes que nada de lo que decidiera el manejador.
            //
            // ⚠ Puede quedarse corto, y es a propósito: si el turno acaba justo después del
            // umbral, la llamada al canal puede no haber contestado todavía y aquí aún vale
            // `false`. Esperarla implicaría que un turno rápido se quedase colgado de una
            // llamada de red por un detalle cosmético, que es exactamente lo que este cambio
            // existe para evitar. Se registra lo **confirmado**, nunca lo supuesto: la cuenta
            // de `actividad_senalada` es un suelo, no un total.
            if (aviso && aviso.marca.mostrada) {
                await repositorio.registrarPaso(
                    {
                        idTurno: turno.id_turno,
                        idNegocio: conversacion.id_negocio,
                        secuencia: ++secuencia,
                        tipo: 'respuesta',
                        decision: 'actividad_senalada',
                        motivo: { a_los_ms: aviso.marca.aLosMs, canal: conversacion.canal },
                    },
                    { transaction: savepoint }
                );
            }

            for (const paso of decision.pasos || []) {
                await repositorio.registrarPaso(
                    {
                        idTurno: turno.id_turno,
                        idNegocio: conversacion.id_negocio,
                        secuencia: ++secuencia,
                        tipo: paso.tipo,
                        decision: paso.decision,
                        motivo: paso.motivo,
                        latenciaMs: paso.latenciaMs ?? null,
                    },
                    { transaction: savepoint }
                );
            }

            // Las capacidades que el manejador invocó en este turno. Va en la misma
            // transacción que el resto del turno: si el turno se deshace, su rastro también.
            // (La ejecución en sí ya la confirmó el Gate por su cuenta, y eso es correcto:
            // una cita creada no se deshace porque falle una escritura del Ledger.)
            for (const invocacion of decision.invocaciones || []) {
                await repositorio.registrarInvocacion(
                    {
                        idTurno: turno.id_turno,
                        idConversacion: conversacion.id_conversacion,
                        idNegocio: conversacion.id_negocio,
                        capacidad: invocacion.capacidad,
                        vertical: invocacion.vertical ?? null,
                        argumentos: invocacion.argumentos,
                        resultado: invocacion.resultado,
                        errorCodigo: invocacion.errorCodigo ?? null,
                        dryRun: invocacion.dryRun ?? false,
                        latenciaMs: invocacion.latenciaMs ?? null,
                    },
                    { transaction: savepoint }
                );
            }

            for (const cruda of decision.respuestas || []) {
                // Se normaliza aquí, en el núcleo, y no en cada adaptador: el manejador puede
                // devolver una cadena suelta, pero lo que se guarda y lo que viaja al canal es
                // siempre la forma canónica de ADR-017 (texto + opciones en abstracto).
                const respuesta = mensajeCanonico.normalizarSalida(cruda);

                const mensaje = await repositorio.insertarMensajeSaliente(
                    {
                        idConversacion: conversacion.id_conversacion,
                        idNegocio: conversacion.id_negocio,
                        idTurno: turno.id_turno,
                        canal: conversacion.canal,
                        contenido: respuesta.texto,
                        opciones: respuesta.opciones,
                    },
                    { transaction: savepoint }
                );
                await repositorio.registrarPaso(
                    {
                        idTurno: turno.id_turno,
                        idNegocio: conversacion.id_negocio,
                        secuencia: ++secuencia,
                        tipo: 'respuesta',
                        decision: 'mensaje_encolado',
                        motivo: {
                            id_mensaje: mensaje.id_mensaje,
                            ...(respuesta.opciones.length ? { opciones: respuesta.opciones.length } : {}),
                        },
                    },
                    { transaction: savepoint }
                );
                salida.respuestas.push(respuesta);
            }

            const tarea = decision.tarea === undefined
                ? { nombre: conversacion.tarea_actual, datos: conversacion.tarea_datos }
                : decision.tarea;

            await repositorio.guardarEstado(
                conversacion.id_conversacion,
                {
                    variables: decision.variables ?? conversacion.variables,
                    tareaActual: tarea ? tarea.nombre : null,
                    tareaDatos: sellarTarea(tarea),
                    estado: decision.estado || conversacion.estado,
                },
                { transaction: savepoint }
            );

            if (decision.nivel) salida.nivel = decision.nivel;
            // Compatibilidad: un manejador puede devolver sus costos en vez de empujarlos.
            for (const costo of decision.costos || []) consumo.costos.push(costo);

            if (decision.resultado) salida.resultado = decision.resultado;
            if (salida.respuestas.length === 0 && !decision.resultado) {
                // Un turno que no dice nada no es un turno resuelto. Distinguirlo importa
                // para la pregunta 11 (tasa de resolución).
                salida.resultado = 'sin_respuesta';
            }
        });
    } catch (error) {
        salida.resultado = 'error';
        salida.errorCodigo = (error.code || 'MANEJADOR_FALLO').slice(0, 60);
        salida.errorDetalle = error.message;
        salida.respuestas = [];

        await repositorio.registrarPaso(
            {
                idTurno: turno.id_turno,
                idNegocio: conversacion.id_negocio,
                secuencia: 99,
                tipo: 'error',
                decision: salida.errorCodigo,
                motivo: { error: error.message },
            },
            { transaction }
        );
    }

    // Se escribe DESPUÉS del try/catch y en la transacción del turno, no en el savepoint: es
    // lo único de esta función que sobrevive a que el manejador falle, y tiene que hacerlo.
    for (const costo of consumo.costos) {
        await repositorio.registrarCosto(
            {
                idTurno: turno.id_turno,
                idConversacion: conversacion.id_conversacion,
                idNegocio: conversacion.id_negocio,
                proveedor: costo.proveedor,
                modelo: costo.modelo,
                tokensEntrada: costo.tokensEntrada ?? 0,
                tokensSalida: costo.tokensSalida ?? 0,
                tokensCacheLectura: costo.tokensCacheLectura ?? 0,
                tokensCacheEscritura: costo.tokensCacheEscritura ?? 0,
                costoUsd: costo.costoUsd,
                latenciaMs: costo.latenciaMs ?? null,
            },
            { transaction }
        );
    }

    // Gastar tokens y declararse determinista no puede pasar: la pregunta 12 del Ledger es
    // justamente el ratio entre los dos, y sería la primera en mentir.
    if (consumo.costos.length > 0 && salida.nivel !== 'llm') salida.nivel = 'llm';

    return salida;
}

// ── Continuidad ─────────────────────────────────────────────────────────────────────────

/**
 * Recupera el trabajo que dejó a medias un proceso que murió, y reencola lo pendiente.
 *
 * Se llama al arrancar. Es la mitad operativa del criterio de aceptación 3 de F5: matar el
 * proceso a mitad de una conversación y que al volver se retome donde estaba. La otra mitad
 * es que no hay estado del motor en memoria — variables y tarea viven en `conversacion`, así
 * que un reinicio no pierde nada aunque pasen 24 horas.
 *
 * @returns {Promise<{colgados: number, reencoladas: number}>}
 */
async function recuperar() {
    const t = await sequelize.transaction();
    let colgados;
    try {
        colgados = await repositorio.recuperarTurnosColgados({
            umbralMinutos: CONFIG.turnoColgadoMinutos,
            transaction: t,
        });
        await t.commit();
    } catch (error) {
        await t.rollback();
        throw error;
    }

    // El turno nuevo hereda la cuenta de intentos del que murió: sin eso, un turno que se
    // cuelga en bucle parecería trabajo nuevo cada vez y la pregunta 9 del Ledger mentiría.
    const intentosPorConversacion = new Map();
    for (const turno of colgados) {
        const previo = intentosPorConversacion.get(turno.id_conversacion) || 0;
        intentosPorConversacion.set(turno.id_conversacion, Math.max(previo, turno.intentos) + 1);
    }

    const pendientes = await repositorio.conversacionesConPendientes({
        ventanaDias: CONFIG.ventanaPendientesDias,
    });

    for (const fila of pendientes) {
        const intentos = intentosPorConversacion.get(fila.id_conversacion) || 1;
        obtenerCola().despertar(fila.id_conversacion, { intentos });
    }

    if (colgados.length > 0 || pendientes.length > 0) {
        console.log(
            `[motor] Recuperación: ${colgados.length} turno(s) colgado(s), ` +
                `${pendientes.length} conversación(es) reencolada(s).`
        );
    }

    return { colgados: colgados.length, reencoladas: pendientes.length };
}

/** Espera a que no quede trabajo. Para la CLI y los tests. */
function drenar(opciones) {
    return obtenerCola().drenar(opciones);
}

/** Procesa ya, sin esperar el debounce. Para la CLI y los tests. */
function forzar(idConversacion, contexto) {
    obtenerCola().forzar(idConversacion, contexto);
}

function detener() {
    if (cola) {
        cola.detener();
        cola = null;
    }
}

/** Solo para tests: vuelve al estado previo, sin manejador ni cola. */
function _reiniciar() {
    detener();
    manejador = null;
    senalDeActividad = null;
}

module.exports = {
    CONFIG,
    OMITIDO,
    registrarManejador,
    registrarSenalDeActividad,
    recibir,
    procesarConversacion,
    recuperar,
    drenar,
    forzar,
    detener,
    _reiniciar,
};
