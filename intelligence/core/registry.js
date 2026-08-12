/**
 * Capability Registry — el catálogo único de acciones de negocio (ADR-008).
 *
 * ## Qué es esto y qué NO es
 *
 * Es **un** registro, y solo uno. Los pasos internos de una capacidad (buscar
 * disponibilidad, tomar un hold, escribir, emitir el evento) **no se registran**: son
 * código privado dentro del guion transaccional de la capacidad. ADR-008 eliminó el Tool
 * Registry tras preguntar quién lo consultaría, y la respuesta fue nadie.
 *
 * La palabra "tool" no existe en esta capa ni en ninguna otra del núcleo. Pertenece
 * **exclusivamente** al adaptador del `ModelPort`, donde nuestras capacidades se renderizan
 * al mecanismo de function-calling del proveedor de turno. Si "tool" aparece aquí, es que
 * una abstracción se filtró.
 *
 * ## Por qué el catálogo es código y no una tabla
 *
 * Lo que declara una capacidad cambia cuando cambia el código, no cuando cambia un
 * inquilino: sus parámetros son el contrato de su implementación. Una tabla de
 * declaraciones sería configuración que nadie edita y que puede desincronizarse del código
 * que la ejecuta. Lo que sí es dato por inquilino —la habilitación— vive en
 * `platform.capacidad_habilitada`.
 *
 * ## Agnosticismo
 *
 * Este archivo no sabe qué es una cita ni qué es un pedido, y nunca debe saberlo
 * (ADR-009). Todo el conocimiento de dominio vive en `intelligence/adapters/<vertical>/`.
 * El día que este fichero importe algo de una vertical, se perdió el `git diff = 0`.
 */
'use strict';

/** Tipos de capacidad del metamodelo (capability-language.md §1). */
const TIPO = {
    CONSULTA: 'consulta',
    MUTACION: 'mutacion',
};

/**
 * Techo blando de ADR-008. No es un límite técnico: es un forzador de disciplina. Si una
 * vertical necesita más de 10, casi siempre significa que las capacidades están cortadas
 * como CRUD y no como acciones de negocio.
 */
const MAX_CAPACIDADES_POR_VERTICAL = 10;

/**
 * `id_negocio` jamás es un parámetro que el modelo pueda rellenar (ADR-010). La regla se
 * verifica al registrar, no al ejecutar: un manifiesto que lo declare no llega a existir.
 */
const PARAMETROS_PROHIBIDOS = new Set(['id_negocio', 'idNegocio', 'tenant_id', 'tenantId']);

/** Tipos que un parámetro puede declarar. Deliberadamente cortos: son argumentos de una
 *  acción de negocio, no un lenguaje de esquemas. */
const TIPOS_PARAMETRO = new Set(['string', 'entero', 'numero', 'booleano', 'fecha', 'enum']);

const NOMBRE_VALIDO = /^[a-z][a-z0-9_]*$/;

/** El catálogo vivo del proceso. */
const capacidades = new Map();

function fallo(mensaje) {
    const e = new Error(mensaje);
    e.code = 'MANIFIESTO_INVALIDO';
    e.statusCode = 500;
    throw e;
}

/**
 * Valida un parámetro declarado. Estricto a propósito: el esquema de entrada es lo único
 * que separa "el modelo pidió algo raro" de "el dominio recibió basura".
 */
function validarParametro(nombreCapacidad, nombre, decl) {
    if (PARAMETROS_PROHIBIDOS.has(nombre)) {
        fallo(
            `La capacidad "${nombreCapacidad}" declara el parámetro "${nombre}". El ` +
                'id_negocio lo inyecta la plataforma desde el Principal y nunca llega del ' +
                'modelo (ADR-010): declararlo como parámetro abriría exactamente la fuga ' +
                'entre inquilinos que la regla existe para cerrar.'
        );
    }
    if (!decl || typeof decl !== 'object') {
        fallo(`Parámetro "${nombre}" de "${nombreCapacidad}": la declaración debe ser un objeto.`);
    }
    if (!TIPOS_PARAMETRO.has(decl.tipo)) {
        fallo(
            `Parámetro "${nombre}" de "${nombreCapacidad}": tipo "${decl.tipo}" desconocido. ` +
                `Tipos válidos: ${[...TIPOS_PARAMETRO].join(', ')}.`
        );
    }
    if (decl.tipo === 'enum' && (!Array.isArray(decl.valores) || decl.valores.length === 0)) {
        fallo(`Parámetro "${nombre}" de "${nombreCapacidad}": un enum debe declarar "valores".`);
    }
}

