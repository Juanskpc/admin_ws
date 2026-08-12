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
};

/** Motivos por los que un despertar no produce turno. Se miden, así que son enum-like. */
const OMITIDO = {
    OCUPADA: 'CONVERSACION_OCUPADA',
    SIN_MENSAJES: 'SIN_MENSAJES_PENDIENTES',
    ESTADO_NO_PROCESABLE: 'ESTADO_NO_PROCESABLE',
};

let manejador = null;
let cola = null;

/**
 * Instala el manejador de turnos. Es el punto de extensión del motor y su contrato completo:
 *
 * ```
 * async manejar({ conversacion, mensajes, turno }) => {
 *     pasos?:      [{ tipo, decision, motivo }]   // el porqué, para el Ledger
 *     respuestas?: ['texto', ...]                 // lo que se le dice a la persona
 *     variables?:  {}                             // memoria de sesión (reemplaza, no fusiona)
 *     tarea?:      { nombre, datos } | null       // null cierra la tarea en curso
 *     estado?:     'activa' | 'dormida' | ...     // estado de la conversación al terminar
 *     resultado?:  'resuelto' | 'handoff' | 'sin_respuesta'
 *     nivel?:      'determinista' | 'llm' | 'humano'
 * }
 * ```
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
    };

    try {
        await sequelize.transaction({ transaction }, async (savepoint) => {
            const decision =
                (await manejador({
                    conversacion,
                    mensajes,
                    turno,
                    // El texto agrupado, que es lo que el debounce existe para producir.
                    texto: mensajes.map((m) => m.contenido).join('\n'),
                })) || {};

            let secuencia = 0;

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
                    tareaDatos: tarea ? tarea.datos : {},
                    estado: decision.estado || conversacion.estado,
                },
                { transaction: savepoint }
            );

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
}

module.exports = {
    CONFIG,
    OMITIDO,
    registrarManejador,
    recibir,
    procesarConversacion,
    recuperar,
    drenar,
    forzar,
    detener,
    _reiniciar,
};
