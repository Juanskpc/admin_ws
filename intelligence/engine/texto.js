/**
 * Lo poco que hace falta para leer lo que escribió una persona (Nivel 1).
 *
 * Vivía dentro de `manejadorDeterminista.js`, y salió de ahí cuando F7 trajo un segundo
 * consumidor: la confirmación de una mutación también tiene que entender un «sí», y también
 * tiene que quedarse con la última línea de una ráfaga. Copiarlo habría sido peor que moverlo —
 * dos lecturas distintas de «sí» es un bot que confirma en un sitio y repregunta en el otro.
 *
 * Deliberadamente pobre: aquí no se entiende lenguaje, se reconocen palabras exactas. Entender
 * es trabajo del Nivel 4, y fingirlo con expresiones regulares produce el peor de los mundos —
 * un parser que acierta lo justo para que nadie note cuándo falla.
 */
'use strict';

/** Palabras que valen en cualquier paso. Son pocas a propósito: cada una hay que probarla. */
const COMANDO = {
    MENU: ['menu', 'menú', 'inicio', 'empezar', 'hola'],
    CANCELAR: ['cancelar', 'salir', 'olvidalo', 'olvídalo', 'nada'],
    SEGUIMOS: ['seguimos', 'continuar', 'sigamos', 'retomar'],
    SI: ['si', 'sí', 'confirmo', 'dale', 'ok', 'vale', 'listo'],
    NO: ['no', 'otra', 'cambiar'],
};

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

module.exports = { COMANDO, normalizar, ultimaLinea, esComando };
