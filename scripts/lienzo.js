'use strict';
const { PNG } = require('pngjs');

/**
 * Un lienzo mínimo para generar las imágenes de ejemplo del catálogo (servicios, profesionales
 * y logo) sin arrastrar una dependencia nativa.
 *
 * ## Por qué existe esto y no `sharp` / `canvas`
 *
 * Las dos formas normales de dibujar en Node son binarios nativos que hay que compilar en cada
 * máquina y en el VPS. Para lo único que se necesitan aquí —rellenar degradados y trazar líneas
 * gruesas— no compensa: `pngjs` (que ya está instalado) escribe el PNG y el resto son cuentas
 * sobre un array de píxeles. Nada de esto corre en producción; es una herramienta de siembra.
 *
 * ## Cómo dibuja
 *
 * Todo se reduce a **una** primitiva: la distancia de un píxel al segmento más cercano de un
 * trazo. Con eso salen las líneas (distancia < grosor), los remates redondos (sale gratis: la
 * distancia a un segmento ya es redonda en los extremos) y el antialiasing (la cobertura es la
 * distancia interpolada en el último píxel del borde). Las curvas son polilíneas de 48 tramos:
 * a los tamaños que se usan aquí no se distingue de una curva real.
 *
 * Las coordenadas de las figuras van en 0..1 sobre una caja, no en píxeles, para que el mismo
 * dibujo sirva a 512 y a 800 sin retocar números.
 */

// ───────────────────────────── Color ─────────────────────────────

