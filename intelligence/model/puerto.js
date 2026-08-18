/**
 * `ModelPort` — el único camino hacia un modelo de lenguaje (ADR-018).
 *
 * ## Qué es esto
 *
 * La petición y la respuesta canónicas **son de EscalApp**, no del proveedor. El núcleo habla
 * esta forma y nunca la del SDK de nadie: si mañana el proveedor renombra un campo, cambia un
 * adaptador y no cambia nada más. Esa es toda la promesa del puerto, y por eso es delgado —
 * ADR-018 avisa de que un puerto que cueste más que eso es sobrediseño.
 *
 * La palabra **«tool» no existe aquí**, igual que no existe en el Registry (ADR-008): lo que
 * viaja son **capacidades**, y traducirlas al mecanismo de function-calling del proveedor de
 * turno es trabajo del adaptador. Si «tool» aparece en este archivo, una abstracción se filtró.
 *
 * ## La matriz de capacidades del proveedor
 *
 * Un adaptador declara qué sabe hacer (`capacidades`), y `exigirSoporte()` comprueba que la
 * petición no pida nada que ese proveedor no tenga **antes** de gastar un token. El caso que
 * importa: un turno con capacidades exige function-calling; un proveedor que no lo tenga queda
 * descalificado para ese turno entero, no «lo intenta y sale regular». El master-plan lo pide
 * explícitamente y es barato mientras haya un solo adaptador; el día que haya dos, es lo que
 * evita enrutar a ciegas.
 *
 * ## Lo que este archivo NO hace
 *
 * No construye el prompt (eso es `promptBuilder.js`, y tiene su propia disciplina de caché por
 * ADR-019), no decide qué modelo se usa (eso es `orquestador.js`) y no ejecuta capacidades (eso
 * es el Policy Gate, y el modelo **no lo alcanza**: pide, y el manejador decide si ejecuta).
 */
'use strict';

/**
 * Roles del historial canónico.
 *
 * Son tres y no los del proveedor a propósito: `resultados` es un turno de resultados de
 * capacidades, que en la API de Anthropic viaja como un mensaje de `user` con bloques
 * `tool_result`. Esa correspondencia es del adaptador; el núcleo no debería tener que saberla.
 */
const ROL = {
    CLIENTE: 'cliente',
    ASISTENTE: 'asistente',
    RESULTADOS: 'resultados',
};

/** Por qué terminó de generar el modelo, normalizado. */
const FIN = {
    /** Terminó de hablar. */
    TURNO: 'turno',
    /** Quiere invocar capacidades: hay `invocacionesSolicitadas`. */
    CAPACIDADES: 'capacidades',
    /** Se quedó sin `maxTokens`. La respuesta está cortada; no es un error del proveedor. */
    LIMITE_TOKENS: 'limite_tokens',
    /** El proveedor se negó a responder. */
    RECHAZO: 'rechazo',
};

const ROLES_VALIDOS = new Set(Object.values(ROL));

/** Adaptadores registrados, por nombre de proveedor. */
const adaptadores = new Map();

function fallo(mensaje, code = 'PETICION_MODELO_INVALIDA') {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = 500;
    throw e;
}

/**
 * Registra un adaptador de proveedor.
 *
 * `capacidades` es la matriz: qué sabe hacer este proveedor. Se declara **explícitamente** y no
 * se infiere del modelo, porque «este proveedor soporta function-calling» es un hecho del
 * adaptador (de si lo hemos implementado), no del catálogo comercial de nadie.
 */
function registrarAdaptador(adaptador) {
    if (!adaptador || typeof adaptador !== 'object') fallo('Un adaptador debe ser un objeto.');
    const { nombre, modelos, capacidades, generar } = adaptador;

    if (typeof nombre !== 'string' || !nombre) fallo('El adaptador debe declarar un nombre.');
    if (!Array.isArray(modelos) || modelos.length === 0) {
        fallo(`El adaptador "${nombre}" debe declarar los modelos que sirve.`);
    }
    if (typeof generar !== 'function') {
        fallo(`El adaptador "${nombre}" debe implementar generar(peticion).`);
    }
    if (!capacidades || typeof capacidades !== 'object') {
        fallo(
            `El adaptador "${nombre}" debe declarar su matriz de capacidades. Sin ella, el ` +
                'orquestador no puede saber si puede enrutarle un turno con capacidades.'
        );
    }

    adaptadores.set(nombre, Object.freeze({ ...adaptador, capacidades: Object.freeze({ ...capacidades }) }));
    return adaptadores.get(nombre);
}

function obtenerAdaptador(nombre) {
    return adaptadores.get(nombre) || null;
}

/** El adaptador que sirve un modelo concreto. `null` si ninguno lo declara. */
function adaptadorParaModelo(modelo) {
    for (const adaptador of adaptadores.values()) {
        if (adaptador.modelos.includes(modelo)) return adaptador;
    }
    return null;
}

function listarAdaptadores() {
    return [...adaptadores.values()];
}

/**
 * La matriz: ¿este adaptador puede atender esta petición?
 *
 * Lanza en vez de devolver `false` porque el sitio que llama a esto es el enrutado, y ahí un
 * booleano ignorado es un turno que se manda igual y falla peor, cuando ya se ha pagado.
 */
