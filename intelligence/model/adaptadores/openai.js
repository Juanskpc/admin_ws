/**
 * Adaptador del `ModelPort` para OpenAI — el segundo proveedor (F6).
 *
 * ## Por qué existe un segundo, si ADR-018 dijo «uno»
 *
 * ADR-018 descartó **mantener cinco integraciones vivas**, no comparar proveedores. Lo que dice
 * es que la abstracción existe «para **poder** cambiar, no para **estar cambiando**», y esto es
 * justo el momento de poder: hay que elegir con qué proveedor se opera, y la única forma honesta
 * de elegir es medir los dos con las mismas conversaciones (`scripts/evaluar.js --comparar`).
 *
 * Cuando la medición decida, **lo esperable es quedarse con uno**. Este archivo o el de
 * Anthropic sobrarán, y borrar el que pierda es una línea en `adaptadores/index.js`.
 *
 * ## Lo que este adaptador demostró del puerto
 *
 * Que era delgado de verdad. Traducir a un proveedor con otra forma de API no obligó a tocar el
 * núcleo: ni el Prompt Builder, ni el orquestador, ni el manejador de Nivel 4, ni el Ledger. Lo
 * único que se generalizó fue la tabla de precios, y porque OpenAI cobra la caché de otra manera
 * — un dato del mundo, no de la arquitectura.
 *
 * ## Las cuatro diferencias que de verdad muerden
 *
 * 1. **`prompt_tokens` INCLUYE los cacheados.** En Anthropic son contadores disjuntos. Aquí no:
 *    hay que restar, o se cobra dos veces la parte cacheada y a la tarifa cara. Es el error que
 *    infla la factura sin que nada falle.
 * 2. **Los argumentos llegan como texto JSON**, no como objeto — y el propio SDK avisa de que el
 *    modelo «no siempre genera JSON válido». Un `JSON.parse` sin `try` es un turno caído.
 * 3. **No hay marcas de caché.** La de OpenAI es automática. La disciplina de ADR-019 sigue
 *    valiendo idéntica —lo estable delante, lo volátil detrás— porque el descuento depende de
 *    que el prefijo coincida, no de que se pida.
 * 4. **Cada resultado va en su propio mensaje**, mientras que Anthropic los quiere todos en uno.
 */
'use strict';

const puerto = require('../puerto');

const NOMBRE = 'openai';

/** Modelos que sirve. Deben existir todos en `precios.js`; la composición lo comprueba. */
const MODELOS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-4o'];

/**
 * Modelos que **no** aceptan `reasoning_effort`.
 *
 * Los de generación anterior no razonan por pasos y devuelven un 400 si se les manda el
 * parámetro. Es un fallo que solo aparece en la primera llamada real —los tests con cliente
 * falso no lo ven— y que además dejaría el turno sin respuesta, así que se filtra aquí.
 */
const SIN_ESFUERZO = new Set(['gpt-4o']);

const CAPACIDADES_PROVEEDOR = {
    invocarCapacidades: true,
    // Sí cachea el prefijo; lo que no tiene es forma de marcarlo. Ver la nota 3 de arriba.
    cachePrefijo: true,
    esfuerzo: true,
};

const FIN_POR_FINISH_REASON = {
    stop: puerto.FIN.TURNO,
    tool_calls: puerto.FIN.CAPACIDADES,
    function_call: puerto.FIN.CAPACIDADES,
    length: puerto.FIN.LIMITE_TOKENS,
    content_filter: puerto.FIN.RECHAZO,
};

function fallo(mensaje, code, statusCode = 502) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    throw e;
}

/**
 * Parámetros del Registry → JSON Schema.
 *
 * Se reimplementa en vez de importarla del adaptador de Anthropic **a propósito**. Compartirla
 * ataría los dos adaptadores entre sí, y en cuanto uno necesitara un matiz del otro (aquí, el
 * modo estricto pide `additionalProperties: false`) la función compartida se llenaría de
 * condicionales por proveedor. Son treinta líneas: duplicarlas cuesta menos que acoplarlos.
 */
