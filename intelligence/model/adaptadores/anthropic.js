/**
 * Adaptador del `ModelPort` para Anthropic — **el único archivo del proyecto que importa el SDK
 * de un proveedor de LLM** (ADR-018).
 *
 * ## Por qué uno y no cinco
 *
 * ADR-018 descartó explícitamente mantener varios adaptadores vivos: «la abstracción existe para
 * **poder** cambiar, no para **estar cambiando**». El puerto es la abstracción; una
 * implementación es la realidad. Si algún día hace falta el segundo, la disciplina del puerto es
 * lo que lo hace barato — y hasta entonces, cinco integraciones a medio probar son un impuesto
 * que no paga dividendos con un solo desarrollador.
 *
 * ## Aquí sí se dice «tool»
 *
 * Y es el único sitio donde puede decirse. El núcleo habla de **capacidades** (ADR-008); la
 * palabra «tool» pertenece al mecanismo de function-calling de este proveedor concreto, y
 * traducir una cosa en la otra es literalmente el trabajo de este archivo. `renderizarTools()`
 * es esa frontera.
 *
 * ## El SDK se carga tarde, a propósito
 *
 * `require('@anthropic-ai/sdk')` está dentro de una función y no arriba. Es el mismo patrón que
 * usa el repo con Redis y BullMQ, y aquí además sostiene el test del apagón de ADR-005: un
 * entorno sin la dependencia instalada —o sin `ANTHROPIC_API_KEY`— carga `intelligence/` entero
 * sin problemas y solo falla si alguien intenta *usar* el Nivel 4. Que es lo correcto: en F6 el
 * LLM es una capacidad opcional, no el producto.
 *
 * ## Lo que este adaptador NO hace
 *
 * No ejecuta capacidades. El modelo **pide** invocaciones y este archivo las devuelve como datos
 * (`invocacionesSolicitadas`); quien decide si se ejecutan es el manejador, y quien las ejecuta
 * es el Policy Gate. Esa separación es la defensa de ADR-010 y no es negociable: si este archivo
 * pudiera llamar a `gate.ejecutar()`, el modelo tendría un camino al dominio que no pasa por las
 * tres capas del Gate.
 */
'use strict';

const puerto = require('../puerto');

const NOMBRE = 'anthropic';

/**
 * Modelos que sirve este adaptador. Están también en `precios.js` con su tarifa; que un modelo
 * aparezca aquí y no allí haría que un turno se pudiera ejecutar y no se pudiera facturar, así
 * que `intelligence/index.js` comprueba que las dos listas cuadren al arrancar.
 */
const MODELOS = ['claude-opus-5', 'claude-opus-4-8', 'claude-haiku-4-5'];

/**
 * La matriz de capacidades del proveedor (master-plan, F6). Se declara a mano y no se deduce:
 * «soporta function-calling» aquí significa «lo hemos implementado y probado en este adaptador»,
 * que no es lo mismo que lo que anuncie el proveedor en su web.
 */
const CAPACIDADES_PROVEEDOR = {
    invocarCapacidades: true,
    cachePrefijo: true,
    esfuerzo: true,
};

/** Correspondencia entre el motivo de parada del proveedor y el vocabulario del puerto. */
const FIN_POR_STOP_REASON = {
    end_turn: puerto.FIN.TURNO,
    tool_use: puerto.FIN.CAPACIDADES,
    max_tokens: puerto.FIN.LIMITE_TOKENS,
    refusal: puerto.FIN.RECHAZO,
    stop_sequence: puerto.FIN.TURNO,
};

function fallo(mensaje, code, statusCode = 502) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    throw e;
}

