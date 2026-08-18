/**
 * Precios de los modelos y cálculo del costo de un turno (F6, ADR-022).
 *
 * ## Por qué esto no es un `float`
 *
 * `intelligence.costo.costo_usd` es `numeric(14,8)` y no `double precision` por una razón
 * escrita en la migración de F5-A: **esto factura**. Un céntimo perdido por redondeo, por un
 * millón de turnos, es un descuadre que nadie sabe explicar después. Pero declarar la columna
 * bien no sirve de nada si el número llega ya estropeado desde JavaScript: `0.1 + 0.2` no es
 * `0.3` en coma flotante, y el precio por token es un número minúsculo multiplicado por
 * decenas de miles de tokens, que es justo la forma de la operación donde el error se acumula.
 *
 * Así que aquí **no hay coma flotante en ningún punto**. Los precios se declaran en
 * **nanodólares por token** (1 n$ = 1e-9 USD), que resulta ser un entero exacto para todos los
 * modelos —$5/MTok = 5 000 n$/token—, la suma es aritmética entera, y solo al final se formatea
 * como cadena decimal para dárselo a Postgres. Postgres parsea la cadena a `numeric` sin pasar
 * por un `double`; mandarle un `Number` de JS sí lo haría.
 *
 * Todos los precios son múltiplos de 10 n$, así que el total siempre cabe **exacto** en los 8
 * decimales de la columna. Si algún día un proveedor cobra un precio que no lo sea, esto lo
 * detecta: ver `aNanoPorToken()`.
 *
 * ## Por qué el catálogo es código y no una tabla
 *
 * Mismo argumento que el Capability Registry (ADR-008): un precio cambia cuando el proveedor lo
 * cambia, no cuando cambia un inquilino. Una tabla de precios sería configuración que nadie
 * edita y que puede desincronizarse de la realidad sin que nada lo note. Lo que sí es dato es
 * lo **gastado**, y eso vive en el Ledger.
 *
 * ⚠️ **Los precios de aquí son los de la lista pública en la fecha indicada.** Un contrato con
 * descuento haría que este número sea el costo *de lista* y no la factura. Se registra el de
 * lista a propósito: es el único que se puede comprobar contra la documentación del proveedor,
 * y es el que hace comparables dos inquilinos entre sí.
 */
'use strict';

/** 1 USD = 1e9 nanodólares. */
const NANO_POR_USD = 1_000_000_000;

/** Un millón de tokens, que es la unidad en la que publican los precios los proveedores. */
const TOKENS_POR_MTOK = 1_000_000;

/**
 * Convierte «dólares por millón de tokens» a nanodólares por token, exigiendo que el resultado
 * sea un **múltiplo de 10**.
 *
 * El `throw` no es paranoia decorativa. Entero garantiza que la suma sea exacta; múltiplo de 10
 * garantiza además que el total **quepa exacto en los 8 decimales de la columna**. Sin la
 * segunda condición hay precios que pasan el filtro y luego revientan a mitad de un turno
 * cualquiera: `gpt-4o-mini` cobra la caché a $0.075/MTok, que son 7.5 nanodólares por token y
 * son 9 decimales. Con un número impar de tokens el importe no cabe, y el fallo aparecería en
 * producción, en el primer turno con la paridad equivocada.
 *
 * Que reviente al cargar el módulo es exactamente lo que se quiere: un modelo que no se puede
 * facturar exacto no debe estar en el catálogo.
 */
function aNanoPorToken(usdPorMTok, etiqueta) {
    const nano = (usdPorMTok * NANO_POR_USD) / TOKENS_POR_MTOK;
    if (!Number.isInteger(nano) || nano % 10 !== 0) {
        throw new Error(
            `El precio ${etiqueta} (${usdPorMTok} USD/MTok) son ${nano} nanodólares por token, ` +
                'y no es un múltiplo de 10. La aritmética de costos es entera a propósito ' +
                '(numeric(14,8) factura): un modelo que no cabe exacto en 8 decimales no entra ' +
                'al catálogo hasta que se suba la resolución de la columna.'
        );
    }
    return nano;
}