function renderizarEsquema(parametros = {}) {
    const properties = {};
    const required = [];

    for (const [nombre, decl] of Object.entries(parametros)) {
        const prop = {};
        switch (decl.tipo) {
            case 'entero':
                prop.type = 'integer';
                break;
            case 'numero':
                prop.type = 'number';
                break;
            case 'booleano':
                prop.type = 'boolean';
                break;
            case 'enum':
                prop.type = 'string';
                prop.enum = [...decl.valores];
                break;
            case 'fecha':
                prop.type = 'string';
                prop.description = 'Fecha en formato YYYY-MM-DD (hora local del negocio).';
                break;
            case 'string':
            default:
                prop.type = 'string';
                break;
        }
        if (decl.descripcion) prop.description = decl.descripcion;
        properties[nombre] = prop;
        if (decl.requerido) required.push(nombre);
    }

    return { type: 'object', properties, required, additionalProperties: false };
}

/** Capacidades → `tools`. La descripción es la del manifiesto, sin adornar. */
function renderizarTools(capacidades) {
    return capacidades.map((c) => ({
        type: 'function',
        function: {
            name: c.nombre,
            description: c.descripcion,
            parameters: renderizarEsquema(c.parametros),
        },
    }));
}

/**
 * Instrucciones + historial → `messages`.
 *
 * Aquí el prompt del sistema **no es un campo aparte**: es el primer mensaje. Que vaya delante
 * de todo es lo que hace que la caché automática lo reutilice, así que el orden que impone el
 * Prompt Builder importa igual que con el otro proveedor, aunque no haya nada que marcar.
 */
function renderizarMensajes(instrucciones, historial) {
    const mensajes = instrucciones.map((b) => ({ role: 'system', content: b.texto }));

    for (const turno of historial) {
        if (turno.rol === puerto.ROL.CLIENTE) {
            mensajes.push({ role: 'user', content: turno.texto });
            continue;
        }

        if (turno.rol === puerto.ROL.ASISTENTE) {
            const mensaje = { role: 'assistant', content: turno.texto || null };
            const invocaciones = turno.invocacionesSolicitadas || [];
            if (invocaciones.length > 0) {
                mensaje.tool_calls = invocaciones.map((inv) => ({
                    id: inv.id,
                    type: 'function',
                    function: {
                        name: inv.capacidad,
                        // Vuelve a salir como texto: es como lo espera la API al reenviarlo.
                        arguments: JSON.stringify(inv.argumentos ?? {}),
                    },
                }));
            }
            mensajes.push(mensaje);
            continue;
        }

        // `resultados`: uno por mensaje, cada uno atado a su `tool_call_id`. Agruparlos como
        // hace el otro proveedor daría un 400.
        for (const r of turno.resultados || []) {
            mensajes.push({
                role: 'tool',
                tool_call_id: r.id,
                content: typeof r.contenido === 'string' ? r.contenido : JSON.stringify(r.contenido),
            });
        }
    }

    return mensajes;
}

/**
 * Interpreta la respuesta.
 *
 * El `try/catch` del `JSON.parse` no es defensivo por costumbre: la documentación del propio SDK
 * dice que el modelo «no siempre genera JSON válido y puede alucinar parámetros». Cuando pasa,
 * se devuelve la invocación con los argumentos vacíos y el Gate la rechaza con un error legible
 * que vuelve al modelo — que es como se corrige en la vuelta siguiente. Tumbar el turno aquí
 * tiraría el trabajo (y los tokens) de todo lo anterior.
 */
function interpretarRespuesta(completion) {
    const eleccion = completion.choices?.[0];
    const mensaje = eleccion?.message ?? {};
    const invocacionesSolicitadas = [];

    for (const llamada of mensaje.tool_calls || []) {
        let argumentos = {};
        try {
            argumentos = JSON.parse(llamada.function?.arguments || '{}');
        } catch (error) {
            argumentos = { __json_invalido: String(llamada.function?.arguments ?? '').slice(0, 200) };
        }
        invocacionesSolicitadas.push({
            id: llamada.id,
            capacidad: llamada.function?.name,
            argumentos,
        });
    }

    const razonFin = FIN_POR_FINISH_REASON[eleccion?.finish_reason];
    if (!razonFin) {
        console.warn(
            `[openai] finish_reason desconocido: "${eleccion?.finish_reason}". Se trata como fin ` +
                'de turno; si empieza a salir a menudo, hay algo nuevo sin mapear.'
        );
    }

    // Un rechazo puede venir por `finish_reason` o en el campo `refusal` del mensaje.
    if (mensaje.refusal) {
        return { texto: '', invocacionesSolicitadas: [], razonFin: puerto.FIN.RECHAZO };
    }

    return {
        texto: mensaje.content || '',
        invocacionesSolicitadas,
        razonFin: razonFin || puerto.FIN.TURNO,
    };
}

