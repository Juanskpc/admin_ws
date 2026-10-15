'use strict';
/**
 * adicionService — adiciones, toppings, extras… ligados a un producto.
 *
 * Una adición es un PRODUCTO de la carta con `es_adicion = true` (precio, agotado, receta e
 * impuestos le vienen gratis), y `carta_producto_adicion` dice qué productos la ofrecen. En el
 * pedido es una línea normal de `pedid_detalle` que apunta a la del plato (`id_detalle_padre`).
 * Ver `migrations/migrate_restaurante_adiciones.js`.
 *
 * Reglas que viven aquí y en ningún otro sitio:
 *  - Todo es opt-in (`gener_negocio.permite_adiciones`). Apagado, un pedido con adiciones se
 *    rechaza (`ADICIONES_NO_HABILITADAS`) y la carta no las ofrece.
 *  - El precio de una adición sale SIEMPRE de la base, nunca del navegador ni de la conversación.
 *  - Solo vale una adición que el producto ofrece (`carta_producto_adicion` activa), que es de
 *    este negocio, está activa y no está agotada.
 *  - La `cantidad` que llega es POR UNIDAD del plato (2 hamburguesas «con doble queso» = queso
 *    ×2 por unidad); la línea guardada lleva la total (×4).
 */
const Models = require('../../app_core/models/conection');
const TerminosAdicion = require('../../app_core/helpers/terminosAdicion');

/** Más que esto de una misma adición por unidad no lo pide una persona. */
const MAX_POR_UNIDAD = 10;
/** Y más adiciones distintas que esto en un plato, tampoco. */
const MAX_DISTINTAS = 30;

function fallo(mensaje, code, statusCode = 422) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

async function negocioPermiteAdiciones(idNegocio, { transaction = null } = {}) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'permite_adiciones'],
        transaction,
    });
    return negocio?.permite_adiciones === true;
}

/**
 * `[{id_producto, cantidad}]` o `[id, id, …]` → `[{id_producto, cantidad}]` sumando repetidos.
 * Lo que no es un id entero positivo se descarta.
 */
function normalizarPedidas(adiciones) {
    if (!Array.isArray(adiciones)) return [];
    const porId = new Map();
    for (const a of adiciones) {
        const id = Number(typeof a === 'object' && a !== null ? a.id_producto ?? a.id_adicion : a);
        if (!Number.isInteger(id) || id <= 0) continue;
        const bruta = typeof a === 'object' && a !== null && a.cantidad !== undefined ? Number(a.cantidad) : 1;
        const cantidad = Number.isInteger(bruta) && bruta > 0 ? bruta : 1;
        porId.set(id, (porId.get(id) || 0) + cantidad);
    }
    return [...porId.entries()].map(([id_producto, cantidad]) => ({ id_producto, cantidad }));
}

/**
 * Valida y pone precio a las adiciones de cada ítem de un pedido.
 *
 * @param {{idNegocio:number, items:Array, transaction?:object}} p
 * @returns {Promise<Array>} los mismos ítems; los que traen adiciones salen con
 *   `adiciones: [{id_producto, nombre, cantidad (por unidad), precio_unitario}]`.
 * @throws ADICIONES_NO_HABILITADAS (403) · ADICION_INVALIDA (422) · ADICION_AGOTADA (409)
 */