/**
 * Catálogo de modelos con su precio de lista, en dólares por millón de tokens.
 *
 * ## Las cuatro tarifas se declaran, no se derivan
 *
 * La primera versión calculaba la caché como un multiplicador de la entrada (0.1× leer, 1.25×
 * escribir), porque con un solo proveedor eso era verdad. Con el segundo dejó de serlo: OpenAI
 * cobra la caché a 0.1× en los modelos nuevos y a 0.5× en `gpt-4o`, y **no cobra la escritura**
 * porque su caché es automática. Un multiplicador global habría cobrado de más en un caso y de
 * menos en otro, en silencio y sin que ningún test lo notara.
 *
 * Así que cada modelo declara sus cuatro tarifas tal como las publica el proveedor. Es más
 * verboso y es la única forma de que el número cuadre con la factura.
 *
 * `nivel` no es una etiqueta comercial: es el peldaño de la escalera de ADR-018 al que este
 * modelo sirve. El Nivel 1 es determinista y no aparece aquí porque no cuesta nada, que es
 * exactamente su gracia.
 */
const MODELOS = {
    // ── Anthropic ────────────────────────────────────────────────────────────────────────
    // Opus 5 es el modelo más capaz de la línea Opus y entra al mismo precio que el 4.8, que es
    // el que nombra ADR-018 con un «hoy» delante. Ver `docs/nivel-4.md`.
    'claude-opus-5': {
        proveedor: 'anthropic',
        entradaMTok: 5,
        salidaMTok: 25,
        cacheLecturaMTok: 0.5,
        cacheEscrituraMTok: 6.25, // TTL de 5 minutos; el de 1 h sería 10 y no lo usamos
        nivel: 4,
    },
    'claude-opus-4-8': {
        proveedor: 'anthropic',
        entradaMTok: 5,
        salidaMTok: 25,
        cacheLecturaMTok: 0.5,
        cacheEscrituraMTok: 6.25,
        nivel: 4,
    },
    'claude-haiku-4-5': {
        proveedor: 'anthropic',
        entradaMTok: 1,
        salidaMTok: 5,
        cacheLecturaMTok: 0.1,
        cacheEscrituraMTok: 1.25,
        nivel: 2,
    },

    // ── OpenAI ───────────────────────────────────────────────────────────────────────────
    // La caché de OpenAI es automática y no se cobra por escribirla: no hay marca que poner en
    // el prompt ni tarifa de escritura. La disciplina de ADR-019 sigue valiendo igual —lo
    // estable delante, lo volátil detrás— porque el descuento depende de que el prefijo
    // coincida, no de cómo se pida.
    'gpt-5.6-sol': {
        proveedor: 'openai',
        entradaMTok: 5,
        salidaMTok: 30,
        cacheLecturaMTok: 0.5,
        cacheEscrituraMTok: 0,
        nivel: 4,
    },
    'gpt-5.6-terra': {
        proveedor: 'openai',
        entradaMTok: 2,
        salidaMTok: 12,
        cacheLecturaMTok: 0.2,
        cacheEscrituraMTok: 0,
        nivel: 4,
    },
    // El barato. Sirve para responder con datos una pregunta que ADR-018 dejó abierta: si un
    // modelo 25 veces más barato hace bien este trabajo, el nivel intermedio se justifica; si
    // no, queda desmentido. Es exactamente lo que el ADR quería que el registro por-nivel
    // acabara decidiendo, en vez de una corazonada.
    'gpt-5.6-luna': {
        proveedor: 'openai',
        entradaMTok: 0.2,
        salidaMTok: 1.2,
        cacheLecturaMTok: 0.02,
        cacheEscrituraMTok: 0,
        nivel: 2,
    },
    'gpt-4o': {
        proveedor: 'openai',
        entradaMTok: 2.5,
        salidaMTok: 10,
        cacheLecturaMTok: 1.25,
        cacheEscrituraMTok: 0,
        nivel: 4,
    },
};

