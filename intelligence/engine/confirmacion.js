/**
 * Confirmación humana de una mutación — la mitad conversacional de ADR-010 (F7).
 *
 * ## Qué problema resuelve
 *
 * Desde F7 el modelo ve capacidades que **cambian cosas**: cancelar una cita, moverla, crearla.
 * ADR-010 no permite que las dispare él: «el modelo puede *proponer*; solo el humano *dispara*».
 * Este archivo es el humano disparando — o sea, la conversación que va desde «pide cancelar»
 * hasta «dijo que sí», y la ejecución cuando llega ese sí.
 *
 * La regla dura no está aquí: está en el Policy Gate, que se niega a ejecutar una capacidad que
 * exige confirmación si no recibe la prueba (`confirmadoPor`). Aquí está lo blando, que es
 * producto: qué se le pregunta, cuánto se espera y qué pasa si contesta otra cosa.
 *
 * ## Por qué el sí lo lee el Nivel 1 y no el modelo
 *
 * Un «sí» es exactamente lo que ADR-018 llama Nivel 1: «nunca falla, nunca cuesta, nunca alucina
 * y nunca se cae». Preguntarle a un LLM si «dale pues» significa sí costaría dinero, tardaría, y
 * pondría al modelo a decidir si se ejecuta la acción irreversible — que es literalmente lo que
 * ADR-010 prohíbe. Así que la respuesta la lee `texto.js` con una lista de palabras, y el turno
 * en el que se cancela una cita **no gasta un token**.
 *
 * ## Las tres reglas de producto (decididas el 2026-08-19)
 *
 * 1. **Vive 10 minutos.** El orden de magnitud del hold: más allá de eso el cliente ya no
 *    recuerda qué le preguntaron, y confirmar a ciegas es peor que no confirmar.
 * 2. **Si contesta otra cosa, se repregunta una vez.** Un «¿y cuánto cuesta?» en medio no puede
 *    tirar la confirmación; dos seguidas sí, porque entonces el cliente está en otro tema.
 * 3. **Caducar nunca ejecuta.** El silencio no es un sí. Es la única de las tres que no se
 *    negocia: las otras son comodidad, ésta es la razón de existir del módulo.
 *
 * ## Dónde vive el pendiente
 *
 * En `tarea` de la conversación (ADR-014: la tarea es lo acotado y retomable, frente a
 * `variables`, que es la memoria infinita). Así sobrevive a un reinicio del proceso, cabe en el
 * enrutado —hay una fila de la política para ella— y no hace falta ni una columna nueva.
 */
'use strict';

const registryReal = require('../core/registry');
const { COMANDO, esComando } = require('./texto');

/** Nombre de la tarea. Vive en el mismo espacio que `agendar_cita`, no en uno nuevo. */
const TAREA = 'confirmar_mutacion';

/** Cuánto vive un pendiente. 10 minutos: el orden de magnitud del hold. */
const VIDA_MS = Number(process.env.CONFIRMACION_VIDA_MS) || 10 * 60 * 1000;

/** Cuántas veces se repregunta antes de soltar el tema. Una. */
const MAX_REPREGUNTAS = 1;

function paso(decision, motivo = {}) {
    return { tipo: 'regla', decision, motivo };
}

/** ¿Hay una mutación esperando el sí del cliente? Devuelve sus datos, o `null`. */
function pendiente(conversacion) {
    if (!conversacion || conversacion.tarea_actual !== TAREA) return null;
    const datos = conversacion.tarea_datos || {};
    return datos.capacidad ? datos : null;
}

function caducado(datos, ahora = new Date()) {
    const preguntado = Date.parse(datos?.preguntado_en || '');
    // Un pendiente sin hora legible se trata como caducado. Fallar hacia «no ejecutar» es la
    // única dirección aceptable de esta comprobación.
    if (!Number.isFinite(preguntado)) return true;
    return ahora.getTime() - preguntado > VIDA_MS;
}

/**
 * La pregunta con la que se le pide el sí al cliente.
 *
 * La escribe el adaptador de la vertical, no el modelo (ADR-009, y ver `registry.CONFIRMACION`).
 * Es la frase en la que el cliente se compromete: que fuera prosa generada la convertiría en algo
 * que cambia de turno en turno y que nadie ha revisado.
 */
