/**
 * El código compacto que manda el menú digital.
 *
 * ## Qué es y por qué existe
 *
 * Cuando el cliente arma el carrito en la carta y pulsa «Continuar por WhatsApp», se abre un
 * mensaje con dos mitades:
 *
 *     Hola, quiero pedir:
 *
 *     • 2 × Bandeja paisa
 *     • 1 × Limonada de coco
 *
 *     Total aproximado: $78.000
 *
 *     #P12-4x2,9x1        ← esta línea
 *
 * La parte de arriba la lee una persona. La última línea la lee esto.
 *
 * **Sin el código habría que entender la prosa**, y eso lo hace bien el modelo pero cuesta
 * dinero por turno y puede equivocarse: «dos bandejas» y «2 bandejas» y «un par de bandejas»
 * son la misma cosa para un humano y tres problemas distintos para una expresión regular. Con
 * el código, leer el pedido es determinista, gratis y no falla nunca.
 *
 * Van **ids y no nombres** porque el mensaje viaja dentro de una URL —`wa.me/...?text=`— y los
 * nombres se comen el largo disponible enseguida.
 *
 * ## Lo que este archivo NO decide
 *
 * No valida que los productos existan, ni calcula el total, ni crea nada. Solo convierte texto
 * en `[{id_producto, cantidad}]`. Quién manda sobre los precios y la disponibilidad es
 * `tomar_pedido`, que relee el catálogo — si algo cambió entre que el cliente miró la carta y
 * escribió, gana el catálogo. Lo que el menú mostró es una estimación, no una promesa.
 *
 * ## El id de negocio que viene dentro
 *
 * El código lleva el negocio (`#P12-...`) y **se comprueba**, pero no se usa: el `id_negocio`
 * real lo impone la plataforma desde el Principal (ADR-010). Sirve para detectar un caso muy
 * concreto y muy confuso: alguien que armó el carrito en la carta de un restaurante y lo mandó
 * al WhatsApp de otro. Sin la comprobación, ese pedido se crearía con los ids de productos del
 * negocio equivocado — que o no existen, o son otra cosa.
 */
'use strict';

/**
 * `#P<negocio>-<id>x<cant>[,<id>x<cant>...]`
 *
 * Anclado al final de línea y admitiendo espacios alrededor: el cliente casi siempre escribe
 * algo antes de enviar, y el mensaje llega con saltos de línea de por medio.
 */
const PATRON = /#P(\d+)-((?:\d+x\d+)(?:,\d+x\d+)*)\s*$/im;

/** Tope de seguridad. Un pedido con más líneas que esto no viene de un carrito, viene de un bot. */
const MAX_ITEMS = 30;

/**
 * Extrae el pedido de un mensaje, o `null` si no lo lleva.
 *
 * @param {string} texto
 * @returns {{idNegocio: number, items: Array<{id_producto: number, cantidad: number}>}|null}
 */
function leer(texto) {
    const encontrado = PATRON.exec(String(texto || ''));
    if (!encontrado) return null;

    const idNegocio = Number(encontrado[1]);
    const items = [];

    for (const par of encontrado[2].split(',')) {
        const [id, cantidad] = par.split('x').map(Number);
        if (!Number.isInteger(id) || id <= 0) continue;
        if (!Number.isInteger(cantidad) || cantidad <= 0) continue;
        items.push({ id_producto: id, cantidad });
    }

    if (items.length === 0 || items.length > MAX_ITEMS) return null;

    // Un mismo producto puede aparecer dos veces si el carrito se armó raro. Se suman en vez de
    // crear dos líneas: el cliente pidió tres, no dos y una.
    const sumados = new Map();
    for (const i of items) {
        sumados.set(i.id_producto, (sumados.get(i.id_producto) || 0) + i.cantidad);
    }

    return {
        idNegocio,
        items: [...sumados.entries()].map(([id_producto, cantidad]) => ({ id_producto, cantidad })),
    };
}

/** ¿Este mensaje trae un pedido del menú digital? */
function loTrae(texto) {
    return PATRON.test(String(texto || ''));
}

module.exports = { leer, loTrae, PATRON, MAX_ITEMS };
