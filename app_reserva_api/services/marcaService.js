'use strict';
const Models = require('../../app_core/models/conection');
const ImagenService = require('./imagenService');
const { slugificar, esSlugValido, RESERVADOS } = require('../../app_core/helpers/slug');

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
        attributes: ['id_negocio', 'nombre', 'logo_url', 'banner_url', 'colores', 'id_paleta', 'slug'],
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
        slug: negocio.slug ?? null,
        paletas: paletas.map(p => ({
            id_paleta: p.id_paleta,
            nombre: p.nombre,
            colores: p.colores,
        })),
    };
}

/**
 * Cambia la URL propia del negocio (`<slug>.escalapp.cloud`).
 *
 * A mano, no solo al crearlo: el slug automático de un trial sale del nombre genérico
 * («mi-barberia-8»), y el dueño quiere algo con su marca de verdad («dalex-barberia»). Se valida
 * la forma aquí (minúsculas, dígitos, guiones, sin uno al borde) y la unicidad la vuelve a
 * comprobar el índice de la base — la carrera entre dos peticiones la gana él, no esta función.
 */
async function actualizarSlug({ idNegocio, slug }) {
    const negocio = await getNegocio(idNegocio);
    const limpio = slugificar(String(slug || '').toLowerCase());

    if (!esSlugValido(limpio)) {
        throw error('La URL debe tener entre 2 y 50 caracteres: minúsculas, números y guiones, sin empezar ni terminar en guion.');
    }
    if (RESERVADOS.has(limpio)) {
        throw error('Esa URL está reservada. Elige otra.');
    }
    if (limpio === negocio.slug) return { slug: limpio };

    const choque = await Models.GenerNegocio.findOne({
        where: Models.sequelize.and(
            Models.sequelize.where(Models.sequelize.fn('lower', Models.sequelize.col('slug')), limpio),
            { id_negocio: { [Models.Sequelize.Op.ne]: idNegocio } },
        ),
        attributes: ['id_negocio'],
    });
    if (choque) throw error('Esa URL ya la tiene otro negocio. Elige otra.', 409);

    try {
        await Models.sequelize.transaction((t) => negocio.update({ slug: limpio }, { transaction: t }));
    } catch (err) {
        // El índice único es la autoridad final frente a una carrera entre dos peticiones con
        // el mismo slug a la vez; la comprobación de arriba es solo para el caso normal, que da
        // un mensaje más claro que un 23505 crudo.
        if (err?.original?.code === '23505') throw error('Esa URL ya la tiene otro negocio. Elige otra.', 409);
        throw err;
    }
    return { slug: limpio };
}

/** Guarda colores propios. `id_paleta` queda a null: a partir de aquí manda lo elegido a mano. */
async function guardarColores({ idNegocio, primario, acento }) {
    const negocio = await getNegocio(idNegocio);
    const colores = {
        primario: normalizarHex(primario, 'primario'),
        acento: normalizarHex(acento, 'acento'),
    };
    await Models.sequelize.transaction((t) => negocio.update({ colores, id_paleta: null }, { transaction: t }));
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
    await Models.sequelize.transaction((t) => negocio.update({ colores, id_paleta: paleta.id_paleta }, { transaction: t }));
    return { colores, id_paleta: paleta.id_paleta, nombre: paleta.nombre };
}

/** Vuelve a la identidad por defecto de EscalApp. */
async function restablecerColores(idNegocio) {
    const negocio = await getNegocio(idNegocio);
    await Models.sequelize.transaction((t) => negocio.update({ colores: null, id_paleta: null }, { transaction: t }));
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
    await Models.sequelize.transaction((t) => negocio.update({ logo_url: url }, { transaction: t }));
    return { logo_url: url, bytes };
}

/** Quita el logo: borra el archivo y limpia la columna. */
async function eliminarLogo(idNegocio) {
    const negocio = await getNegocio(idNegocio);
    ImagenService.eliminar({ tipo: 'logo', idNegocio, idEntidad: idNegocio });
    await Models.sequelize.transaction((t) => negocio.update({ logo_url: null }, { transaction: t }));
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
    await Models.sequelize.transaction((t) => negocio.update({ banner_url: url }, { transaction: t }));
    return { banner_url: url, bytes };
}

async function eliminarBanner(idNegocio) {
    const negocio = await getNegocio(idNegocio);
    ImagenService.eliminar({ tipo: 'banner', idNegocio, idEntidad: idNegocio });
    await Models.sequelize.transaction((t) => negocio.update({ banner_url: null }, { transaction: t }));
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
    actualizarSlug,
};
