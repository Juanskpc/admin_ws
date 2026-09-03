'use strict';
require('dotenv').config();
const Models = require('../app_core/models/conection');
const ImagenService = require('../app_reserva_api/services/imagenService');
const { Lienzo, arco } = require('./lienzo');
const { iconoPara, iniciales, texto } = require('./trazos');

/**
 * Siembra las imágenes del catálogo de un negocio de reservas: foto de cada servicio, avatar de
 * cada profesional y, si falta, el logo.
 *
 * ## Qué son estas imágenes y qué no son
 *
 * Son **ilustraciones generadas**, no fotos. Un catálogo con tarjetas vacías no se puede evaluar
 * —no se ve si la retícula respira, si el precio compite con el título, si el móvil parte bien—
 * y esa es la razón de que existan. Cada una sale del nombre de la entidad, así que son estables
 * (la misma entidad da siempre la misma imagen) y coherentes entre sí.
 *
 * Cuando el negocio suba sus fotos reales desde Servicios o Profesionales, las reemplazan sin
 * más: el archivo se llama por el id, así que la subida pisa la generada. Por eso el modo normal
 * **no toca** lo que ya tiene imagen; hay que pedir `--forzar` para sobrescribir.
 *
 * ## Uso
 *
 *   node scripts/seedImagenesReserva.js --negocio=10
 *   node scripts/seedImagenesReserva.js --negocio=10 --forzar
 *   node scripts/seedImagenesReserva.js --negocio=10 --solo=servicios
 */

// Parejas oscuro→claro. Ninguna es gris: las tarjetas se ven juntas en una retícula y una
// apagada al lado de las demás parece un error de carga, no una decisión.
const PAREJAS = [
    ['#1E1B4B', '#6366F1'],
    ['#0F766E', '#2DD4BF'],
    ['#7C2D12', '#FB923C'],
    ['#831843', '#F472B6'],
    ['#14532D', '#4ADE80'],
    ['#1E3A8A', '#60A5FA'],
    ['#4C1D95', '#A78BFA'],
    ['#78350F', '#FBBF24'],
    ['#134E4A', '#5EEAD4'],
    ['#3B0764', '#C084FC'],
    ['#7F1D1D', '#F87171'],
    ['#164E63', '#22D3EE'],
];