/**
 * Registra una capacidad. Se llama desde el manifiesto de cada adaptador, en el arranque.
 *
 * @param {Object} capacidad
 * @param {string}   capacidad.nombre       — verbo de negocio en español (`reservar_turno`).
 * @param {string}   capacidad.descripcion  — cuándo usarla; es lo que verá el modelo en F6.
 * @param {string}   capacidad.vertical     — a qué adaptador pertenece.
 * @param {string}   capacidad.tipo         — `consulta` | `mutacion`.
 * @param {string}   capacidad.feature      — entitlement que exige (ADR-021).
 * @param {Object}   [capacidad.parametros] — esquema de entrada. NUNCA incluye `id_negocio`.
 * @param {boolean}  [capacidad.idempotente]— obligatorio si es `mutacion`.
 * @param {string[]} [capacidad.politica]   — límites de Business Policy que aplica (ADR-011).
 * @param {Function} capacidad.ejecutar     — `async ({ idNegocio, args, contexto }) => resultado`.
 */
function registrar(capacidad) {
    const { nombre, descripcion, vertical, tipo, feature, parametros = {}, politica = [] } = capacidad;

    if (!NOMBRE_VALIDO.test(String(nombre || ''))) {
        fallo(
            `Nombre de capacidad inválido: "${nombre}". La convención es un verbo de negocio ` +
                'en español, minúsculas y guiones bajos (p. ej. "consultar_disponibilidad").'
        );
    }
    if (capacidades.has(nombre)) {
        fallo(`La capacidad "${nombre}" ya está registrada. Los nombres son únicos en todo el catálogo.`);
    }
    if (!descripcion || String(descripcion).trim().length < 10) {
        // La descripción no es documentación: es el texto por el que el modelo decide si
        // usar esta capacidad o no. Una descripción pobre es un bug de comportamiento.
        fallo(`La capacidad "${nombre}" necesita una descripción útil: es lo que el modelo lee para elegirla.`);
    }
    if (!vertical) fallo(`La capacidad "${nombre}" debe declarar a qué vertical pertenece.`);
    if (!Object.values(TIPO).includes(tipo)) {
        fallo(`La capacidad "${nombre}" declara tipo "${tipo}". Debe ser "consulta" o "mutacion".`);
    }
    if (!feature) {
        fallo(
            `La capacidad "${nombre}" debe declarar su feature. Nadie consulta el plan ` +
                'directamente (ADR-021): la capa comercial del Policy Gate pregunta por el entitlement.'
        );
    }
    if (typeof capacidad.ejecutar !== 'function') {
        fallo(`La capacidad "${nombre}" debe declarar una función "ejecutar".`);
    }
    if (tipo === TIPO.MUTACION && typeof capacidad.idempotente !== 'boolean') {
        // El ejercicio en papel (capability-language.md §4) descubrió que reserva y
        // restaurante divergen justo aquí: `reservar_turno` es idempotente y `agregar_item`
        // no. Un metamodelo que lo dé por supuesto no expresa un carrito. Por eso se exige
        // declararlo, en vez de asumir un valor por defecto que sería falso la mitad de las veces.
        fallo(
            `La mutación "${nombre}" debe declarar "idempotente" explícitamente. No hay valor ` +
                'por defecto razonable: reserva y restaurante divergen justo en este campo.'
        );
    }

    for (const [nombreParam, decl] of Object.entries(parametros)) {
        validarParametro(nombre, nombreParam, decl);
    }

    const delaVertical = [...capacidades.values()].filter((c) => c.vertical === vertical);
    if (delaVertical.length >= MAX_CAPACIDADES_POR_VERTICAL) {
        fallo(
            `La vertical "${vertical}" ya tiene ${MAX_CAPACIDADES_POR_VERTICAL} capacidades ` +
                `y "${nombre}" sería una más. El techo de ADR-008 es un forzador de disciplina: ` +
                'si hacen falta más, casi siempre están cortadas como CRUD y no como acciones de negocio.'
        );
    }

    capacidades.set(nombre, Object.freeze({ ...capacidad, parametros, politica }));
    return capacidades.get(nombre);
}

function obtener(nombre) {
    return capacidades.get(nombre) || null;
}

function listar({ vertical = null } = {}) {
    const todas = [...capacidades.values()];
    return vertical ? todas.filter((c) => c.vertical === vertical) : todas;
}

/**
 * Vista pública del catálogo: lo que se le puede enseñar a un cliente del Registry sin
 * exponer la implementación. En F6 es lo que el adaptador del `ModelPort` traducirá al
 * formato de function-calling del proveedor.
 */
function describir(nombre) {
    const c = capacidades.get(nombre);
    if (!c) return null;
    return {
        nombre: c.nombre,
        descripcion: c.descripcion,
        vertical: c.vertical,
        tipo: c.tipo,
        idempotente: c.idempotente ?? null,
        parametros: c.parametros,
        politica: c.politica,
    };
}

/** Solo para tests: deja el catálogo vacío. */
function _limpiar() {
    capacidades.clear();
}

module.exports = {
    registrar,
    obtener,
    listar,
    describir,
    TIPO,
    MAX_CAPACIDADES_POR_VERTICAL,
    PARAMETROS_PROHIBIDOS,
    _limpiar,
};
