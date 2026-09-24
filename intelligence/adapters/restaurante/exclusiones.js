'use strict';
/**
 * Los ingredientes que el cliente quitó de un plato desde la carta virtual («sin cebolla»).
 *
 * ## Qué es y de dónde viene
 *
 * El carrito escribe por línea `4x1-r12.15` (ids de ingrediente separados por punto) y
 * `codigoPedido.js` los lee. Aquí se convierten en algo en lo que el servidor sí puede confiar.
 * Ver `docs/asistente-restaurante.md`, «Ingredientes que se quitan».
 *
 * ## Regla: nunca se guarda un id que no sea removible de ESE producto en ESE negocio
 *
 * Un id que llega en un mensaje es una sugerencia del cliente, editable. Válido = existe en la
 * receta del producto (`carta_producto_ingred`, estado `A`), está marcado `es_removible`, y el
 * ingrediente es de este negocio y está activo. Cualquier otro se descarta.
 *
 * Descartar tiene dos momentos distintos, y por eso hay dos funciones:
 *  - `resolver` **no lanza**: separa lo válido de lo descartado, para poder decírselo al cliente
 *    en la confirmación («no pudimos quitar: X») ANTES del «sí».
 *  - `tomar_pedido.ejecutar` es estricto: si algo de lo confirmado ya no es válido —una ventana
 *    de segundos— lanza `EXCLUSION_INVALIDA`. Nunca se guarda a medias.
 */
const Models = require('../../../app_core/models/conection');

/** Tope por línea: más que esto no viene de una persona sino de un mensaje editado. */
const MAX_POR_LINEA = 12;

/** `"12.15"` → `[12, 15]` (enteros positivos, sin repetidos, orden estable). */
function leerSin(texto) {
    const ids = [];
    for (const parte of String(texto ?? '').split('.')) {
        if (!/^\d{1,9}$/.test(parte)) continue;
        const n = Number(parte);
        if (n > 0 && !ids.includes(n)) ids.push(n);
        if (ids.length >= MAX_POR_LINEA) break;
    }
    return ids;
}

/** `[15, 12]` → `"12.15"` (ordenado: la misma elección siempre da el mismo texto). */
function escribirSin(ids) {
    return [...new Set(ids || [])].sort((a, b) => a - b).join('.');
}

/**
 * Separa, por línea, lo que se puede quitar de lo que no.
 *
 * @param {{idNegocio:number, lineas:Array<{id_producto:number, ids:number[]}>, transaction?:object}} p
 * @returns {Promise<Array<{validas:Array<{id_ingrediente:number,nombre:string}>, descartadas:Array<{id_ingrediente:number,nombre:string|null}>}>>}
 *          un elemento por línea, en el mismo orden.
 */
async function resolver({ idNegocio, lineas, transaction = null }) {
    const idsProducto = [...new Set(lineas.filter((l) => l.ids.length).map((l) => Number(l.id_producto)))];
    if (idsProducto.length === 0) return lineas.map(() => ({ validas: [], descartadas: [] }));

    const filas = await Models.sequelize.query(
        `SELECT pi.id_producto, pi.id_ingrediente, pi.es_removible, i.nombre
           FROM restaurante.carta_producto_ingred pi
           JOIN restaurante.carta_producto p
             ON p.id_producto = pi.id_producto AND p.id_negocio = :n
           JOIN restaurante.carta_ingrediente i
             ON i.id_ingrediente = pi.id_ingrediente AND i.id_negocio = :n AND i.estado = 'A'
          WHERE pi.id_producto IN (:productos) AND pi.estado = 'A';`,
        {
            replacements: { n: idNegocio, productos: idsProducto },
            type: Models.sequelize.QueryTypes.SELECT,
            transaction,
        }
    );
    const receta = new Map(); // "producto:ingrediente" → fila
    for (const f of filas) receta.set(`${f.id_producto}:${f.id_ingrediente}`, f);

    const resultado = lineas.map((l) => {
        const validas = [];
        const descartadas = [];
        for (const id of l.ids) {
            const f = receta.get(`${Number(l.id_producto)}:${id}`);
            if (f && f.es_removible) validas.push({ id_ingrediente: id, nombre: f.nombre });
            else descartadas.push({ id_ingrediente: id, nombre: f ? f.nombre : null });
        }
        return { validas, descartadas };
    });

    // Nombre de lo descartado que no está en la receta: se busca aparte, solo para poder decirlo.
    const sinNombre = [
        ...new Set(resultado.flatMap((r) => r.descartadas).filter((d) => !d.nombre).map((d) => d.id_ingrediente)),
    ];
    if (sinNombre.length) {
        const nombres = await Models.sequelize.query(
            `SELECT id_ingrediente, nombre FROM restaurante.carta_ingrediente
              WHERE id_negocio = :n AND id_ingrediente IN (:ids);`,
            {
                replacements: { n: idNegocio, ids: sinNombre },
                type: Models.sequelize.QueryTypes.SELECT,
                transaction,
            }
        );
        const porId = new Map(nombres.map((x) => [x.id_ingrediente, x.nombre]));
        for (const r of resultado) {
            for (const d of r.descartadas) if (!d.nombre) d.nombre = porId.get(d.id_ingrediente) ?? null;
        }
    }
    return resultado;
}

/** «cebolla, tomate y 1 más» → lista corta y legible de nombres (los sin nombre cuentan como uno). */
function nombresLegibles(descartadas) {
    const nombres = [...new Set(descartadas.map((d) => d.nombre).filter(Boolean))];
    const anonimos = descartadas.filter((d) => !d.nombre).length;
    return [...nombres, ...(anonimos ? [anonimos === 1 ? 'un ingrediente' : `${anonimos} ingredientes`] : [])].join(', ');
}

module.exports = { leerSin, escribirSin, resolver, nombresLegibles, MAX_POR_LINEA };