function textoDePregunta(capacidad, args, { registry = registryReal } = {}) {
    const declarada = registry.obtener(capacidad)?.confirmacion;
    if (!declarada || typeof declarada.pregunta !== 'function') {
        // Inalcanzable si el manifiesto se validó al registrar. Se contesta algo antes que
        // reventar: el cliente no tiene culpa de un manifiesto incompleto.
        return '¿Confirmo que lo hago?';
    }
    try {
        return declarada.pregunta({ args });
    } catch (error) {
        // ⚠️ Esto corre sobre los argumentos **crudos del modelo**, antes de que nadie los
        // valide. O sea: la redacción de la pregunta es la primera pieza que toca datos en los
        // que no se puede confiar, y hasta el 2026-08-27 podía tumbar el turno entero.
        //
        // Pasó: el modelo mandó `items` serializado, `tomar_pedido.pregunta` hizo `.reduce`
        // sobre una cadena, la excepción subió hasta la escalera como `NIVEL4_FALLO` y el
        // cliente **no recibió nada**. Es la misma forma que ya costó cara dos veces — una
        // pieza secundaria matando a la principal.
        //
        // Se pregunta igual, con la frase genérica. Confirmar sigue siendo obligatorio: lo que
        // se degrada es la redacción, nunca la garantía de ADR-010.
        console.warn(
            `[confirmacion] la pregunta de "${capacidad}" no se pudo redactar: ${error.message}`
        );
        return '¿Confirmo que lo hago?';
    }
}

function opcionesSiNo() {
    return [
        { id: 'si', etiqueta: 'Sí, confirmo' },
        { id: 'no', etiqueta: 'No' },
    ];
}

/**
 * Deja la mutación esperando el sí del cliente y devuelve la decisión del turno.
 *
 * La llama el manejador de Nivel 4 cuando el modelo pide una mutación que exige confirmación.
 * **El turno termina aquí**: no se le devuelve el control al modelo para que redacte la pregunta,
 * porque la pregunta ya está escrita y porque otra vuelta serían más tokens para decir lo mismo.
 */
function solicitar({
    capacidad,
    args,
    conversacion,
    pasos = [],
    invocaciones = [],
    nivel,
    ahora = new Date(),
    registry = registryReal,
}) {
    return {
        pasos: [...pasos, paso('confirmacion_solicitada', { capacidad, argumentos: args })],
        invocaciones,
        respuestas: [
            { texto: textoDePregunta(capacidad, args, { registry }), opciones: opcionesSiNo() },
        ],
        variables: conversacion.variables || {},
        tarea: {
            nombre: TAREA,
            datos: { capacidad, args, preguntado_en: ahora.toISOString(), repreguntas: 0 },
        },
        resultado: 'resuelto',
        nivel,
    };
}

/**
 * Resuelve el pendiente con lo que acaba de escribir el cliente.
 *
 * @param {Object} ctx — el contexto del turno del manejador determinista: `conversacion`,
 *                 `texto`, `turno`, `principal`, `idNegocio`, `invocaciones`.
 * @param {Object} deps — `gate` y `registry` inyectables; los tests corren sin Postgres.
 */