/**
 * Traduce el esquema de parámetros del Registry a JSON Schema.
 *
 * ## Por qué no se usa `strict: true`
 *
 * El proveedor ofrece un modo estricto que garantiza que los argumentos validan contra el
 * esquema. Suena a que sobra validar después, y es justo al revés: `argumentos.js` valida
 * **igual**, porque el modo estricto es una promesa del proveedor y la frontera del dominio no
 * puede depender de la buena voluntad de un tercero. Teniendo la validación de todas formas, el
 * modo estricto solo añadiría restricciones sobre qué esquemas se pueden declarar (los
 * parámetros opcionales son el caso incómodo, y `consultar_disponibilidad` tiene uno) a cambio
 * de nada que no tengamos ya.
 *
 * Y cuando el modelo se equivoca, `argumentos.js` devuelve un error legible que vuelve al modelo
 * como resultado de la invocación: se corrige solo en la vuelta siguiente. Ese camino hay que
 * tenerlo funcionando de todos modos.
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
                // Formato de negocio, no instante: `YYYY-MM-DD` en hora de Bogotá. Se dice en
                // la descripción además de en `format` porque es lo que el modelo lee de verdad,
                // y porque un modelo que mande un ISO con huso rompe una cita de forma sutil
                // (ver la trampa de la fecha de pared en ESTADO-Y-CONTINUACION §8).
                prop.format = 'date';
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

    return { type: 'object', properties, required };
}

/**
 * Capacidades → tools.
 *
 * La descripción que ve el modelo es **la del manifiesto**, tal cual. No se adorna ni se le
 * añaden instrucciones aquí: el Registry ya exige que sea útil («no es documentación: es el
 * texto por el que el modelo decide si usarla»), y tener dos sitios donde se describe una
 * capacidad garantiza que diverjan.
 */
function renderizarTools(capacidades) {
    return capacidades.map((c) => ({
        name: c.nombre,
        description: c.descripcion,
        input_schema: renderizarEsquema(c.parametros),
    }));
}

/**
 * Instrucciones → bloques `system`, con la marca de caché donde diga el Prompt Builder.
 *
 * ⚠️ **El orden físico del prompt es `tools` → `system` → `messages`**, no el que sugiere leer
 * ADR-019 de arriba abajo. Da igual: como el catálogo de capacidades se renderiza *antes* que el
 * sistema, **una sola marca en el último bloque estable de `system` cachea las dos cosas**, que
 * es exactamente lo que el ADR pide. Poner la marca en los tools en vez de en el system dejaría
 * el prefijo estable partido por la mitad.
 */
function renderizarSystem(instrucciones) {
    const bloques = instrucciones.map((b) => ({ type: 'text', text: b.texto }));
    // Solo la ÚLTIMA marca importa: es un match de prefijo, así que marcar el último bloque
    // cacheable cachea todo lo anterior. Marcar varios gasta puntos de corte (hay 4) sin ganar
    // nada mientras el prefijo sea uno solo.
    let ultimoCacheable = -1;
    instrucciones.forEach((b, i) => {
        if (b.cacheable) ultimoCacheable = i;
    });
    if (ultimoCacheable >= 0) {
        bloques[ultimoCacheable].cache_control = { type: 'ephemeral' };
    }
    return bloques;
}

/** Historial canónico → `messages` del proveedor. */
function renderizarMensajes(historial) {
    const mensajes = [];

    for (const turno of historial) {
        if (turno.rol === puerto.ROL.CLIENTE) {
            mensajes.push({ role: 'user', content: [{ type: 'text', text: turno.texto }] });
            continue;
        }

        if (turno.rol === puerto.ROL.ASISTENTE) {
            const content = [];
            // Un bloque de texto vacío es un 400. Un turno de asistente puede ser solo
            // invocaciones, y ese caso es el normal en el bucle de capacidades.
            if (turno.texto && turno.texto.trim()) {
                content.push({ type: 'text', text: turno.texto });
            }
            for (const inv of turno.invocacionesSolicitadas || []) {
                content.push({
                    type: 'tool_use',
                    id: inv.id,
                    name: inv.capacidad,
                    input: inv.argumentos ?? {},
                });
            }
            if (content.length > 0) mensajes.push({ role: 'assistant', content });
            continue;
        }

        // `resultados`: en esta API viajan como un mensaje de usuario con bloques tool_result.
        // Van TODOS en un solo mensaje: repartirlos en varios le enseña al modelo a dejar de
        // pedir invocaciones en paralelo, que es justo lo que abarata un turno.
        mensajes.push({
            role: 'user',
            content: (turno.resultados || []).map((r) => ({
                type: 'tool_result',
                tool_use_id: r.id,
                content: typeof r.contenido === 'string' ? r.contenido : JSON.stringify(r.contenido),
                ...(r.error ? { is_error: true } : {}),
            })),
        });
    }

    return mensajes;
}

