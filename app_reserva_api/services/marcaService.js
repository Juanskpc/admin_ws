'use strict';
const Models = require('../../app_core/models/conection');
const ImagenService = require('./imagenService');

/**
 * Identidad visual del negocio: logo y colores.
 *
 * ## Un solo sitio del que leer
 *
 * `gener_negocio` tiene `id_paleta` (paleta predefinida) y ahora `colores` (colores propios).
 * Podrían competir, así que no compiten: elegir una paleta **copia** sus valores a `colores`.
 * El resto del sistema —sesión, tema, informes— lee siempre `colores` y nunca tiene que
 * resolver cuál de los dos gana.
 *
 * ## Qué se guarda y qué se deriva
 *
 * Se guardan **dos** colores: `primario` y `acento`. Todo lo demás (el tono del hover, el color
 * del texto encima del botón, los fondos suaves) lo deriva el tema en el cliente con `color-mix`
 * sobre esos dos. Guardar los derivados los dejaría desincronizados en cuanto alguien cambie el
 * primario, y es el error que hace que una paleta «casi» funcione.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

function error(mensaje, statusCode = 422) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    return e;
}

function normalizarHex(valor, campo) {
    const v = String(valor || '').trim();
    const conNumeral = v.startsWith('#') ? v : `#${v}`;
    if (!HEX.test(conNumeral)) {
        throw error(`El color ${campo} debe ser un hexadecimal de 6 dígitos (ej. #312E81).`);
    }
    return conNumeral.toUpperCase();
}

async function getNegocio(idNegocio) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'nombre', 'logo_url', 'banner_url', 'colores', 'id_paleta'],
    });
    if (!negocio) throw error('Negocio no encontrado.', 404);
    return negocio;
}

/** Identidad actual + catálogo de paletas para elegir. */
async function getMarca(idNegocio) {
    const [negocio, paletas] = await Promise.all([
        getNegocio(idNegocio),
        Models.GenerPaletaColor.findAll({
            attributes: ['id_paleta', 'nombre', 'colores'],
            order: [['id_paleta', 'ASC']],
        }),
    ]);

    return {
        id_negocio: negocio.id_negocio,
        nombre: negocio.nombre,
        logo_url: negocio.logo_url,
        banner_url: negocio.banner_url,
        colores: negocio.colores ?? null,
        id_paleta: negocio.id_paleta ?? null,
        paletas: paletas.map(p => ({
            id_paleta: p.id_paleta,
            nombre: p.nombre,
            colores: p.colores,
        })),
    };
}

/** Guarda colores propios. `id_paleta` queda a null: a partir de aquí manda lo elegido a mano. */
async function guardarColores({ idNegocio, primario, acento }) {
    const negocio = await getNegocio(idNegocio);
    const colores = {
        primario: normalizarHex(primario, 'primario'),
        acento: normalizarHex(acento, 'acento'),
    };
    await negocio.update({ colores, id_paleta: null });
    return colores;
}

/** Aplica una paleta predefinida copiando sus colores. */
async function aplicarPaleta({ idNegocio, idPaleta }) {
    const negocio = await getNegocio(idNegocio);
    const paleta = await Models.GenerPaletaColor.findByPk(idPaleta, {
        attributes: ['id_paleta', 'nombre', 'colores'],
    });
    if (!paleta) throw error('Paleta no encontrada.', 404);

    const c = paleta.colores || {};
    const colores = {
        primario: normalizarHex(c.primario ?? c.primary, 'primario'),
        acento: normalizarHex(c.acento ?? c.accent ?? c.primario ?? c.primary, 'acento'),
    };
    await negocio.update({ colores, id_paleta: paleta.id_paleta });
    return { colores, id_paleta: paleta.id_paleta, nombre: paleta.nombre };
}

/** Vuelve a la identidad por defecto de EscalApp. */
async function restablecerColores(idNegocio) {
    const negocio = await getNegocio(idNegocio);
    await negocio.update({ colores: null, id_paleta: null });
    return null;
}

/** Guarda el logo subido y actualiza la ruta. La imagen anterior se sobrescribe. */
async function guardarLogo({ idNegocio, buffer, mimetype }) {
    const negocio = await getNegocio(idNegocio);
    const { url, bytes } = ImagenService.guardar({
        tipo: 'logo',
        idNegocio,
        idEntidad: idNegocio,   // el logo es del negocio: su id es el del propio negocio
        buffer,
        mimetype,
    });
    await negocio.update({ logo_url: url });
    return { logo_url: url, bytes };
}

/** Quita el logo: borra el archivo y limpia la columna. */
async function eliminarLogo(idNegocio) {
    const negocio = await getNegocio(idNegocio);
    ImagenService.eliminar({ tipo: 'logo', idNegocio, idEntidad: idNegocio });
    await negocio.update({ logo_url: null });
    return true;
}

/**
 * Banner de la cabecera del portal público.
 *
 * Es la foto ancha del local o del equipo. Va aparte del logo porque cumple otra función: el
 * logo identifica, el banner ambienta. Se recorta a 16:5 en el navegador —la proporción de la
 * cabecera— para que ninguna suba deforme el encabezado ni obligue a recortarlo por CSS.
 */
async function guardarBanner({ idNegocio, buffer, mimetype }) {
    const negocio = await getNegocio(idNegocio);
    const { url, bytes } = ImagenService.guardar({
        tipo: 'banner', idNegocio, idEntidad: idNegocio, buffer, mimetype,
    });
    await negocio.update({ banner_url: url });
    return { banner_url: url, bytes };
}

async function eliminarBanner(idNegocio) {
    const negocio = await getNegocio(idNegocio);
    ImagenService.eliminar({ tipo: 'banner', idNegocio, idEntidad: idNegocio });
    await negocio.update({ banner_url: null });
    return true;
}

module.exports = {
    getMarca,
    guardarColores,
    aplicarPaleta,
    restablecerColores,
    guardarLogo,
    eliminarLogo,
    guardarBanner,
    eliminarBanner,
};
