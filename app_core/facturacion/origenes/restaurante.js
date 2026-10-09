'use strict';
/**
 * Origen «pedido de restaurante»: lee un pedido y lo devuelve en la forma que entiende
 * `construirFactura`. R4.2 de `docs/plan-fe-restaurante.md`.
 *
 * Lee con SQL y **no importa `pedidoService`** a propósito (ADR-005): es facturación la que
 * sabe del restaurante, nunca al revés, y así no hay ciclo entre los dos.
 */
const Models = require('../../models/conection');
const { MEDIO_PAGO_POR_DEFECTO, UNIDAD_POR_DEFECTO } = require('../constantes');

const sequelize = Models.sequelize;
const SELECT = sequelize.QueryTypes.SELECT;

const SIN_IMPUESTO = { codigo: 'ZZ', tarifa: 0 };

/**
 * @returns {Promise<object|null>} `null` si el pedido no existe.
 */
async function leerPedido(idOrden, { transaction } = {}) {
    const consultar = (sql) => sequelize.query(sql, { replacements: { idOrden }, transaction, type: SELECT });

    const [o] = await consultar(
        `SELECT o.id_orden, o.id_negocio, o.numero_orden, o.total, o.descuento, o.valor_domicilio,
                o.estado, o.estado_pago, o.id_caja, o.id_metodo_pago,
                f.responsable_iva, f.responsable_inc,
                c.impuesto_defecto_codigo, c.impuesto_defecto_tarifa,
                c.impuesto_domicilio_codigo, c.impuesto_domicilio_tarifa
           FROM restaurante.pedid_orden o
           LEFT JOIN general.gener_negocio_fiscal f ON f.id_negocio = o.id_negocio
           LEFT JOIN facturacion.fe_configuracion c ON c.id_negocio = o.id_negocio
          WHERE o.id_orden = :idOrden;`
    );
    if (!o) return null;

    // D7: el impuesto lo decide el contador del cliente. Si el negocio no es responsable de IVA
    // ni de INC, ninguna línea lleva impuesto, diga lo que diga el producto.
    const responsable = Boolean(o.responsable_iva || o.responsable_inc);
    const porDefecto = { codigo: o.impuesto_defecto_codigo ?? 'ZZ', tarifa: Number(o.impuesto_defecto_tarifa) || 0 };
    const impuestoDe = (codigo, tarifa) => {
        if (!responsable) return SIN_IMPUESTO;
        return codigo ? { codigo, tarifa: Number(tarifa) || 0 } : porDefecto;
    };

    const detalle = await consultar(
        `SELECT d.id_detalle, d.cantidad, d.precio_unitario, p.id_producto, p.nombre,
                p.codigo_impuesto, p.tarifa_impuesto, p.unidad_medida_dian, p.codigo_producto
           FROM restaurante.pedid_detalle d
           JOIN restaurante.carta_producto p ON p.id_producto = d.id_producto
          WHERE d.id_orden = :idOrden
          ORDER BY d.id_detalle;`
    );
    const items = detalle.map((d) => {
        const impuesto = impuestoDe(d.codigo_impuesto, d.tarifa_impuesto);
        return {
            codigo: d.codigo_producto || `P${d.id_producto}`,
            descripcion: d.nombre,
            cantidad: Number(d.cantidad),
            // El precio del momento del pedido, no el de la carta de hoy.
            precio_bruto: Number(d.precio_unitario),
            codigo_impuesto: impuesto.codigo,
            tarifa_impuesto: impuesto.tarifa,
            unidad_medida: d.unidad_medida_dian || UNIDAD_POR_DEFECTO,
        };
    });

    const total = Number(o.total) || 0;
    // Multipago: una fila por forma de pago. Sin filas, el pedido se pagó entero con su método.
    let filasPago = await consultar(
        `SELECT p.valor, m.codigo_medio_pago_dian, m.es_cuenta
           FROM restaurante.rest_pago_orden p
           JOIN restaurante.rest_metodo_pago m ON m.id_metodo_pago = p.id_metodo_pago
          WHERE p.id_orden = :idOrden
          ORDER BY p.id_pago;`
    );
    if (filasPago.length === 0) {
        const [m] = await consultar(
            `SELECT m.codigo_medio_pago_dian, m.es_cuenta
               FROM restaurante.pedid_orden o
               JOIN restaurante.rest_metodo_pago m ON m.id_metodo_pago = o.id_metodo_pago
              WHERE o.id_orden = :idOrden;`
        );
        filasPago = [{ valor: total, codigo_medio_pago_dian: m?.codigo_medio_pago_dian, es_cuenta: m?.es_cuenta }];
    }
    const porCodigo = new Map();
    for (const p of filasPago) {
        // D19: lo pagado con la cuenta del cliente (tiquetera, fiado) va como «otro».
        const codigo = p.es_cuenta ? MEDIO_PAGO_POR_DEFECTO : p.codigo_medio_pago_dian || MEDIO_PAGO_POR_DEFECTO;
        porCodigo.set(codigo, (porCodigo.get(codigo) || 0) + Number(p.valor));
    }

    return {
        id_orden: o.id_orden,
        id_negocio: o.id_negocio,
        numero_orden: o.numero_orden,
        total,
        descuento: Number(o.descuento) || 0,
        valor_domicilio: Number(o.valor_domicilio) || 0,
        cobrado: o.estado_pago === 'pagado' || (o.estado === 'CERRADA' && o.id_caja !== null),
        anulado: ['CANCELADA', 'ANULADA'].includes(o.estado),
        items,
        impuestoDomicilio: responsable
            ? { codigo: o.impuesto_domicilio_codigo ?? 'ZZ', tarifa: Number(o.impuesto_domicilio_tarifa) || 0 }
            : SIN_IMPUESTO,
        pagos: [...porCodigo].map(([codigo_dian, valor]) => ({ codigo_dian, valor: Math.round(valor * 100) / 100 })),
    };
}

module.exports = { leerPedido };