async function resolverItems({ idNegocio, items, transaction = null }) {
    const lista = Array.isArray(items) ? items : [];
    const pedidas = lista.map((i) => normalizarPedidas(i?.adiciones));
    if (pedidas.every((p) => p.length === 0)) {
        return lista.map((i) => (i && i.adiciones !== undefined ? { ...i, adiciones: [] } : i));
    }

    if (!(await negocioPermiteAdiciones(idNegocio, { transaction }))) {
        throw fallo(
            'Este negocio no tiene activadas las adiciones. Actívalas en Configuración.',
            'ADICIONES_NO_HABILITADAS',
            403
        );
    }

    const idsPlatos = [...new Set(lista.map((i) => Number(i?.id_producto)).filter((n) => n > 0))];
    const idsAdiciones = [...new Set(pedidas.flat().map((a) => a.id_producto))];

    const ligadas = await Models.sequelize.query(
        `SELECT pa.id_producto, pa.id_adicion
           FROM restaurante.carta_producto_adicion pa
           JOIN restaurante.carta_producto p ON p.id_producto = pa.id_producto
          WHERE pa.estado = 'A' AND p.id_negocio = :idNegocio
            AND pa.id_producto IN (:idsPlatos) AND pa.id_adicion IN (:idsAdiciones);`,
        {
            replacements: { idNegocio, idsPlatos, idsAdiciones },
            type: Models.sequelize.QueryTypes.SELECT,
            transaction,
        }
    );
    const ofrece = new Set(ligadas.map((l) => `${l.id_producto}:${l.id_adicion}`));

    const productos = await Models.CartaProducto.findAll({
        where: { id_negocio: idNegocio, id_producto: idsAdiciones, estado: 'A', es_adicion: true },
        attributes: ['id_producto', 'nombre', 'precio', 'disponible'],
        transaction,
    });
    const porId = new Map(productos.map((p) => [Number(p.id_producto), p]));

    return lista.map((item, k) => {
        if (pedidas[k].length === 0) return { ...item, adiciones: [] };
        if (pedidas[k].length > MAX_DISTINTAS) {
            throw fallo('Demasiadas adiciones en un mismo producto.', 'ADICION_INVALIDA');
        }
        const adiciones = pedidas[k].map(({ id_producto, cantidad }) => {
            const p = porId.get(id_producto);
            if (!p || !ofrece.has(`${Number(item.id_producto)}:${id_producto}`)) {
                throw fallo('Una de las adiciones elegidas no está disponible para ese producto.', 'ADICION_INVALIDA');
            }
            if (p.disponible === false) {
                throw fallo(`«${p.nombre}» está agotado por hoy.`, 'ADICION_AGOTADA', 409);
            }
            if (cantidad > MAX_POR_UNIDAD) {
                throw fallo(`Máximo ${MAX_POR_UNIDAD} de «${p.nombre}» por producto.`, 'ADICION_INVALIDA');
            }
            return {
                id_producto,
                nombre: p.nombre,
                cantidad,
                precio_unitario: Number(p.precio),
            };
        });
        return { ...item, adiciones };
    });
}

/** Ítems + sus adiciones como ítems sueltos con la cantidad TOTAL: lo que consume inventario. */
function aplanar(items) {
    const salida = [];
    for (const item of items || []) {
        salida.push(item);
        const unidades = Number(item.cantidad || 1);
        for (const a of item.adiciones || []) {
            salida.push({ id_producto: a.id_producto, cantidad: a.cantidad * unidades });
        }
    }
    return salida;
}

/** Subtotal de los ítems contando sus adiciones. */
function subtotalItems(items) {
    let subtotal = 0;
    for (const item of items || []) {
        const unidades = Number(item.cantidad || 1);
        subtotal += Number(item.precio_unitario) * unidades;
        for (const a of item.adiciones || []) subtotal += a.precio_unitario * a.cantidad * unidades;
    }
    return subtotal;
}

/**
 * Deja las adiciones que ofrece un producto exactamente en `ids` (orden incluido). Lo que ya no
 * viene se desactiva, no se borra. Cada id tiene que ser una adición activa de este negocio.
 */
