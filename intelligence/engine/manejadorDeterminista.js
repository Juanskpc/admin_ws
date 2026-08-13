/**
 * Motor determinista — Nivel 1 de la escalera de costo (F5-D, ADR-015, ADR-018).
 *
 * Sustituye al andamio de eco. Agenda una cita entera —servicio, fecha, hora, confirmación—
 * con menús y reglas, **sin un solo token de LLM**. Ese cero es criterio de aceptación de F5,
 * no una casualidad: si esto necesitara un modelo para funcionar, no serviría como banco de
 * pruebas de la espina dorsal, que es para lo que existe.
 *
 * ## Por qué menús y no "entender lo que escribe"
 *
 * Un bot de menús numerados parece un paso atrás y no lo es. ADR-015: lo que se está validando
 * es el cableado —canal → gateway → identidad → motor → Policy Gate → capacidad → dominio—, y
 * eso se prueba mejor con un conductor **predecible** que con uno que alucina. Inventar aquí
 * reglas de intención («si dice "quiero" y "corte" entonces…») sería escribir en Nivel 1 el
 * trabajo que F6 hace mejor y va a reemplazar igualmente.
 *
 * El Nivel 1 tampoco es desechable: se queda como el peldaño que nunca falla, nunca cuesta y
 * nunca alucina, atendiendo saludos, menús y confirmaciones para siempre.
 *
 * ## Conversación y tarea, que no son lo mismo (ADR-014)
 *
 *   - `variables` es la memoria de la **conversación**, que es infinita: el nombre, el teléfono
 *     y el código de la última cita. Sobrevive a que la tarea termine.
 *   - `tarea` es el agendamiento **en curso**, que es acotado y retomable: en qué paso va, qué
 *     servicio eligió, qué hora tiene apartada. Vive en la fila de la conversación, así que un
 *     reinicio del proceso no se la lleva — ése es el «lo dejamos a medias el martes».
 *
 * ⚠️ `variables` **reemplaza, no fusiona** (ver el contrato en `motor.js#registrarManejador`).
 * Cada retorno lleva el objeto completo; por eso existe `conMemoria()` y por eso no se hace
 * `{ ...algo }` a mano en cada rama, que es donde se perderían datos sin que nadie lo note.
 *
 * ## Tres reglas que salen de leer el código, no de la teoría
 *
 * 1. **Una capacidad, como mucho una vez por turno.** El Policy Gate guarda la idempotencia
 *    por `(negocio, capacidad, clave)` y la clave que usamos es el id del turno. Si un mismo
 *    turno invocara dos veces la misma capacidad, la segunda recibiría el resultado de la
 *    primera. Por eso la FSM avanza **un paso por turno** y nunca encadena dos mutaciones.
 *    A cambio, un turno reintentado no crea dos citas, que es justo lo que se buscaba.
 *
 * 2. **El hold caduca solo, y eso es un camino normal.** `proponer_turno` aparta la hora unos
 *    minutos; quien tarda en confirmar vuelve y ya no la tiene. `reservar_turno` relee el hold
 *    del dominio y lanza `HOLD_NO_VIGENTE`. No es un error del sistema: es la conversación
 *    real, y se trata ofreciendo horas otra vez, sin disculpas raras ni callejones.
 *
 * 3. **No existe `consultar_mis_citas`.** El asistente solo puede tocar citas cuyo código ya
 *    conoce, así que el código se guarda en `variables` al crearla. Fuera de esta conversación
 *    no hay forma de recuperarlo, y la FSM está escrita **sabiéndolo** en vez de tropezar con
 *    ello a mitad. Lo desbloquea que `reserva` adopte `persona` (ver ESTADO-Y-CONTINUACION).
 *
 * ## Lo que este manejador NO hace
 *
 * No toca el esquema de conversación: devuelve una decisión y el motor la escribe. Sí invoca
 * capacidades por el Policy Gate, que abre **su propia** transacción y confirma — y eso es
 * correcto: una cita creada no debe deshacerse porque falle una escritura del Ledger.
 */
'use strict';

const policyGateReal = require('../core/policyGate');
const identidadReal = require('./identidad');

/** Pasos de la tarea de agendar. Enum-like: se registran en el Ledger y se miden. */
const PASO = {
    SERVICIO: 'servicio',
    FECHA: 'fecha',
    HORA: 'hora',
    NOMBRE: 'nombre',
    CONFIRMAR: 'confirmar',
};

const TAREA_AGENDAR = 'agendar_cita';