function exigirSoporte(adaptador, peticion) {
    if ((peticion.capacidades || []).length > 0 && !adaptador.capacidades.invocarCapacidades) {
        fallo(
            `El proveedor "${adaptador.nombre}" no soporta invocación de capacidades y este ` +
                'turno declara ' +
                `${peticion.capacidades.length}. Queda descalificado para este turno entero: ` +
                'un asistente que no puede consultar el dominio solo puede inventárselo.',
            'PROVEEDOR_SIN_CAPACIDAD'
        );
    }
    if (peticion.instrucciones.some((i) => i.cacheable) && !adaptador.capacidades.cachePrefijo) {
        // No descalifica: sin caché el turno es correcto, solo más caro. Pero se avisa, porque
        // ADR-019 mide el acierto de caché y un cero inexplicable cuesta horas de depuración.
        console.warn(
            `[modelPort] El proveedor "${adaptador.nombre}" no soporta caché de prefijo; las ` +
                'marcas del Prompt Builder se ignorarán y el costo por turno será el nominal.'
        );
    }
}

/**
 * Valida y congela una petición canónica.
 *
 * Se valida aquí y no en el adaptador para que el error salga **antes** de la red y sea el
 * mismo con cualquier proveedor. Es la misma razón por la que `argumentos.js` valida los
 * argumentos de una capacidad antes de que el dominio los vea.
 */
function normalizarPeticion(peticion) {
    if (!peticion || typeof peticion !== 'object') fallo('La petición debe ser un objeto.');

    const {
        modelo,
        instrucciones = [],
        capacidades = [],
        historial = [],
        maxTokens = 4096,
        esfuerzo = 'medium',
        idNegocio = null,
    } = peticion;

    if (typeof modelo !== 'string' || !modelo) fallo('La petición debe declarar un modelo.');

    if (!Array.isArray(instrucciones) || instrucciones.length === 0) {
        fallo('La petición debe llevar al menos un bloque de instrucciones.');
    }
    for (const bloque of instrucciones) {
        if (typeof bloque?.texto !== 'string' || !bloque.texto.trim()) {
            fallo('Cada bloque de instrucciones debe tener un texto no vacío.');
        }
    }

    if (!Array.isArray(historial) || historial.length === 0) {
        fallo('La petición debe llevar historial: sin mensaje del cliente no hay nada que pedir.');
    }
    for (const turno of historial) {
        if (!ROLES_VALIDOS.has(turno?.rol)) {
            fallo(`Rol de historial desconocido: ${JSON.stringify(turno?.rol)}.`);
        }
        if (turno.rol === ROL.RESULTADOS && !Array.isArray(turno.resultados)) {
            fallo('Un turno de rol "resultados" debe llevar un array `resultados`.');
        }
        if (turno.rol !== ROL.RESULTADOS && typeof turno.texto !== 'string') {
            fallo(`Un turno de rol "${turno.rol}" debe llevar un texto.`);
        }
    }

    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
        fallo('`maxTokens` debe ser un entero positivo.');
    }

    return Object.freeze({
        modelo,
        instrucciones: Object.freeze(instrucciones.map((b) => Object.freeze({ ...b }))),
        capacidades: Object.freeze([...capacidades]),
        historial: Object.freeze(historial.map((t) => Object.freeze({ ...t }))),
        maxTokens,
        esfuerzo,
        idNegocio,
    });
}

/**
 * Valida la respuesta que devuelve un adaptador.
 *
 * El `uso` es obligatorio y sin valores por defecto: un turno con LLM cuyo consumo no se sabe es
 * un agujero en la factura, y ADR-022 trata el costo con estándar contable —«los logs se pueden
 * perder; esto no»—. Un adaptador que no sepa cuántos tokens gastó está roto, y es mejor saberlo
 * en el primer turno que al final del mes.
 */
function normalizarRespuesta(respuesta, { modelo, proveedor }) {
    if (!respuesta || typeof respuesta !== 'object') {
        fallo(`El adaptador "${proveedor}" no devolvió una respuesta.`, 'RESPUESTA_MODELO_INVALIDA');
    }
    const uso = respuesta.uso;
    if (!uso || typeof uso !== 'object') {
        fallo(
            `El adaptador "${proveedor}" no devolvió el uso de tokens. Sin uso no hay costo, y ` +
                'sin costo el Ledger miente.',
            'RESPUESTA_MODELO_INVALIDA'
        );
    }
    for (const campo of [
        'tokensEntrada',
        'tokensSalida',
        'tokensCacheLectura',
        'tokensCacheEscritura',
    ]) {
        if (!Number.isInteger(uso[campo]) || uso[campo] < 0) {
            fallo(
                `El adaptador "${proveedor}" devolvió un uso.${campo} inválido: ${uso[campo]}.`,
                'RESPUESTA_MODELO_INVALIDA'
            );
        }
    }

    return Object.freeze({
        texto: typeof respuesta.texto === 'string' ? respuesta.texto : '',
        invocacionesSolicitadas: Object.freeze([...(respuesta.invocacionesSolicitadas || [])]),
        razonFin: respuesta.razonFin || FIN.TURNO,
        uso: Object.freeze({ ...uso }),
        modelo: respuesta.modelo || modelo,
        proveedor,
        latenciaMs: respuesta.latenciaMs ?? null,
    });
}

/** Solo para tests: deja el registro de adaptadores vacío. */
function _limpiar() {
    adaptadores.clear();
}

module.exports = {
    ROL,
    FIN,
    registrarAdaptador,
    obtenerAdaptador,
    adaptadorParaModelo,
    listarAdaptadores,
    exigirSoporte,
    normalizarPeticion,
    normalizarRespuesta,
    _limpiar,
};