async function resolver(ctx, { gate, registry = registryReal, ahora = () => new Date() } = {}) {
    const datos = pendiente(ctx.conversacion) || {};
    const variables = ctx.conversacion.variables || {};

    if (caducado(datos, ahora())) {
        // El silencio no es un sí, y decirlo en voz alta importa: el cliente tiene que saber que
        // **no** se hizo, o se irá creyendo que su cita quedó cancelada.
        return cerrar({
            pasos: [paso('confirmacion_caducada', { capacidad: datos.capacidad ?? null })],
            texto:
                'Pasó un rato y no me confirmaste, así que no hice nada. Si lo quieres, ' +
                'dímelo otra vez.',
            variables,
        });
    }

    // «cancelar» cuenta como no. Es la palabra con la que se sale de cualquier flujo en Nivel 1,
    // y aquí además es la lectura literal: quien la escribe no quiere que se ejecute nada.
    if (esComando(ctx.texto, COMANDO.NO) || esComando(ctx.texto, COMANDO.CANCELAR)) {
        return cerrar({
            pasos: [paso('confirmacion_rechazada', { capacidad: datos.capacidad })],
            texto: 'Listo, no toco nada entonces. ¿Te ayudo con algo más?',
            variables,
        });
    }

    if (!esComando(ctx.texto, COMANDO.SI)) {
        const repreguntas = Number(datos.repreguntas || 0);
        if (repreguntas >= MAX_REPREGUNTAS) {
            // Dos veces hablando de otra cosa: el cliente está en otro tema. Se suelta el
            // pendiente para que el turno siguiente lo atienda quien sepa, en vez de tener al
            // Nivel 1 repitiendo una pregunta que nadie está contestando.
            return cerrar({
                pasos: [paso('confirmacion_descartada', { capacidad: datos.capacidad, repreguntas })],
                texto: 'Dejo eso en pausa, no he hecho nada. Cuéntame qué necesitas.',
                variables,
            });
        }
        return {
            pasos: [paso('confirmacion_repreguntada', { capacidad: datos.capacidad })],
            respuestas: [
                {
                    texto: `${textoDePregunta(datos.capacidad, datos.args, { registry })} Respóndeme sí o no.`,
                    opciones: opcionesSiNo(),
                },
            ],
            variables,
            // El pendiente sigue con su hora original: repreguntar no regala 10 minutos más.
            tarea: { nombre: TAREA, datos: { ...datos, repreguntas: repreguntas + 1 } },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    // ── Dijo sí ─────────────────────────────────────────────────────────────────────────
    const iniciado = Date.now();
    try {
        const sobre = await gate.ejecutar({
            capacidad: datos.capacidad,
            principal: ctx.principal,
            idNegocio: ctx.idNegocio,
            args: datos.args,
            // La misma convención que la FSM: un turno reintentado no ejecuta dos veces.
            claveIdempotencia: ctx.turno?.id_turno ? String(ctx.turno.id_turno) : undefined,
            // La prueba. Sin esto el Gate deniega, y es lo único que hace que la regla exista.
            confirmadoPor: { idTurno: ctx.turno?.id_turno, texto: ctx.texto },
        });
        ctx.invocaciones?.push({
            capacidad: datos.capacidad,
            vertical: sobre?.vertical ?? null,
            argumentos: datos.args,
            resultado: 'ok',
            latenciaMs: Date.now() - iniciado,
            dryRun: Boolean(sobre?.dry_run),
        });

        const declarada = registry.obtener(datos.capacidad)?.confirmacion;
        const texto =
            typeof declarada?.hecho === 'function'
                ? declarada.hecho({ args: datos.args, resultado: sobre.resultado })
                : 'Hecho.';

        return cerrar({
            pasos: [paso('confirmacion_ejecutada', { capacidad: datos.capacidad })],
            texto,
            // El código de la cita se recuerda: sin `consultar_mis_citas` es la única forma de
            // que el asistente pueda tocarla después (ver la regla 3 de la FSM).
            variables: sobre.resultado?.codigo_cita
                ? { ...variables, ultima_cita: sobre.resultado.codigo_cita }
                : variables,
        });
    } catch (error) {
        ctx.invocaciones?.push({
            capacidad: datos.capacidad,
            argumentos: datos.args,
            resultado: error.statusCode === 403 ? 'denegado' : 'error',
            errorCodigo: error.code ?? null,
            latenciaMs: Date.now() - iniciado,
        });

        // Los errores 4xx del dominio están escritos para que un cliente los entienda —«esa hora
        // ya no está apartada», «no encuentro esa cita»— y son la verdad de lo que pasó.
        // Repetirlos es mejor que una frase genérica que esconde el motivo: es la misma lección
        // que F3 dejó en `reserva_app`. Lo que no es 4xx no se traduce — se deja subir y el motor
        // cierra el turno como error, que es lo que es.
        if (error.statusCode >= 400 && error.statusCode < 500) {
            return cerrar({
                pasos: [
                    paso('confirmacion_fallida', {
                        capacidad: datos.capacidad,
                        codigo: error.code ?? null,
                    }),
                ],
                texto: `No pude hacerlo: ${error.message}`,
                variables,
            });
        }
        throw error;
    }

    /** Cierra el pendiente: una respuesta y la tarea fuera. */
    function cerrar({ pasos, texto, variables: vars }) {
        return {
            pasos,
            respuestas: [texto],
            variables: vars,
            tarea: null,
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }
}

module.exports = {
    TAREA,
    VIDA_MS,
    MAX_REPREGUNTAS,
    pendiente,
    caducado,
    solicitar,
    resolver,
    textoDePregunta,
};