async function sincronizarDeProducto({ idNegocio, idProducto, ids, transaction }) {
    const limpios = [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter(
        (n) => Number.isInteger(n) && n > 0 && n !== Number(idProducto)
    );

    if (limpios.length > 0) {
        const validas = await Models.CartaProducto.findAll({
            where: { id_negocio: idNegocio, id_producto: limpios, estado: 'A', es_adicion: true },
            attributes: ['id_producto'],
            transaction,
        });
        if (validas.length !== limpios.length) {
            throw fallo('Una de las adiciones elegidas no existe en este negocio.', 'ADICION_INVALIDA', 400);
        }
    }

    const existentes = await Models.CartaProductoAdicion.findAll({
        where: { id_producto: idProducto },
        transaction,
    });
    const porAdicion = new Map(existentes.map((e) => [Number(e.id_adicion), e]));

    for (const [orden, idAdicion] of limpios.entries()) {
        const fila = porAdicion.get(idAdicion);
        if (fila) {
            if (fila.estado !== 'A' || Number(fila.orden) !== orden) {
                await fila.update({ estado: 'A', orden }, { transaction });
            }
        } else {
            await Models.CartaProductoAdicion.create(
                { id_producto: idProducto, id_adicion: idAdicion, orden, estado: 'A' },
                { transaction }
            );
        }
    }
    const quedan = new Set(limpios);
    for (const fila of existentes) {
        if (fila.estado === 'A' && !quedan.has(Number(fila.id_adicion))) {
            await fila.update({ estado: 'I' }, { transaction });
        }
    }
}

/** Un producto que deja de ser adición deja de ofrecerse en los platos que la tenían. */
async function retirarDeLosPlatos(idAdicion, { transaction }) {
    await Models.CartaProductoAdicion.update(
        { estado: 'I' },
        { where: { id_adicion: idAdicion, estado: 'A' }, transaction }
    );
}

/**
 * La categoría donde se crean las adiciones cuando no se elige una: la que se llama como el
 * término del negocio en plural («Toppings»), o se crea oculta de la carta (las adiciones no se
 * venden solas, así que la categoría no tiene nada que enseñar).
 */
async function categoriaPorDefecto(idNegocio, { transaction }) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'termino_adiciones'],
        transaction,
    });
    const nombre = TerminosAdicion.termino(negocio?.termino_adiciones).plural;
    const [existente] = await Models.sequelize.query(
        `SELECT id_categoria FROM restaurante.carta_categoria
          WHERE id_negocio = :idNegocio AND estado = 'A' AND lower(nombre) = lower(:nombre)
          ORDER BY id_categoria LIMIT 1;`,
        { replacements: { idNegocio, nombre }, type: Models.sequelize.QueryTypes.SELECT, transaction }
    );
    if (existente) return Number(existente.id_categoria);

    const orden = ((await Models.CartaCategoria.max('orden', { where: { id_negocio: idNegocio }, transaction })) || 0) + 1;
    const categoria = await Models.CartaCategoria.create(
        {
            id_negocio: idNegocio,
            nombre,
            descripcion: `Lo que se le puede agregar a un producto`,
            icono: '➕',
            orden,
            visible: false,
            estado: 'A',
        },
        { transaction }
    );
    return Number(categoria.id_categoria);
}

/**
 * Carta pública: con el negocio en `permite_adiciones`, las adiciones salen de las categorías
 * (no se venden solas) y cada producto lleva las suyas. Una categoría que solo tenía adiciones
 * desaparece. Apagado, la carta queda exactamente como antes.
 *
 * De cada adición sale solo lo que un cliente necesita: id, nombre, descripción, precio y si está
 * disponible. Ni receta ni stock.
 */
async function adjuntarACartaPublica(idNegocio, categorias) {
    if (!(await negocioPermiteAdiciones(idNegocio))) return categorias;

    // Una categoría vacía de origen se deja como estaba; solo se quita la que se vació aquí.
    const visibles = categorias.filter((c) => {
        const antes = (c.productos || []).length;
        c.productos = (c.productos || []).filter((p) => !p.es_adicion);
        return antes === 0 || c.productos.length > 0;
    });
    const productos = visibles.flatMap((c) => c.productos || []);
    if (productos.length > 0) {
        const filas = await Models.sequelize.query(
            `SELECT pa.id_producto, a.id_producto AS id_adicion, a.nombre, a.descripcion, a.precio,
                    a.disponible
               FROM restaurante.carta_producto_adicion pa
               JOIN restaurante.carta_producto a ON a.id_producto = pa.id_adicion
              WHERE pa.estado = 'A' AND pa.id_producto IN (:ids)
                AND a.id_negocio = :idNegocio AND a.estado = 'A' AND a.es_adicion = true
              ORDER BY pa.orden, a.nombre;`,
            {
                replacements: { idNegocio, ids: productos.map((p) => p.id_producto) },
                type: Models.sequelize.QueryTypes.SELECT,
            }
        );
        const porProducto = new Map();
        for (const f of filas) {
            const lista = porProducto.get(Number(f.id_producto)) ?? [];
            lista.push({
                id_producto: Number(f.id_adicion),
                nombre: f.nombre,
                descripcion: f.descripcion,
                precio: Number(f.precio),
                disponible: f.disponible !== false,
            });
            porProducto.set(Number(f.id_producto), lista);
        }
        for (const p of productos) p.adiciones = porProducto.get(Number(p.id_producto)) ?? [];
    }
    return visibles;
}

module.exports = {
    MAX_POR_UNIDAD,
    negocioPermiteAdiciones,
    normalizarPedidas,
    resolverItems,
    aplanar,
    subtotalItems,
    sincronizarDeProducto,
    retirarDeLosPlatos,
    categoriaPorDefecto,
    adjuntarACartaPublica,
};