/** Palabras que valen en cualquier paso. Son pocas a propósito: cada una hay que probarla. */
const COMANDO = {
    MENU: ['menu', 'menú', 'inicio', 'empezar', 'hola'],
    CANCELAR: ['cancelar', 'salir', 'olvidalo', 'olvídalo', 'nada'],
    SEGUIMOS: ['seguimos', 'continuar', 'sigamos', 'retomar'],
    SI: ['si', 'sí', 'confirmo', 'dale', 'ok', 'vale', 'listo'],
    NO: ['no', 'otra', 'cambiar'],
};

const MAX_OPCIONES = 8;

function normalizar(texto) {
    return String(texto || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}

/**
 * La última línea no vacía del texto agrupado.
 *
 * El debounce junta la ráfaga en **un** turno, así que aquí no llega «sí» sino «sí\nsí\nsí»,
 * y comparar el bloque entero contra «sí» no casa: el bot repreguntaba y la cita no se creaba.
 * Lo cazó el test de ráfaga en el paso de confirmar, que es exactamente para lo que está.
 *
 * Se toma la **última** y no «alguna»: dentro de un turno, lo último que dijo la persona es su
 * intención actual. Con «alguna» valdría, un «cancelar… no, espera, sigue» cancelaría.
 */
function ultimaLinea(texto) {
    const lineas = String(texto || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    return lineas[lineas.length - 1] ?? '';
}

function esComando(texto, lista) {
    const t = normalizar(ultimaLinea(texto));
    return lista.some((palabra) => t === normalizar(palabra));
}

/**
 * Memoria de conversación completa. Existe porque `variables` reemplaza en vez de fusionar:
 * construirla a mano en cada rama es la forma segura de perder el teléfono en la rama que
 * nadie probó.
 */
function conMemoria(conversacion, extra = {}) {
    const previas = conversacion.variables || {};
    return {
        nombre: previas.nombre ?? null,
        telefono: previas.telefono ?? null,
        ultima_cita: previas.ultima_cita ?? null,
        turnos: Number(previas.turnos || 0) + 1,
        ...extra,
    };
}

function paso(decision, motivo = {}) {
    return { tipo: 'regla', decision, motivo };
}

/**
 * Fecha en zona de Bogotá, que es la hora de pared con la que trabaja toda la plataforma.
 *
 * Acepta ISO y dos atajos. Deliberadamente pobre: en Nivel 1, entender «el jueves de la semana
 * que viene» es trabajo del LLM, y fingirlo aquí con expresiones regulares produce el peor de
 * los mundos — un parser que acierta lo justo para que nadie note cuándo falla.
 */
function interpretarFecha(texto, ahora = new Date()) {
    const t = normalizar(texto);

    const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[0];

    const enBogota = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    const aISO = (d) => d.toISOString().slice(0, 10);

    if (t === 'hoy') return aISO(enBogota);
    if (t === 'manana' || t === 'mañana') {
        const d = new Date(enBogota);
        d.setDate(d.getDate() + 1);
        return aISO(d);
    }
    return null;
}

function formatearPrecio(valor) {
    if (valor == null) return '';
    return ` — $${Number(valor).toLocaleString('es-CO')}`;
}

/**
 * Crea el manejador. Las dependencias se inyectan para que la FSM se pueda probar entera
 * **sin Postgres**: los tests hostiles pasan un Gate de mentira y ejercitan los caminos que
 * en la vida real solo ocurren de vez en cuando, como el hold caducado.
 */
function crearManejadorDeterminista({
    gate = policyGateReal,
    identidad = identidadReal,
    ahora = () => new Date(),
} = {}) {
    /**
     * Invoca una capacidad. La clave de idempotencia es el id del turno: un turno reintentado
     * —porque el proceso murió, o porque la conversación estaba ocupada— devuelve lo que ya
     * hizo en vez de volver a hacerlo.
     */
    async function invocar({ capacidad, args, principal, idNegocio, turno }) {
        return gate.ejecutar({
            capacidad,
            principal,
            idNegocio,
            args,
            claveIdempotencia: turno?.id_turno ? String(turno.id_turno) : undefined,
        });
    }

    // ── Menú inicial ────────────────────────────────────────────────────────────────────

    async function ofrecerServicios(ctx, pasosPrevios = []) {
        const { resultado } = await invocar({ ...ctx, capacidad: 'consultar_servicios', args: {} });
        const servicios = (resultado?.servicios || []).slice(0, MAX_OPCIONES);

        if (servicios.length === 0) {
            return {
                pasos: [...pasosPrevios, paso('sin_servicios')],
                respuestas: ['Ahora mismo no hay servicios disponibles para agendar.'],
                variables: conMemoria(ctx.conversacion),
                tarea: null,
                resultado: 'sin_respuesta',
                nivel: 'determinista',
            };
        }

        return {
            pasos: [...pasosPrevios, paso('menu_servicios', { cuantos: servicios.length })],
            respuestas: [
                {
                    texto: '¿Qué servicio quieres agendar?',
                    // Nunca numerado dentro del texto: va en `opciones` y cada canal lo pinta
                    // como sabe (ADR-017). El WebChat los hace chips; WhatsApp, botones.
                    opciones: servicios.map((s) => ({
                        id: String(s.id_servicio),
                        etiqueta: `${s.nombre} (${s.duracion_min} min)${formatearPrecio(s.precio)}`,
                    })),
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: { nombre: TAREA_AGENDAR, datos: { paso: PASO.SERVICIO } },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    // ── Pasos de la tarea ───────────────────────────────────────────────────────────────

    async function elegirServicio(ctx, datos) {
        const elegido = normalizar(ultimaLinea(ctx.texto)).match(/\d+/);
        if (!elegido) {
            return reintentar(ctx, datos, 'Elige uno de los servicios de la lista, por favor.');
        }
        return {
            pasos: [paso('servicio_elegido', { id_servicio: Number(elegido[0]) })],
            respuestas: [
                {
                    texto: '¿Para qué día? Puedes decirme "hoy", "mañana" o una fecha (2026-08-20).',
                    opciones: [
                        { id: 'hoy', etiqueta: 'Hoy' },
                        { id: 'mañana', etiqueta: 'Mañana' },
                    ],
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: {
                nombre: TAREA_AGENDAR,
                datos: { ...datos, paso: PASO.FECHA, id_servicio: Number(elegido[0]) },
            },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    async function elegirFecha(ctx, datos) {
        const fecha = interpretarFecha(ultimaLinea(ctx.texto), ahora());
        if (!fecha) {
            return reintentar(ctx, datos, 'No entendí la fecha. Dime "hoy", "mañana" o algo como 2026-08-20.');
        }

        const { resultado } = await invocar({
            ...ctx,
            capacidad: 'consultar_disponibilidad',
            args: { id_servicio: datos.id_servicio, fecha },
        });
        const horas = (resultado?.horas || []).slice(0, MAX_OPCIONES);

        if (horas.length === 0) {
            return {
                pasos: [paso('sin_disponibilidad', { fecha })],
                respuestas: [
                    {
                        texto: `No hay horas libres el ${fecha}. ¿Probamos otro día?`,
                        opciones: [{ id: 'mañana', etiqueta: 'Mañana' }],
                    },
                ],
                variables: conMemoria(ctx.conversacion),
                // Se retrocede al paso de fecha, no se cierra la tarea: quien quería una cita
                // sigue queriéndola aunque ese día estuviera lleno.
                tarea: { nombre: TAREA_AGENDAR, datos: { ...datos, paso: PASO.FECHA } },
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }

        // ⚠️ Se guarda QUÉ profesional tiene libre cada hora, y no solo la hora.
        //
        // `consultar_disponibilidad` funde las agendas de varios profesionales y devuelve,
        // por cada hora, el primero que la tiene libre — el adaptador lo hace explícitamente
        // «para que la capacidad de reserva no tenga que volver a calcularlo». Si aquí se
        // tirara ese dato, `proponer_turno` volvería a elegir profesional por su cuenta y
        // podría escoger a uno que acaba de ocuparse: `SLOT_NO_DISPONIBLE` sobre una hora que
        // el bot mismo acababa de ofrecer. Lo cazó el test de extremo a extremo en cuanto
        // hubo dos profesionales y una cita previa.
        const profesionalPorHora = Object.fromEntries(horas.map((h) => [h.hora, h.id_profesional]));

        return {
            pasos: [paso('menu_horas', { fecha, cuantas: horas.length })],
            respuestas: [
                {
                    texto: `Estas son las horas libres el ${fecha}:`,
                    opciones: horas.map((h) => ({ id: h.hora, etiqueta: h.hora })),
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: {
                nombre: TAREA_AGENDAR,
                datos: { ...datos, paso: PASO.HORA, fecha, profesional_por_hora: profesionalPorHora },
            },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    /**
     * Elegida la hora, hace falta el nombre **antes** de apartar nada.
     *
     * El orden importa: el hold dura minutos, así que se toma lo más tarde posible. Preguntar
     * el nombre con la hora ya apartada regala esos minutos a un formulario y hace que el hold
     * caduque justo cuando el cliente está a punto de confirmar.
     */
    async function elegirHora(ctx, datos) {
        const hora = normalizar(ultimaLinea(ctx.texto)).match(/\d{1,2}:\d{2}/);
        if (!hora) {
            return reintentar(ctx, datos, 'Elige una de las horas de la lista, por favor.');
        }
        const conHora = {
            ...datos,
            hora: hora[0],
            id_profesional: datos.profesional_por_hora?.[hora[0]] ?? null,
        };

        if (!ctx.identidad.nombre) {
            return {
                pasos: [paso('hora_elegida', { hora: hora[0], pide_nombre: true })],
                respuestas: ['¿A nombre de quién agendo la cita?'],
                variables: conMemoria(ctx.conversacion),
                tarea: { nombre: TAREA_AGENDAR, datos: { ...conHora, paso: PASO.NOMBRE } },
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }
        return apartarHora(ctx, conHora, ctx.identidad.nombre, [
            paso('hora_elegida', { hora: hora[0], pide_nombre: false }),
        ]);
    }

    async function recibirNombre(ctx, datos) {
        // Excepción a la regla de la última línea: «Nicolás\nPaez» son dos trozos de UN
        // nombre, no dos intenciones. Aquí se unen en vez de quedarse con el último.
        const nombre = String(ctx.texto || '')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .join(' ');
        if (nombre.length < 2) {
            return reintentar(ctx, datos, 'Necesito un nombre para la cita. ¿Cómo te llamas?');
        }
        return apartarHora(ctx, datos, nombre, [paso('nombre_recibido')]);
    }

    /** Toma el hold y pide confirmación. Única invocación de `proponer_turno` del turno. */
    async function apartarHora(ctx, datos, nombre, pasosPrevios) {
        const inicio = `${datos.fecha}T${datos.hora}:00`;
        const { resultado } = await invocar({
            ...ctx,
            capacidad: 'proponer_turno',
            args: {
                id_servicio: datos.id_servicio,
                inicio,
                // El mismo profesional que tenía libre esa hora cuando se ofreció. Sin esto,
                // el adaptador vuelve a elegir y puede caer en uno ya ocupado.
                ...(datos.id_profesional ? { id_profesional: datos.id_profesional } : {}),
            },
        });

        const detalle = [
            `${resultado.servicio}`,
            resultado.profesional ? `con ${resultado.profesional}` : null,
            `el ${datos.fecha} a las ${datos.hora}`,
            resultado.duracion_min ? `(${resultado.duracion_min} min)` : null,
            resultado.precio != null ? formatearPrecio(resultado.precio).replace(' — ', '— ') : null,
        ]
            .filter(Boolean)
            .join(' ');

        return {
            pasos: [...pasosPrevios, paso('hora_apartada', { codigo_hold: resultado.codigo_hold })],
            respuestas: [
                {
                    texto: `Te aparté ${detalle}. ¿Confirmo la cita?`,
                    opciones: [
                        { id: 'si', etiqueta: 'Sí, confirmar' },
                        { id: 'no', etiqueta: 'Ver otras horas' },
                    ],
                },
            ],
            variables: conMemoria(ctx.conversacion, { nombre }),
            tarea: {
                nombre: TAREA_AGENDAR,
                datos: { ...datos, paso: PASO.CONFIRMAR, codigo_hold: resultado.codigo_hold, nombre },
            },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    async function confirmar(ctx, datos) {
        if (esComando(ctx.texto, COMANDO.NO)) {
            // No se libera el hold a mano: caduca solo. Soltarlo aquí exigiría otra mutación
            // en el mismo turno, y eso choca con la regla de una capacidad por turno.
            return {
                pasos: [paso('confirmacion_rechazada')],
                respuestas: [`Sin problema. Dime otra fecha y te muestro las horas libres.`],
                variables: conMemoria(ctx.conversacion),
                tarea: { nombre: TAREA_AGENDAR, datos: { ...datos, paso: PASO.FECHA } },
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }

        if (!esComando(ctx.texto, COMANDO.SI)) {
            return reintentar(ctx, datos, '¿Confirmo la cita? Respóndeme sí o no.');
        }

        try {
            const { resultado } = await invocar({
                ...ctx,
                capacidad: 'reservar_turno',
                args: {
                    codigo_hold: datos.codigo_hold,
                    cliente_nombre: datos.nombre,
                    cliente_telefono: ctx.identidad.telefono || undefined,
                },
            });

            return {
                pasos: [paso('cita_creada', { codigo_cita: resultado.codigo_cita })],
                respuestas: [
                    `¡Listo! Tu cita quedó agendada para el ${datos.fecha} a las ${datos.hora}. ` +
                        `El código es ${resultado.codigo_cita} — guárdalo por si quieres cambiarla o cancelarla.`,
                ],
                // El código va a `variables` y no solo al texto: sin `consultar_mis_citas`, es
                // la ÚNICA forma de que el asistente pueda reagendar o cancelar después.
                variables: conMemoria(ctx.conversacion, {
                    nombre: datos.nombre,
                    ultima_cita: resultado.codigo_cita,
                }),
                tarea: null,
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        } catch (error) {
            if (error.code === 'HOLD_NO_VIGENTE') {
                // Camino normal, no avería: tardó en confirmar y la hora se liberó sola.
                return {
                    pasos: [paso('hold_caducado', { codigo_hold: datos.codigo_hold })],
                    respuestas: [
                        {
                            texto: 'Se me liberó esa hora mientras esperábamos. ¿Miramos las horas libres otra vez?',
                            opciones: [{ id: datos.fecha, etiqueta: `Ver el ${datos.fecha}` }],
                        },
                    ],
                    variables: conMemoria(ctx.conversacion),
                    tarea: { nombre: TAREA_AGENDAR, datos: { ...datos, paso: PASO.FECHA } },
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            throw error;
        }
    }

    /** Repregunta sin avanzar ni perder la tarea: el paso se queda donde estaba. */
    function reintentar(ctx, datos, texto) {
        return {
            pasos: [paso('entrada_no_entendida', { paso: datos.paso })],
            respuestas: [texto],
            variables: conMemoria(ctx.conversacion),
            tarea: { nombre: TAREA_AGENDAR, datos },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    // ── Entrada ─────────────────────────────────────────────────────────────────────────

    return async function manejarDeterminista({ conversacion, mensajes, turno, texto }) {
        const identidad = await identidad_(conversacion);
        const ctx = {
            conversacion,
            mensajes,
            turno,
            texto,
            identidad,
            principal: identidad.principal,
            idNegocio: Number(conversacion.id_negocio),
        };

        const datos = conversacion.tarea_datos || {};
        const hayTarea = conversacion.tarea_actual === TAREA_AGENDAR;

        // Cancelar manda en cualquier paso. Es lo primero que se mira a propósito: un cliente
        // que quiere salir tiene que poder salir, aunque esté a mitad de un formulario.
        if (esComando(texto, COMANDO.CANCELAR)) {
            return {
                pasos: [paso('tarea_cancelada', { paso: datos.paso ?? null })],
                respuestas: ['Listo, lo dejamos aquí. Escríbeme cuando quieras agendar.'],
                variables: conMemoria(conversacion),
                tarea: null,
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }

        if (hayTarea && esComando(texto, COMANDO.SEGUIMOS)) {
            // Retomar no repite trabajo: se vuelve a preguntar lo del paso donde se quedó.
            return reintentar(ctx, datos, `Seguimos donde lo dejamos. ${textoDelPaso(datos.paso)}`);
        }

        if (!hayTarea || esComando(texto, COMANDO.MENU)) {
            return ofrecerServicios(ctx, [paso('inicio_conversacion')]);
        }

        switch (datos.paso) {
            case PASO.SERVICIO:
                return elegirServicio(ctx, datos);
            case PASO.FECHA:
                return elegirFecha(ctx, datos);
            case PASO.HORA:
                return elegirHora(ctx, datos);
            case PASO.NOMBRE:
                return recibirNombre(ctx, datos);
            case PASO.CONFIRMAR:
                return confirmar(ctx, datos);
            default:
                // Tarea con un paso que esta versión no conoce: puede pasar si se despliega
                // una FSM nueva con conversaciones vivas a medias. Se vuelve al menú en vez
                // de reventar, que es lo que un cliente a mitad de camino merece.
                return ofrecerServicios(ctx, [paso('paso_desconocido', { paso: datos.paso ?? null })]);
        }
    };

    function identidad_(conversacion) {
        return identidad.resolver(conversacion);
    }
}

function textoDelPaso(pasoActual) {
    switch (pasoActual) {
        case PASO.SERVICIO:
            return 'Elige el servicio de la lista.';
        case PASO.FECHA:
            return '¿Para qué día lo quieres?';
        case PASO.HORA:
            return 'Elige una de las horas libres.';
        case PASO.NOMBRE:
            return '¿A nombre de quién agendo la cita?';
        case PASO.CONFIRMAR:
            return '¿Confirmo la cita?';
        default:
            return '';
    }
}

module.exports = {
    crearManejadorDeterminista,
    /** Manejador listo para producción, con el Policy Gate y el resolver de verdad. */
    manejarDeterminista: crearManejadorDeterminista(),
    PASO,
    TAREA_AGENDAR,
    COMANDO,
    interpretarFecha,
};
