/**
 * Prompt Builder — ensambla el prompt de lo más estable a lo más volátil (ADR-019).
 *
 * ## La regla, y por qué es mecánica y no un juicio
 *
 * La caché de prefijo del proveedor es un **match de bytes desde el principio**: lo que cambia
 * en la posición N invalida todo lo que viene después. Cobrar 0.1× por el prefijo repetido o
 * 1× por todo es la diferencia entre un producto rentable y uno que quema dinero, y el fallo no
 * avisa — no hay error, solo una factura que sube.
 *
 * Por eso el orden es una regla dura y no una decisión caso por caso:
 *
 * ```
 * [ catálogo de capacidades ]          ← el proveedor lo renderiza primero (tools)
 * [ instrucciones del sistema ]        ← artefacto versionado, rara vez cambia
 * [ contexto del negocio ]             ← estable por inquilino
 * ─────────── punto de corte de caché ───────────
 * [ ranura de conocimiento ]           ← vacía en v1 (ADR-020)
 * [ historial reciente ]
 * [ mensaje nuevo + fecha y hora ]     ← la fecha, siempre lo último
 * ```
 *
 * ⚠️ **Leer ADR-019 de arriba abajo sugiere que las capacidades van las terceras.** Físicamente
 * el proveedor renderiza `tools` → `system` → `messages`, así que van las primeras. No importa:
 * están **antes del corte**, que es lo único que la regla exige. Y como van antes, la marca de
 * caché tiene que ir en el **último bloque de `system`** para que las cubra a ellas también
 * (lo hace el adaptador; ver `renderizarSystem`).
 *
 * ## Dónde va exactamente la fecha
 *
 * Al final del mensaje nuevo del cliente. Cuando el turno entra en el bucle de capacidades, los
 * resultados se apilan **después** de la fecha, así que deja de ser literalmente lo último — y
 * es correcto que así sea: reubicarla en cada vuelta cambiaría bytes en mitad del prefijo y
 * tiraría la caché **entre las vueltas del propio turno**, que es donde más se repite el prompt.
 * La regla que importa se cumple: nada que cambie por petición va delante de algo estable.
 *
 * ## Los prompts son artefactos, no cadenas en el código
 *
 * `prompts/sistema.v1.md` se versiona en el nombre del archivo. Editar un prompt es un cambio de
 * comportamiento del producto: tiene que verse en un `git diff` como tal, y el arnés de
 * evaluación tiene que poder decir si la versión nueva mejora o empeora. Una plantilla armada a
 * base de `+` dentro de una función no permite ni lo uno ni lo otro.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const puerto = require('./puerto');

/**
 * Versión del prompt del sistema que se está usando. Viaja al Ledger con cada turno.
 *
 * `v2` (F7) fue `v1` con una diferencia de comportamiento, no de estilo: el asistente ya podía
 * **pedir** mutaciones, y lo que se le prohibía era decir que ya estaban hechas.
 *
 * `v3` (2026-08-26) es lo contrario: **solo cambia el estilo**, y por eso importa. El dueño
 * miró las conversaciones de producción y dijo lo que se ve enseguida — «es eso, un bot». La
 * `v2` pedía «cercano y breve» y a la vez prohibía toda lista, así que un restaurante que
 * enumera platos con precio escribía párrafos; y no decía nada sobre no hacerle navegar al
 * cliente la organización interna del negocio, que es de donde salía el «tenemos las siguientes
 * categorías, ¿cuál quieres ver?».
 *
 * Las versiones anteriores se quedan en el repositorio a propósito — es lo que hace que el arnés
 * pueda comparar y decir si la nueva mejora o empeora, que es la razón de que los prompts sean
 * archivos versionados y no cadenas en el código.
 */
const PROMPT_SISTEMA = 'sistema.v4';

/**
 * Los prompts se leen una vez y se quedan en memoria.
 *
 * No es una optimización: es la disciplina de caché. Releer el archivo por turno abriría la
 * puerta a que dos turnos de la misma conversación usaran versiones distintas si alguien edita
 * el archivo en caliente, y eso invalidaría el prefijo sin que nadie entienda por qué.
 */
const cacheDePrompts = new Map();

function cargarPrompt(nombre) {
    if (!cacheDePrompts.has(nombre)) {
        const ruta = path.join(__dirname, 'prompts', `${nombre}.md`);
        cacheDePrompts.set(nombre, fs.readFileSync(ruta, 'utf8').trim());
    }
    return cacheDePrompts.get(nombre);
}

/**
 * Business Context: la configuración del negocio, en el prefijo estable (ADR-020).
 *
 * ⚠️ Aquí va **solo configuración**, nunca contenido. El menú en PDF, el reglamento o las FAQ
 * son Knowledge, van en la ranura de después del corte y por eso este texto puede quedarse
 * cacheado meses. Meter aquí un documento del negocio invalidaría el prefijo de *todas* sus
 * conversaciones cada vez que lo suba, que es el error de categoría con factura mensual que
 * ADR-020 existe para prevenir.
 */
