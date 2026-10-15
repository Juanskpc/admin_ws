'use strict';
/**
 * Las adiciones (toppings, extras…) que el cliente le puso a un plato en la carta virtual.
 *
 * El carrito escribe por línea `4x2-a31.31.40`: ids de producto-adición separados por punto, y
 * un id repetido es una unidad más POR PLATO (`31.31` = doble). `codigoPedido.js` las lee como
 * `[{id_producto, cantidad}]`, el flujo las pasa a `tomar_pedido` como texto (`con: "31.31.40"`,
 * porque el motor de argumentos no anida listas) y `ejecutar` se las da a `crearOrden`, que es
 * quien de verdad las valida y les pone precio (`adicionService.resolverItems`): una adición que
 * el plato no ofrece, agotada o de otro negocio no entra.
 *
 * Aquí no se decide nada, solo se traduce y se ponen nombres para la confirmación.
 */
const Models = require('../../../app_core/models/conection');

/** Tope de ids por línea: más que esto no lo arma una persona. */
const MAX_POR_LINEA = 30;

/** `"31.31.40"` → `[{id_producto: 31, cantidad: 2}, {id_producto: 40, cantidad: 1}]`. */
function leerCon(texto) {
    const porId = new Map();
    let vistos = 0;
    for (const parte of String(texto ?? '').split('.')) {
        if (!/^\d{1,9}$/.test(parte)) continue;
        const n = Number(parte);
        if (n <= 0) continue;
        porId.set(n, (porId.get(n) || 0) + 1);
        if (++vistos >= MAX_POR_LINEA) break;
    }
    return [...porId.entries()].map(([id_producto, cantidad]) => ({ id_producto, cantidad }));
}

/** `[{id_producto: 40, cantidad: 1}, {id_producto: 31, cantidad: 2}]` → `"31.31.40"`. */
function escribirCon(adiciones) {
    const ids = [];
    for (const a of adiciones || []) {
        const id = Number(a?.id_producto);
        const cantidad = Number(a?.cantidad) || 1;
        if (!Number.isInteger(id) || id <= 0) continue;
        for (let k = 0; k < cantidad; k += 1) ids.push(id);
    }
    return ids.sort((x, y) => x - y).join('.');
}

/**
 * Nombre y precio de las adiciones de cada línea, para enseñarlas ANTES del «sí». No valida que el
 * plato las ofrezca (eso lo hace `crearOrden` al ejecutar): si una no existe, sale sin nombre y la
 * confirmación la omite.
 *
 * @returns {Promise<Array<Array<{id_producto:number, nombre:string, cantidad:number, precio:number}>>>}
 */
async function describir({ idNegocio, lineas, transaction = null }) {
    const ids = [...new Set(lineas.flat().map((a) => a.id_producto))];
    if (ids.length === 0) return lineas.map(() => []);
    const productos = await Models.CartaProducto.findAll({
        where: { id_negocio: idNegocio, id_producto: ids, estado: 'A', es_adicion: true },
        attributes: ['id_producto', 'nombre', 'precio'],
        transaction,
    });
    const porId = new Map(productos.map((p) => [Number(p.id_producto), p]));
    return lineas.map((adiciones) =>
        adiciones
            .filter((a) => porId.has(a.id_producto))
            .map((a) => ({
                id_producto: a.id_producto,
                nombre: porId.get(a.id_producto).nombre,
                cantidad: a.cantidad,
                precio: Number(porId.get(a.id_producto).precio),
            }))
    );
}

/** `[{nombre:'Queso', cantidad:2}, {nombre:'Tocineta', cantidad:1}]` → `"+ 2 Queso, + Tocineta"`. */
function enTexto(adiciones) {
    return (adiciones || [])
        .map((a) => (a.cantidad > 1 ? `+ ${a.cantidad} ${a.nombre}` : `+ ${a.nombre}`))
        .join(', ');
}

module.exports = { MAX_POR_LINEA, leerCon, escribirCon, describir, enTexto };
