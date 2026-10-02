'use strict';
const Models = require('../../app_core/models/conection');

/**
 * empaqueService — el empaque que lleva un pedido para llevar o a domicilio.
 *
 * El empaque es un producto más de la carta (categoría oculta, p. ej. «pequeño» $500 y «mediano»
 * $1.000) y el personal lo agregaba a mano. Cada producto puede ligarse al suyo
 * (`id_producto_empaque`) con una cantidad POR UNIDAD (`cantidad_empaque`, 1 por defecto: un
 * `familiar` puede llevar 2 medianos). Esto solo calcula las líneas; no crea nada.
 *
 * Lo usa el asistente. El POS sigue siendo manual a propósito: el personal ya agrega el empaque
 * ahí y calcularlo también arriba cobraría doble.
 *
 * El precio sale SIEMPRE del producto-empaque releído, nunca de la conversación.
 */
const TIPOS_CON_EMPAQUE = ['LLEVAR', 'DOMICILIO'];

/**
 * @param {{idNegocio:number, tipoPedido:string, items:Array<{id_producto:number,cantidad:number}>,
 *          transaction?:object}} p
 * @returns {Promise<Array<{id_producto:number, nombre:string, cantidad:number, precio_unitario:number}>>}
 *   Una línea por tipo de empaque, con las cantidades sumadas. Vacío si no aplica.
 */
async function calcular({ idNegocio, tipoPedido, items, transaction = null }) {
    if (!TIPOS_CON_EMPAQUE.includes(tipoPedido)) return [];
    const ids = [...new Set((items || []).map((i) => Number(i.id_producto)).filter((n) => n > 0))];
    if (ids.length === 0) return [];

    const ligados = await Models.sequelize.query(
        `SELECT p.id_producto, p.id_producto_empaque, p.cantidad_empaque
           FROM restaurante.carta_producto p
          WHERE p.id_negocio = :idNegocio AND p.id_producto IN (:ids)
            AND p.id_producto_empaque IS NOT NULL;`,
        { replacements: { idNegocio, ids }, type: Models.sequelize.QueryTypes.SELECT, transaction }
    );
    if (ligados.length === 0) return [];

    const porProducto = new Map(ligados.map((r) => [Number(r.id_producto), r]));
    const cantidades = new Map();
    for (const item of items) {
        const r = porProducto.get(Number(item.id_producto));
        if (!r) continue;
        const n = (Number(item.cantidad) || 1) * (Number(r.cantidad_empaque) || 1);
        cantidades.set(Number(r.id_producto_empaque), (cantidades.get(Number(r.id_producto_empaque)) || 0) + n);
    }

    // El empaque se relee del negocio (su pertenencia y su precio), esté o no visible.
    const empaques = await Models.sequelize.query(
        `SELECT id_producto, nombre, precio FROM restaurante.carta_producto
          WHERE id_negocio = :idNegocio AND id_producto IN (:ids) AND estado = 'A';`,
        {
            replacements: { idNegocio, ids: [...cantidades.keys()] },
            type: Models.sequelize.QueryTypes.SELECT,
            transaction,
        }
    );
    return empaques.map((e) => ({
        id_producto: Number(e.id_producto),
        nombre: e.nombre,
        cantidad: cantidades.get(Number(e.id_producto)),
        precio_unitario: Number(e.precio),
    }));
}

module.exports = { calcular, TIPOS_CON_EMPAQUE };
