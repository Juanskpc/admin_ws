'use strict';
const { arco } = require('./lienzo');

/**
 * Alfabeto e iconos de línea, dibujados como polilíneas en una caja 0..1 (y hacia abajo).
 *
 * Son trazos, no contornos rellenos: una letra es «por dónde pasaría el rotulador». Sale un
 * tipo geométrico monolineal —el mismo aire que los iconos de la app— y, sobre todo, evita
 * tener que resolver el relleno de un polígono con agujeros para poner dos iniciales en un
 * avatar.
 */

const A = arco;   // alias, aquí se usa mucho

const LETRAS = {
    A: [[[0.15, 0.9], [0.5, 0.1], [0.85, 0.9]], [[0.27, 0.62], [0.73, 0.62]]],
    B: [[[0.22, 0.1], [0.22, 0.9]],
        [[0.22, 0.1], [0.6, 0.1], [0.78, 0.29], [0.6, 0.5], [0.22, 0.5]],
        [[0.22, 0.5], [0.64, 0.5], [0.82, 0.7], [0.64, 0.9], [0.22, 0.9]]],
    C: [A(0.5, 0.5, 0.35, 0.4, 55, 305)],
    D: [[[0.24, 0.1], [0.24, 0.9]], A(0.42, 0.5, 0.4, 0.4, 270, 450)],
    E: [[[0.26, 0.1], [0.26, 0.9]], [[0.26, 0.1], [0.78, 0.1]],
        [[0.26, 0.5], [0.7, 0.5]], [[0.26, 0.9], [0.78, 0.9]]],
    F: [[[0.26, 0.1], [0.26, 0.9]], [[0.26, 0.1], [0.78, 0.1]], [[0.26, 0.5], [0.7, 0.5]]],
    G: [A(0.5, 0.5, 0.35, 0.4, 40, 305), [[0.77, 0.76], [0.77, 0.52]], [[0.77, 0.52], [0.56, 0.52]]],
    H: [[[0.22, 0.1], [0.22, 0.9]], [[0.78, 0.1], [0.78, 0.9]], [[0.22, 0.5], [0.78, 0.5]]],
    I: [[[0.5, 0.1], [0.5, 0.9]]],
    J: [[[0.7, 0.1], [0.7, 0.66]], A(0.46, 0.66, 0.24, 0.24, 0, 180)],
    K: [[[0.24, 0.1], [0.24, 0.9]], [[0.8, 0.1], [0.26, 0.53]], [[0.38, 0.44], [0.8, 0.9]]],
    L: [[[0.28, 0.1], [0.28, 0.9], [0.78, 0.9]]],
    M: [[[0.16, 0.9], [0.16, 0.1], [0.5, 0.6], [0.84, 0.1], [0.84, 0.9]]],
    N: [[[0.22, 0.9], [0.22, 0.1], [0.78, 0.9], [0.78, 0.1]]],
    O: [A(0.5, 0.5, 0.35, 0.4, 0, 360)],
    P: [[[0.24, 0.9], [0.24, 0.1]], [[0.24, 0.1], [0.62, 0.1], [0.8, 0.31], [0.62, 0.52], [0.24, 0.52]]],
    Q: [A(0.5, 0.5, 0.35, 0.4, 0, 360), [[0.6, 0.68], [0.84, 0.94]]],
    R: [[[0.24, 0.9], [0.24, 0.1]], [[0.24, 0.1], [0.62, 0.1], [0.8, 0.31], [0.62, 0.52], [0.24, 0.52]],
        [[0.48, 0.52], [0.8, 0.9]]],
    S: [[[0.78, 0.21], [0.6, 0.1], [0.36, 0.1], [0.24, 0.25], [0.3, 0.41],
         [0.7, 0.6], [0.76, 0.76], [0.63, 0.9], [0.39, 0.9], [0.22, 0.79]]],
    T: [[[0.5, 0.1], [0.5, 0.9]], [[0.18, 0.1], [0.82, 0.1]]],
    U: [[[0.22, 0.1], [0.22, 0.62]], [[0.78, 0.1], [0.78, 0.62]], A(0.5, 0.62, 0.28, 0.28, 0, 180)],
    V: [[[0.18, 0.1], [0.5, 0.9], [0.82, 0.1]]],
    W: [[[0.12, 0.1], [0.31, 0.9], [0.5, 0.38], [0.69, 0.9], [0.88, 0.1]]],
    X: [[[0.2, 0.1], [0.8, 0.9]], [[0.8, 0.1], [0.2, 0.9]]],
    Y: [[[0.2, 0.1], [0.5, 0.5], [0.8, 0.1]], [[0.5, 0.5], [0.5, 0.9]]],
    Z: [[[0.2, 0.1], [0.8, 0.1], [0.2, 0.9], [0.8, 0.9]]],
    'Ñ': [[[0.22, 0.9], [0.22, 0.22], [0.78, 0.9], [0.78, 0.22]], [[0.26, 0.06], [0.74, 0.06]]],
};

/**
 * Iconos de línea para las fotos de servicio.
 *
 * No pretenden ser un set completo: cubren lo que un salón vende de verdad. Lo que no encaje
 * cae en `destello`, que no miente sobre qué es —un adorno— en vez de poner un icono equivocado.
 */