function hexARgb(hex) {
    const h = String(hex).replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mezclar(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Luminancia relativa (WCAG) para decidir si encima va tinta clara u oscura. */
function luminancia([r, g, b]) {
    const c = [r, g, b].map(v => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

// ───────────────────────────── Lienzo ─────────────────────────────

class Lienzo {
    constructor(ancho, alto) {
        this.ancho = ancho;
        this.alto = alto;
        this.px = new Float64Array(ancho * alto * 3);
    }

    /** Mezcla un color sobre un píxel con una cobertura 0..1. */
    _pintar(x, y, color, cobertura) {
        if (cobertura <= 0 || x < 0 || y < 0 || x >= this.ancho || y >= this.alto) return;
        const a = Math.min(1, cobertura);
        const i = (y * this.ancho + x) * 3;
        this.px[i]     += (color[0] - this.px[i])     * a;
        this.px[i + 1] += (color[1] - this.px[i + 1]) * a;
        this.px[i + 2] += (color[2] - this.px[i + 2]) * a;
    }

    /**
     * Degradado lineal en la dirección `grados` (0 = izquierda→derecha, 90 = arriba→abajo).
     * Es siempre la primera capa: rellena el lienzo entero.
     */
    degradado(grados, hexA, hexB) {
        const a = hexARgb(hexA), b = hexARgb(hexB);
        const rad = (grados * Math.PI) / 180;
        const dx = Math.cos(rad), dy = Math.sin(rad);
        // Proyección normalizada al rango del lienzo, para que el degradado cubra justo el ancho.
        const largo = Math.abs(dx) * this.ancho + Math.abs(dy) * this.alto;
        const x0 = dx < 0 ? this.ancho : 0;
        const y0 = dy < 0 ? this.alto : 0;
        for (let y = 0; y < this.alto; y++) {
            for (let x = 0; x < this.ancho; x++) {
                const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / largo));
                const c = mezclar(a, b, t);
                const i = (y * this.ancho + x) * 3;
                this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2];
            }
        }
    }

    /**
     * Mancha radial difuminada. Es lo que quita el aire de «degradado de plantilla»: rompe las
     * bandas rectas y da la sensación de luz viniendo de algún sitio.
     *
     * @param {number} cx,cy,r  en fracción del lado menor (0..1)
     */
    mancha(cx, cy, r, hex, alfa = 0.35) {
        const color = hexARgb(hex);
        const lado = Math.min(this.ancho, this.alto);
        const px = cx * this.ancho, py = cy * this.alto, pr = r * lado;
        const x1 = Math.max(0, Math.floor(px - pr)), x2 = Math.min(this.ancho - 1, Math.ceil(px + pr));
        const y1 = Math.max(0, Math.floor(py - pr)), y2 = Math.min(this.alto - 1, Math.ceil(py + pr));
        for (let y = y1; y <= y2; y++) {
            for (let x = x1; x <= x2; x++) {
                const d = Math.hypot(x - px, y - py) / pr;
                if (d >= 1) continue;
                // Caída suave (smoothstep al cuadrado): sin bordes visibles.
                const caida = (1 - d) * (1 - d);
                this._pintar(x, y, color, caida * alfa);
            }
        }
    }

    /** Velo lineal, para oscurecer un lado y que el texto de la tarjeta se lea encima. */
    velo(grados, hex, alfaMax) {
        const color = hexARgb(hex);
        const rad = (grados * Math.PI) / 180;
        const dx = Math.cos(rad), dy = Math.sin(rad);
        const largo = Math.abs(dx) * this.ancho + Math.abs(dy) * this.alto;
        const x0 = dx < 0 ? this.ancho : 0;
        const y0 = dy < 0 ? this.alto : 0;
        for (let y = 0; y < this.alto; y++) {
            for (let x = 0; x < this.ancho; x++) {
                const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / largo));
                this._pintar(x, y, color, t * t * alfaMax);
            }
        }
    }

    /**
     * Traza polilíneas con grosor y remates redondos.
     *
     * @param {Array<Array<[number,number]>>} figuras  polilíneas en coordenadas 0..1
     * @param {object} opciones
     *   caja    {x,y,w,h} región del lienzo (0..1) donde encaja el dibujo
     *   grosor  fracción del lado menor de la caja
     */
    trazar(figuras, { caja = { x: 0, y: 0, w: 1, h: 1 }, grosor = 0.05, hex = '#ffffff', alfa = 1 } = {}) {
        const color = hexARgb(hex);
        const cx = caja.x * this.ancho, cy = caja.y * this.alto;
        const cw = caja.w * this.ancho, ch = caja.h * this.alto;
        const mitad = (grosor * Math.min(cw, ch)) / 2;

        // Todos los segmentos en píxeles, de una vez: recorrer el bounding box una sola vez es
        // mucho más barato que hacerlo por figura cuando las figuras se solapan.
        const segmentos = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const figura of figuras) {
            for (let i = 0; i < figura.length - 1; i++) {
                const ax = cx + figura[i][0] * cw,     ay = cy + figura[i][1] * ch;
                const bx = cx + figura[i + 1][0] * cw, by = cy + figura[i + 1][1] * ch;
                segmentos.push([ax, ay, bx, by]);
                minX = Math.min(minX, ax, bx); maxX = Math.max(maxX, ax, bx);
                minY = Math.min(minY, ay, by); maxY = Math.max(maxY, ay, by);
            }
        }
        if (!segmentos.length) return;

        const x1 = Math.max(0, Math.floor(minX - mitad - 1)), x2 = Math.min(this.ancho - 1, Math.ceil(maxX + mitad + 1));
        const y1 = Math.max(0, Math.floor(minY - mitad - 1)), y2 = Math.min(this.alto - 1, Math.ceil(maxY + mitad + 1));

        for (let y = y1; y <= y2; y++) {
            for (let x = x1; x <= x2; x++) {
                let d = Infinity;
                const pxc = x + 0.5, pyc = y + 0.5;
                for (const [ax, ay, bx, by] of segmentos) {
                    const vx = bx - ax, vy = by - ay;
                    const len2 = vx * vx + vy * vy;
                    let t = len2 === 0 ? 0 : ((pxc - ax) * vx + (pyc - ay) * vy) / len2;
                    t = t < 0 ? 0 : t > 1 ? 1 : t;
                    const dd = Math.hypot(pxc - (ax + t * vx), pyc - (ay + t * vy));
                    if (dd < d) { d = dd; if (d <= mitad - 1) break; }
                }
                // Cobertura: 1 dentro, 0 fuera, interpolada en el píxel del borde.
                const cobertura = Math.min(1, Math.max(0, mitad - d + 0.5));
                if (cobertura > 0) this._pintar(x, y, color, cobertura * alfa);
            }
        }
    }

    /** Codifica el lienzo como PNG y devuelve el buffer (el que guarda es `imagenService`). */
    async aBufferPNG() {
        const png = new PNG({ width: this.ancho, height: this.alto });
        for (let i = 0, j = 0; i < this.px.length; i += 3, j += 4) {
            png.data[j]     = Math.round(Math.min(255, Math.max(0, this.px[i])));
            png.data[j + 1] = Math.round(Math.min(255, Math.max(0, this.px[i + 1])));
            png.data[j + 2] = Math.round(Math.min(255, Math.max(0, this.px[i + 2])));
            png.data[j + 3] = 255;
        }
        return new Promise((resolve, reject) => {
            const chunks = [];
            png.pack()
                .on('data', c => chunks.push(c))
                .on('end', () => resolve(Buffer.concat(chunks)))
                .on('error', reject);
        });
    }
}

/** Polilínea que aproxima un arco de elipse. Ángulos en grados; 0 = derecha, 90 = abajo. */
function arco(cx, cy, rx, ry, desde, hasta, pasos = 48) {
    const puntos = [];
    for (let i = 0; i <= pasos; i++) {
        const g = desde + ((hasta - desde) * i) / pasos;
        const r = (g * Math.PI) / 180;
        puntos.push([cx + rx * Math.cos(r), cy + ry * Math.sin(r)]);
    }
    return puntos;
}

module.exports = { Lienzo, arco, hexARgb, mezclar, luminancia };