/** Hash estable del nombre: la misma entidad recibe siempre la misma pareja de color. */
function indiceDe(texto) {
    let h = 0;
    for (const c of String(texto)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h;
}

// ─────────────────────────── Fondos ───────────────────────────

/** Bandas diagonales anchas, muy tenues. */
function bandas(l, hex) {
    const figuras = [];
    for (let i = -1; i <= 2; i += 0.34) figuras.push([[i, 1.25], [i + 0.75, -0.25]]);
    l.trazar(figuras, { grosor: 0.1, hex, alfa: 0.07 });
}

/** Arcos concéntricos saliendo de una esquina. */
function ondas(l, hex) {
    const figuras = [];
    for (let r = 0.25; r < 1.5; r += 0.19) figuras.push(arco(0.05, 1.05, r, r, 250, 360));
    l.trazar(figuras, { grosor: 0.014, hex, alfa: 0.16 });
}

/** Retícula de puntos (segmentos de longitud cero: el remate redondo los convierte en círculo). */
function puntos(l, hex) {
    const figuras = [];
    for (let y = 0.08; y < 1; y += 0.12) {
        for (let x = 0.08; x < 1; x += 0.12) figuras.push([[x, y], [x, y]]);
    }
    l.trazar(figuras, { grosor: 0.022, hex, alfa: 0.14 });
}

/** Ondas horizontales, tipo curva de nivel. */
function curvas(l, hex) {
    const figuras = [];
    for (let y = 0.1; y < 1.1; y += 0.16) {
        const puntosOnda = [];
        for (let x = -0.05; x <= 1.05; x += 0.05) {
            puntosOnda.push([x, y + Math.sin(x * Math.PI * 2.2) * 0.045]);
        }
        figuras.push(puntosOnda);
    }
    l.trazar(figuras, { grosor: 0.012, hex, alfa: 0.15 });
}

const TRAMAS = [bandas, ondas, puntos, curvas];

// ─────────────────────────── Composiciones ───────────────────────────

/**
 * Foto de un servicio: 4:3, degradado + trama + el icono de su categoría.
 *
 * 4:3 y no cuadrada porque es la proporción a la que se recorta desde la app, y así lo sembrado
 * y lo que suba el negocio encajan en la misma tarjeta sin saltos de altura.
 */
async function imagenServicio(nombre) {
    const l = new Lienzo(800, 600);
    const semilla = indiceDe(nombre);
    const [oscuro, claro] = PAREJAS[semilla % PAREJAS.length];

    l.degradado(35 + (semilla % 5) * 22, oscuro, claro);
    l.mancha(0.78, 0.22, 0.55, claro, 0.4);
    l.mancha(0.12, 0.9, 0.5, oscuro, 0.45);
    TRAMAS[semilla % TRAMAS.length](l, '#ffffff');
    // Velo hacia abajo: la tarjeta pone el nombre sobre la imagen y sin esto compite con la trama.
    l.velo(90, oscuro, 0.32);

    // Halo detrás del icono para separarlo de la trama. Con `mancha` y no con un círculo
    // trazado: un aro grueso deja el centro sin pintar y se ve el agujero en medio del icono.
    l.mancha(0.5, 0.46, 0.44, '#ffffff', 0.16);
    l.trazar(iconoPara(nombre), {
        caja: { x: 0.31, y: 0.21, w: 0.38, h: 0.5 },
        grosor: 0.05, hex: '#ffffff', alfa: 0.95,
    });

    return l.aBufferPNG();
}

/** Avatar de un profesional: cuadrado, iniciales sobre degradado y un aro fino. */
async function imagenProfesional(nombre) {
    const l = new Lienzo(512, 512);
    const semilla = indiceDe(nombre);
    const [oscuro, claro] = PAREJAS[(semilla + 5) % PAREJAS.length];

    l.degradado(120 + (semilla % 4) * 30, oscuro, claro);
    l.mancha(0.3, 0.25, 0.6, claro, 0.35);
    l.mancha(0.85, 0.9, 0.5, oscuro, 0.4);

    l.trazar([arco(0.5, 0.5, 0.4, 0.4, 0, 360)], { grosor: 0.012, hex: '#ffffff', alfa: 0.35 });

    const letras = iniciales(nombre);
    // Dos iniciales necesitan casi el doble de ancho que una; sin esto, «JP» se sale del aro.
    const ancho = letras.length > 1 ? 0.44 : 0.24;
    l.trazar(texto(letras), {
        caja: { x: 0.5 - ancho / 2, y: 0.31, w: ancho, h: 0.38 },
        grosor: letras.length > 1 ? 0.075 : 0.11,
        hex: '#ffffff', alfa: 0.96,
    });

    return l.aBufferPNG();
}

/**
 * Banner de cabecera: 16:5, panorámico.
 *
 * La cabecera del portal funde el texto del negocio (izquierda) con esta imagen (derecha), así
 * que el tercio izquierdo se deja **deliberadamente vacío y oscuro**: es donde va el nombre, y
 * cualquier detalle ahí competiría con él. El interés visual se concentra a la derecha.
 */
async function imagenBanner(nombre) {
    const l = new Lienzo(1600, 500);
    const semilla = indiceDe(nombre);
    const [oscuro, claro] = PAREJAS[semilla % PAREJAS.length];

    l.degradado(0, oscuro, claro);          // izquierda oscura → derecha clara
    l.mancha(0.82, 0.3, 0.5, claro, 0.5);
    l.mancha(0.62, 0.85, 0.42, claro, 0.28);
    l.mancha(0.05, 0.5, 0.45, oscuro, 0.6);
    TRAMAS[(semilla + 2) % TRAMAS.length](l, '#ffffff');

    // Iconos sueltos a la derecha, como un mosaico del oficio.
    const icono = iconoPara(nombre);
    l.trazar(icono, { caja: { x: 0.66, y: 0.16, w: 0.13, h: 0.42 }, grosor: 0.05, hex: '#ffffff', alfa: 0.5 });
    l.trazar(icono, { caja: { x: 0.86, y: 0.5, w: 0.1, h: 0.34 },  grosor: 0.05, hex: '#ffffff', alfa: 0.32 });
    l.trazar(icono, { caja: { x: 0.76, y: 0.62, w: 0.07, h: 0.24 }, grosor: 0.05, hex: '#ffffff', alfa: 0.22 });

    // Velo desde la izquierda: garantiza contraste para el texto pase lo que pase debajo.
    l.velo(180, oscuro, 0.55);

    return l.aBufferPNG();
}

/** Logo de reserva: cuadrado, la inicial del negocio dentro de un marco. */
async function imagenLogo(nombre) {
    const l = new Lienzo(512, 512);
    const [oscuro, claro] = PAREJAS[indiceDe(nombre) % PAREJAS.length];

    l.degradado(135, oscuro, claro);
    l.mancha(0.25, 0.2, 0.7, claro, 0.3);
    l.trazar([[[0.14, 0.14], [0.86, 0.14], [0.86, 0.86], [0.14, 0.86], [0.14, 0.14]]],
        { grosor: 0.018, hex: '#ffffff', alfa: 0.4 });

    const letra = iniciales(nombre).slice(0, 1);
    l.trazar(texto(letra), {
        caja: { x: 0.36, y: 0.3, w: 0.28, h: 0.4 },
        grosor: 0.1, hex: '#ffffff', alfa: 0.96,
    });

    return l.aBufferPNG();
}

// ─────────────────────────── Siembra ───────────────────────────

function argumento(nombre, porDefecto = null) {
    const encontrado = process.argv.find(a => a.startsWith(`--${nombre}=`));
    return encontrado ? encontrado.split('=')[1] : porDefecto;
}

async function sembrar() {
    const idNegocio = Number(argumento('negocio'));
    const forzar = process.argv.includes('--forzar');
    const solo = argumento('solo', 'todo');

    if (!idNegocio) {
        console.error('Falta --negocio=<id>.');
        process.exitCode = 1;
        return;
    }

    const negocio = await Models.GenerNegocio.findByPk(idNegocio);
    if (!negocio) {
        console.error(`No existe el negocio ${idNegocio}.`);
        process.exitCode = 1;
        return;
    }

    console.log(`\n=== Imágenes de ejemplo — ${negocio.nombre} (id ${idNegocio}) ===`);
    console.log(forzar ? 'Modo: SOBRESCRIBIR todo\n' : 'Modo: solo lo que no tiene imagen\n');
    let generadas = 0, omitidas = 0, bytes = 0;

    if (solo === 'todo' || solo === 'servicios') {
        const servicios = await Models.ReservaServicio.findAll({
            where: { id_negocio: idNegocio, estado: 'A' },
            order: [['id_servicio', 'ASC']],
        });
        console.log(`Servicios (${servicios.length}):`);
        for (const s of servicios) {
            if (s.imagen_url && !forzar) { console.log(`   = ${s.nombre} — ya tiene`); omitidas++; continue; }
            const buffer = await imagenServicio(s.nombre);
            const { url, bytes: b } = ImagenService.guardar({
                tipo: 'servicio', idNegocio, idEntidad: s.id_servicio,
                buffer, mimetype: 'image/png',
            });
            await s.update({ imagen_url: url, fecha_actualizacion: new Date() });
            console.log(`   + ${s.nombre} — ${(b / 1024).toFixed(0)} KB`);
            generadas++; bytes += b;
        }
    }

    if (solo === 'todo' || solo === 'profesionales') {
        const profesionales = await Models.ReservaProfesional.findAll({
            where: { id_negocio: idNegocio, estado: 'A' },
            order: [['id_profesional', 'ASC']],
        });
        console.log(`\nProfesionales (${profesionales.length}):`);
        for (const p of profesionales) {
            if (p.foto_url && !forzar) { console.log(`   = ${p.nombre} — ya tiene`); omitidas++; continue; }
            const buffer = await imagenProfesional(p.nombre);
            const { url, bytes: b } = ImagenService.guardar({
                tipo: 'profesional', idNegocio, idEntidad: p.id_profesional,
                buffer, mimetype: 'image/png',
            });
            await p.update({ foto_url: url, fecha_actualizacion: new Date() });
            console.log(`   + ${p.nombre} (${iniciales(p.nombre)}) — ${(b / 1024).toFixed(0)} KB`);
            generadas++; bytes += b;
        }
    }

    if (solo === 'todo' || solo === 'banner') {
        console.log('\nBanner:');
        if (negocio.banner_url && !forzar) {
            console.log('   = ya tiene');
            omitidas++;
        } else {
            const buffer = await imagenBanner(negocio.nombre);
            const { url, bytes: b } = ImagenService.guardar({
                tipo: 'banner', idNegocio, idEntidad: idNegocio, buffer, mimetype: 'image/png',
            });
            await negocio.update({ banner_url: url });
            console.log(`   + ${(b / 1024).toFixed(0)} KB`);
            generadas++; bytes += b;
        }
    }

    if (solo === 'todo' || solo === 'logo') {
        console.log('\nLogo:');
        if (negocio.logo_url && !forzar) {
            console.log('   = ya tiene');
            omitidas++;
        } else {
            const buffer = await imagenLogo(negocio.nombre);
            const { url, bytes: b } = ImagenService.guardar({
                tipo: 'logo', idNegocio, idEntidad: idNegocio, buffer, mimetype: 'image/png',
            });
            await negocio.update({ logo_url: url });
            console.log(`   + ${(b / 1024).toFixed(0)} KB`);
            generadas++; bytes += b;
        }
    }

    console.log(`\n=== ${generadas} generada(s), ${omitidas} intacta(s), ${(bytes / 1024 / 1024).toFixed(2)} MB en disco ===\n`);
}

sembrar()
    .catch(err => { console.error('\nERROR:', err.message, '\n', err.stack); process.exitCode = 1; })
    .finally(() => Models.sequelize.close());