const ICONOS = {
    tijeras: [
        [[0.18, 0.1], [0.7, 0.68]],
        [[0.82, 0.1], [0.3, 0.68]],
        A(0.24, 0.8, 0.13, 0.13, 0, 360),
        A(0.76, 0.8, 0.13, 0.13, 0, 360),
    ],
    navaja: [
        [[0.12, 0.88], [0.44, 0.56]],
        [[0.42, 0.58], [0.84, 0.14], [0.92, 0.24], [0.5, 0.66], [0.42, 0.58]],
    ],
    peine: [
        [[0.1, 0.32], [0.9, 0.32]],
        [[0.2, 0.32], [0.2, 0.74]], [[0.34, 0.32], [0.34, 0.74]], [[0.48, 0.32], [0.48, 0.74]],
        [[0.62, 0.32], [0.62, 0.74]], [[0.76, 0.32], [0.76, 0.74]],
    ],
    secador: [
        [[0.18, 0.26], [0.66, 0.26], [0.66, 0.52], [0.18, 0.52], [0.18, 0.26]],
        [[0.66, 0.31], [0.9, 0.24], [0.9, 0.54], [0.66, 0.47]],
        [[0.34, 0.52], [0.3, 0.9]], [[0.52, 0.52], [0.56, 0.9]], [[0.3, 0.9], [0.56, 0.9]],
    ],
    brocha: [
        [[0.24, 0.9], [0.58, 0.28]],
        [[0.46, 0.44], [0.76, 0.1], [0.9, 0.22], [0.6, 0.56], [0.46, 0.44]],
    ],
    esmalte: [
        [[0.32, 0.44], [0.68, 0.44], [0.68, 0.9], [0.32, 0.9], [0.32, 0.44]],
        [[0.44, 0.44], [0.44, 0.3], [0.56, 0.3], [0.56, 0.44]],
        [[0.4, 0.3], [0.6, 0.3], [0.6, 0.1], [0.4, 0.1], [0.4, 0.3]],
    ],
    gota: [
        [[0.5, 0.08], [0.77, 0.47]],
        A(0.5, 0.58, 0.28, 0.32, 0, 180),
        [[0.23, 0.47], [0.5, 0.08]],
    ],
    ceja: [
        A(0.5, 0.64, 0.32, 0.2, 192, 348),
        A(0.5, 0.52, 0.36, 0.24, 196, 344),
    ],
    espejo: [
        A(0.5, 0.38, 0.28, 0.28, 0, 360),
        [[0.5, 0.66], [0.5, 0.92]], [[0.34, 0.92], [0.66, 0.92]],
    ],
    destello: [
        [[0.5, 0.06], [0.58, 0.42], [0.94, 0.5], [0.58, 0.58], [0.5, 0.94],
         [0.42, 0.58], [0.06, 0.5], [0.42, 0.42], [0.5, 0.06]],
    ],
};

/**
 * Elige icono por lo que dice el nombre del servicio.
 *
 * El orden importa: «corte y barba» debe caer en barba, no en corte, porque la navaja es lo que
 * distingue ese servicio del corte a secas. Por eso las claves más específicas van primero.
 */
const REGLAS_ICONO = [
    [/barba|afeitad|navaja|perfilad/i, 'navaja'],
    [/ceja|depilac/i,                  'ceja'],
    [/manicur|pedicur|u[ñn]a|esmalt/i, 'esmalte'],
    [/tinte|mecha|balayage|color/i,    'brocha'],
    [/keratina|alisad|tratamient|hidrat|masaje/i, 'gota'],
    [/peinad|secad|brushing|onda|recogid/i, 'secador'],
    [/corte|cabello|infantil|pelo/i,   'tijeras'],
    [/maquillaj|facial|spa|estetic|estétic/i, 'espejo'],
];

function iconoPara(nombre) {
    for (const [patron, icono] of REGLAS_ICONO) {
        if (patron.test(nombre)) return ICONOS[icono];
    }
    return ICONOS.destello;
}

/**
 * Iniciales de un nombre, sin acentos y como máximo dos.
 *
 * «Andrés Mora» → AM. Un nombre de una palabra da una sola letra: dos iniciales inventadas a
 * partir de la segunda sílaba se leen como un error de datos.
 */
function iniciales(nombre) {
    const limpio = String(nombre || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toUpperCase().replace(/[^A-Z\s]/g, ' ').trim();
    const palabras = limpio.split(/\s+/).filter(Boolean);
    if (!palabras.length) return '?';
    return (palabras[0][0] + (palabras[1]?.[0] ?? '')).slice(0, 2);
}

/**
 * Compone el texto en polilíneas centradas dentro de la caja 0..1.
 *
 * Cada letra ocupa una celda del mismo ancho (es una monoespaciada): el kerning proporcional no
 * aporta nada con una o dos letras y complicaría el cálculo del centro.
 */
function texto(cadena, { separacion = 0.14 } = {}) {
    const letras = [...String(cadena)].filter(c => LETRAS[c]);
    if (!letras.length) return [];

    const anchoCelda = 1 / letras.length;
    const escala = 1 - separacion;
    const figuras = [];
    letras.forEach((letra, i) => {
        const x0 = i * anchoCelda + (anchoCelda * separacion) / 2;
        for (const figura of LETRAS[letra]) {
            figuras.push(figura.map(([x, y]) => [x0 + x * anchoCelda * escala, y]));
        }
    });
    return figuras;
}

module.exports = { LETRAS, ICONOS, iconoPara, iniciales, texto };