/** Fecha en que se comprobaron los precios contra la documentación del proveedor. */
const PRECIOS_VERIFICADOS_EN = '2026-08-17';

/** El proveedor que sirve un modelo. Lo usa la composición para elegir adaptador. */
function proveedorDe(modelo) {
    return MODELOS[modelo]?.proveedor ?? null;
}

/** Tarifa por token, en nanodólares, de las cuatro clases de token que factura Anthropic. */
function tarifa(modelo) {
    const m = MODELOS[modelo];
    if (!m) {
        const e = new Error(
            `No hay precio declarado para el modelo "${modelo}". Un turno cuyo costo no se ` +
                'puede calcular no se puede registrar, y ADR-022 trata el costo con estándar ' +
                'contable: no se estima ni se deja en cero.'
        );
        e.code = 'MODELO_SIN_PRECIO';
        e.statusCode = 500;
        throw e;
    }
    return {
        entrada: aNanoPorToken(m.entradaMTok, `${modelo}.entrada`),
        salida: aNanoPorToken(m.salidaMTok, `${modelo}.salida`),
        cacheLectura: aNanoPorToken(m.cacheLecturaMTok, `${modelo}.cacheLectura`),
        cacheEscritura: aNanoPorToken(m.cacheEscrituraMTok, `${modelo}.cacheEscritura`),
    };
}

/**
 * Costo de un uso, en nanodólares (entero).
 *
 * ⚠️ Los cuatro contadores son **disjuntos**: `tokens_entrada` es lo que se pagó a precio
 * completo, y lo servido por caché va aparte. Sumar `entrada + cacheLectura` para «el total de
 * entrada» y luego cobrarlo a precio de entrada es el error obvio y cobra 10× de más.
 */
function costoNano(modelo, uso) {
    const t = tarifa(modelo);
    return (
        entero(uso.tokensEntrada) * t.entrada +
        entero(uso.tokensSalida) * t.salida +
        entero(uso.tokensCacheLectura) * t.cacheLectura +
        entero(uso.tokensCacheEscritura) * t.cacheEscritura
    );
}

function entero(valor) {
    const n = Number(valor ?? 0);
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`Contador de tokens inválido: ${valor}. Debe ser un entero >= 0.`);
    }
    return n;
}

/**
 * Formatea nanodólares como la cadena decimal de 8 decimales que espera `numeric(14,8)`.
 *
 * Se devuelve **cadena y no número** para que el valor no pase nunca por un `double` de JS ni
 * en el driver: `pg` manda las cadenas tal cual y Postgres las parsea a `numeric`.
 */
function formatearUsd(nano) {
    if (nano % 10 !== 0) {
        throw new Error(
            `El costo ${nano} n$ no cabe exacto en 8 decimales. Algún precio dejó de ser ` +
                'múltiplo de 10 nanodólares por token; revisar aNanoPorToken().'
        );
    }
    const negativo = nano < 0;
    const centinanos = Math.abs(nano) / 10; // unidades de 1e-8 USD
    const entera = Math.floor(centinanos / 100_000_000);
    const decimal = String(centinanos % 100_000_000).padStart(8, '0');
    return `${negativo ? '-' : ''}${entera}.${decimal}`;
}

/** El costo de un uso, listo para el Ledger. */
function costoUsd(modelo, uso) {
    return formatearUsd(costoNano(modelo, uso));
}

/** ¿Qué peldaño de la escalera sirve este modelo? Lo usa el orquestador para auditarse. */
function nivelDe(modelo) {
    return MODELOS[modelo]?.nivel ?? null;
}

function modelosConocidos() {
    return Object.keys(MODELOS);
}

module.exports = {
    MODELOS,
    PRECIOS_VERIFICADOS_EN,
    NANO_POR_USD,
    tarifa,
    costoNano,
    costoUsd,
    formatearUsd,
    nivelDe,
    proveedorDe,
    modelosConocidos,
};