/**
 * Traduce el uso de tokens.
 *
 * ⚠️ **`prompt_tokens` incluye los cacheados**, al revés que en Anthropic. Restarlos no es una
 * optimización: sin la resta, la parte cacheada se cobra dos veces —una a precio de entrada y
 * otra a precio de caché— y el importe sale hasta 10× por encima del real, sin que nada falle ni
 * avise. El Ledger diría una cifra y la factura del proveedor otra.
 */
function traducirUso(usage = {}) {
    const promptTotal = usage.prompt_tokens ?? 0;
    const cacheados = usage.prompt_tokens_details?.cached_tokens ?? 0;

    return {
        tokensEntrada: Math.max(0, promptTotal - cacheados),
        tokensSalida: usage.completion_tokens ?? 0,
        tokensCacheLectura: cacheados,
        // La caché de OpenAI no cobra escritura: los tokens que la crean son entrada normal.
        // Se declara cero explícitamente para que nadie lo lea como «no se midió».
        tokensCacheEscritura: 0,
    };
}

function crearAdaptadorOpenai({ cliente = null, apiKey = process.env.OPENAI_API_KEY } = {}) {
    let clienteReal = cliente;

    function obtenerCliente() {
        if (clienteReal) return clienteReal;
        if (!apiKey) {
            fallo(
                'No hay OPENAI_API_KEY en el entorno. El Nivel 4 de la escalera (ADR-018) es ' +
                    'opcional: el Nivel 1 determinista sigue funcionando sin ella.',
                'MODELO_SIN_CREDENCIAL',
                503
            );
        }
        let SDK;
        try {
            SDK = require('openai');
        } catch (error) {
            fallo('El paquete openai no está instalado. `npm install openai`.', 'MODELO_SIN_SDK', 503);
        }
        const OpenAI = SDK.OpenAI || SDK.default || SDK;
        clienteReal = new OpenAI({ apiKey });
        return clienteReal;
    }

    async function generar(peticion) {
        const cli = obtenerCliente();
        const iniciado = Date.now();

        const cuerpo = {
            model: peticion.modelo,
            max_completion_tokens: peticion.maxTokens,
            messages: renderizarMensajes(peticion.instrucciones, peticion.historial),
        };
        if (peticion.capacidades.length > 0) {
            cuerpo.tools = renderizarTools(peticion.capacidades);
        }
        if (peticion.esfuerzo && !SIN_ESFUERZO.has(peticion.modelo)) {
            cuerpo.reasoning_effort = peticion.esfuerzo;
        }

        let completion;
        try {
            completion = await cli.chat.completions.create(cuerpo);
        } catch (error) {
            const status = error?.status ?? error?.statusCode ?? null;
            const reintentable = status === 429 || (status >= 500 && status < 600);
            const e = new Error(`OpenAI respondió ${status ?? 'sin estado'}: ${error.message}`);
            e.code = reintentable ? 'MODELO_NO_DISPONIBLE' : 'MODELO_PETICION_INVALIDA';
            e.statusCode = reintentable ? 503 : 502;
            e.reintentable = reintentable;
            throw e;
        }

        const { texto, invocacionesSolicitadas, razonFin } = interpretarRespuesta(completion);

        return {
            texto,
            invocacionesSolicitadas,
            razonFin,
            modelo: completion.model || peticion.modelo,
            latenciaMs: Date.now() - iniciado,
            uso: traducirUso(completion.usage),
        };
    }

    return {
        nombre: NOMBRE,
        modelos: MODELOS,
        capacidades: CAPACIDADES_PROVEEDOR,
        generar,
    };
}

module.exports = {
    NOMBRE,
    MODELOS,
    CAPACIDADES_PROVEEDOR,
    SIN_ESFUERZO,
    crearAdaptadorOpenai,
    renderizarEsquema,
    renderizarTools,
    renderizarMensajes,
    interpretarRespuesta,
    traducirUso,
};