/** Extrae texto e invocaciones del contenido de la respuesta. */
function interpretarRespuesta(mensaje) {
    let texto = '';
    const invocacionesSolicitadas = [];

    for (const bloque of mensaje.content || []) {
        if (bloque.type === 'text') texto += bloque.text;
        else if (bloque.type === 'tool_use') {
            invocacionesSolicitadas.push({
                id: bloque.id,
                capacidad: bloque.name,
                // `input` ya viene parseado por el SDK. Nunca se hace match sobre el JSON
                // serializado: el escapado de Unicode y de barras varía entre modelos.
                argumentos: bloque.input ?? {},
            });
        }
    }

    const razonFin = FIN_POR_STOP_REASON[mensaje.stop_reason];
    if (!razonFin) {
        console.warn(
            `[anthropic] stop_reason desconocido: "${mensaje.stop_reason}". Se trata como fin ` +
                'de turno; si empieza a salir a menudo, hay una funcionalidad nueva sin mapear.'
        );
    }

    return { texto, invocacionesSolicitadas, razonFin: razonFin || puerto.FIN.TURNO };
}

/**
 * Crea el adaptador. `cliente` es inyectable **porque sin eso esta capa no se puede probar**:
 * la suite corre sin red y sin clave, y un adaptador que solo se puede ejercitar gastando
 * dinero real es un adaptador que nadie prueba.
 */
function crearAdaptadorAnthropic({ cliente = null, apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
    let clienteReal = cliente;

    function obtenerCliente() {
        if (clienteReal) return clienteReal;
        if (!apiKey) {
            fallo(
                'No hay ANTHROPIC_API_KEY en el entorno. El Nivel 4 de la escalera (ADR-018) es ' +
                    'opcional: el Nivel 1 determinista sigue funcionando sin ella.',
                'MODELO_SIN_CREDENCIAL',
                503
            );
        }
        let SDK;
        try {
            SDK = require('@anthropic-ai/sdk');
        } catch (error) {
            fallo(
                'El paquete @anthropic-ai/sdk no está instalado. `npm install @anthropic-ai/sdk`.',
                'MODELO_SIN_SDK',
                503
            );
        }
        const Anthropic = SDK.default || SDK;
        clienteReal = new Anthropic({ apiKey });
        return clienteReal;
    }

    async function generar(peticion) {
        const cli = obtenerCliente();
        const iniciado = Date.now();

        const cuerpo = {
            model: peticion.modelo,
            max_tokens: peticion.maxTokens,
            system: renderizarSystem(peticion.instrucciones),
            messages: renderizarMensajes(peticion.historial),
            output_config: { effort: peticion.esfuerzo },
        };
        if (peticion.capacidades.length > 0) {
            cuerpo.tools = renderizarTools(peticion.capacidades);
        }

        let mensaje;
        try {
            mensaje = await cli.messages.create(cuerpo);
        } catch (error) {
            // Se traduce a un error del dominio con `.code` para que el manejador pueda
            // distinguir «se cayó el proveedor» (reintentable, el turno se puede repetir) de
            // «la petición está mal» (no lo es, y repetirla es quemar dinero).
            const status = error?.status ?? error?.statusCode ?? null;
            const reintentable = status === 429 || (status >= 500 && status < 600);
            const e = new Error(`Anthropic respondió ${status ?? 'sin estado'}: ${error.message}`);
            e.code = reintentable ? 'MODELO_NO_DISPONIBLE' : 'MODELO_PETICION_INVALIDA';
            e.statusCode = reintentable ? 503 : 502;
            e.reintentable = reintentable;
            throw e;
        }

        const { texto, invocacionesSolicitadas, razonFin } = interpretarRespuesta(mensaje);
        const u = mensaje.usage || {};

        return {
            texto,
            invocacionesSolicitadas,
            razonFin,
            modelo: mensaje.model || peticion.modelo,
            latenciaMs: Date.now() - iniciado,
            uso: {
                tokensEntrada: u.input_tokens ?? 0,
                tokensSalida: u.output_tokens ?? 0,
                // Las dos de caché son las que dicen si ADR-019 está funcionando. Un cero
                // sostenido aquí NO es «no hay caché»: es un invalidador silencioso, y es la
                // señal que el criterio de aceptación 4 de F6 exige mirar.
                tokensCacheLectura: u.cache_read_input_tokens ?? 0,
                tokensCacheEscritura: u.cache_creation_input_tokens ?? 0,
            },
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
    crearAdaptadorAnthropic,
    // Exportados para los tests: son las traducciones donde de verdad se rompe algo, y
    // probarlas a través de `generar()` obligaría a simular el SDK entero para ver un esquema.
    renderizarEsquema,
    renderizarTools,
    renderizarSystem,
    renderizarMensajes,
    interpretarRespuesta,
};