function bloqueDeNegocio(negocio) {
    const lineas = ['# El negocio para el que trabajas', ''];
    lineas.push(`Nombre: ${negocio?.nombre || 'sin nombre registrado'}`);
    lineas.push(`Así te refieres a él al hablar: ${negocio?.tratamiento || 'el negocio'}`);
    return lineas.join('\n');
}

/**
 * La fecha y la hora, formateadas en la zona del negocio.
 *
 * Se calcula con `Intl.DateTimeFormat` y **no** pasando por `toISOString()`: la trampa ya pagada
 * (ESTADO-Y-CONTINUACION §8) es que convertir a UTC y volver solo se cancela si el proceso corre
 * en UTC, y en un PC en Bogotá a partir de las 19:00 «hoy» se convierte en mañana. Correcto por
 * la mañana y roto por la noche es la peor forma de fallar.
 */
function textoDeAhora(ahora, zona = 'America/Bogota') {
    const fecha = new Intl.DateTimeFormat('en-CA', {
        timeZone: zona,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(ahora);
    const hora = new Intl.DateTimeFormat('es-CO', {
        timeZone: zona,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(ahora);
    const diaSemana = new Intl.DateTimeFormat('es-CO', {
        timeZone: zona,
        weekday: 'long',
    }).format(ahora);

    return `<ahora>${diaSemana} ${fecha}, ${hora} (hora local del negocio)</ahora>`;
}

/**
 * Envuelve el texto de una persona como **dato no confiable**.
 *
 * Es la primera de las tres defensas contra inyección de prompt del master-plan, y la única que
 * vive aquí. Las otras dos: que el catálogo del modelo sea corto y explícito —no hay herramienta
 * para nada que no sea una capacidad registrada— y, desde F7, que **ninguna mutación se ejecute
 * sin que el cliente diga sí** (ADR-010). Hasta F6 la segunda era más fuerte todavía: no existía
 * ninguna mutación expuesta al modelo. Marcar el texto no es la defensa principal — las
 * instrucciones se eluden — pero sin marcarlo el modelo no tiene ni forma de distinguir.
 *
 * Se sanean los cierres de etiqueta para que el propio texto no pueda cerrar el sobre y escribir
 * fuera de él, que es el truco obvio.
 */
function comoDatoNoConfiable(texto) {
    const limpio = String(texto ?? '').replace(/<\/?mensaje_del_cliente>/gi, '');
    return `<mensaje_del_cliente>\n${limpio}\n</mensaje_del_cliente>`;
}

/**
 * Construye la petición canónica de un turno.
 *
 * @param {Object}   opciones
 * @param {Object}   opciones.negocio      — Business Context (`core/contextoNegocio.js`).
 * @param {Array}    opciones.capacidades  — descriptores del Registry ya filtrados por el Gate.
 * @param {Array}    opciones.historial    — turnos previos `{rol: 'cliente'|'asistente', texto}`.
 * @param {string}   opciones.mensaje      — lo que acaba de escribir el cliente.
 * @param {Date}     opciones.ahora
 * @param {string[]} [opciones.conocimiento] — ranura de ADR-020. **Vacía en v1.**
 */
function construir({
    negocio,
    capacidades = [],
    historial = [],
    mensaje,
    ahora = new Date(),
    conocimiento = [],
    modelo,
    maxTokens = 2048,
    esfuerzo = 'low',
    idNegocio = null,
    zona = 'America/Bogota',
}) {
    const instrucciones = [
        { texto: cargarPrompt(PROMPT_SISTEMA), cacheable: false },
        // La marca va en el ÚLTIMO bloque estable: cachea este, el de arriba y el catálogo.
        { texto: bloqueDeNegocio(negocio), cacheable: true },
    ];

    // ── Punto de corte ──────────────────────────────────────────────────────────────────
    // Lo de aquí abajo es volátil y no se cachea. La ranura de conocimiento está vacía en v1
    // (ADR-020: reservar el terreno cuesta casi nada; implementarlo sin un caso real, mucho).
    // El día que Knowledge exista, se llena aquí y no hay que rediseñar nada.
    if (conocimiento.length > 0) {
        instrucciones.push({
            texto: `# Información del negocio consultada para esta pregunta\n\n${conocimiento.join('\n\n')}`,
            cacheable: false,
        });
    }

    const turnos = historial.map((t) => ({
        rol: t.rol,
        texto: t.rol === puerto.ROL.CLIENTE ? comoDatoNoConfiable(t.texto) : t.texto,
    }));

    turnos.push({
        rol: puerto.ROL.CLIENTE,
        texto: `${comoDatoNoConfiable(mensaje)}\n\n${textoDeAhora(ahora, zona)}`,
    });

    return puerto.normalizarPeticion({
        modelo,
        instrucciones,
        capacidades,
        historial: turnos,
        maxTokens,
        esfuerzo,
        idNegocio,
    });
}

/** Solo para tests: obliga a releer los artefactos del disco. */
function _limpiarCache() {
    cacheDePrompts.clear();
}

module.exports = {
    PROMPT_SISTEMA,
    construir,
    cargarPrompt,
    comoDatoNoConfiable,
    textoDeAhora,
    bloqueDeNegocio,
    _limpiarCache,
};
