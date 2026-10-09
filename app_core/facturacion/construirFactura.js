'use strict';
/**
 * El cálculo de una factura: recibe números y devuelve números. No lee la base, no lee fechas y
 * no llama a nadie — por eso se puede probar entero sin nada alrededor.
 *
 * La regla que gobierna todo (D6): **el precio de carta ya lleva el impuesto dentro**. A Factus se
 * le manda el precio neto y él vuelve a sumar el impuesto; si el neto se calcula bien, su total es
 * el precio que pagó el cliente. Probado en el sandbox el 2026-09-14.
 */

const r2 = (x) => Math.round(x * 100) / 100;

function fallo(mensaje, code, statusCode) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

/**
 * @param {object} p
 * @param {Array<{codigo, descripcion, cantidad, precio_bruto, codigo_impuesto, tarifa_impuesto, unidad_medida}>} p.items
 *        Las líneas del pedido. precio_bruto es el precio de carta (con impuesto incluido, D6).
 *        codigo_impuesto/tarifa_impuesto YA resueltos (D7 lo resuelve el origen, R4.2).
 * @param {number} p.domicilio        valor del domicilio (0 si no hay)
 * @param {{codigo, tarifa}} p.impuestoDomicilio
 * @param {number} p.descuento        descuento total del pedido (0 si no hay)
 * @param {number} p.totalPedido      pedid_orden.total — lo que el cliente pagó
 * @param {Array<{codigo_dian, valor}>} p.pagos
 * @returns {{ lineas, subtotal, total_impuestos, total, pagos, ajuste_redondeo }}
 */
function construirFactura({ items, domicilio = 0, impuestoDomicilio, descuento = 0, pagos }) {
    const entrada = items.map((it) => ({
        ...it,
        cantidad: Number(it.cantidad),
        precio_bruto: Number(it.precio_bruto),
        tarifa_impuesto: Number(it.tarifa_impuesto) || 0,
        es_domicilio: false,
    }));

    // D8: el domicilio es un servicio aparte del plato, con su propio impuesto.
    if (Number(domicilio) > 0) {
        entrada.push({
            codigo: 'DOMICILIO',
            descripcion: 'Servicio de domicilio',
            cantidad: 1,
            precio_bruto: Number(domicilio),
            codigo_impuesto: impuestoDomicilio?.codigo ?? 'ZZ',
            tarifa_impuesto: Number(impuestoDomicilio?.tarifa) || 0,
            unidad_medida: '94',
            es_domicilio: true,
        });
    }

    // D9: el descuento del pedido se reparte en el precio de cada línea, en proporción.
    const dto = Number(descuento) || 0;
    if (dto > 0) {
        const bruto = entrada.reduce((s, l) => s + l.cantidad * l.precio_bruto, 0);
        if (dto >= bruto) {
            throw fallo('El descuento cubre el pedido entero: no queda nada que facturar.', 'FE_DESCUENTO_TOTAL', 422);
        }
        const factor = 1 - dto / bruto;
        for (const l of entrada) l.precio_bruto = r2(l.precio_bruto * factor);
    }

    const lineas = entrada.map((l, i) => {
        const precio_neto = l.tarifa_impuesto > 0 ? r2(l.precio_bruto / (1 + l.tarifa_impuesto / 100)) : l.precio_bruto;
        const base = r2(l.cantidad * precio_neto);
        const impuesto = r2((base * l.tarifa_impuesto) / 100);
        return { ...l, orden: i + 1, precio_neto, base, impuesto, total: r2(base + impuesto) };
    });

    const subtotal = r2(lineas.reduce((s, l) => s + l.base, 0));
    const total_impuestos = r2(lineas.reduce((s, l) => s + l.impuesto, 0));
    const total = r2(subtotal + total_impuestos);

    // Factus exige que los pagos sumen SU total. Sacar el impuesto del precio de carta deja
    // céntimos sueltos; se absorben en el pago mayor y se deja constancia de cuánto fue.
    const pagosFinales = pagos.map((p) => ({ ...p, valor: Number(p.valor) }));
    const pagado = pagosFinales.reduce((s, p) => s + p.valor, 0);
    const diferencia = r2(total - pagado);
    let ajuste_redondeo = 0;
    if (diferencia !== 0) {
        // Más de un peso por línea ya no es redondeo: es que las cuentas están mal.
        if (Math.abs(diferencia) > lineas.length || pagosFinales.length === 0) {
            throw fallo(
                `Los totales no cuadran: la factura suma ${total.toFixed(2)} y los pagos ${r2(pagado).toFixed(2)}.`,
                'FE_TOTALES_NO_CUADRAN',
                500
            );
        }
        const mayor = pagosFinales.reduce((a, b) => (b.valor > a.valor ? b : a));
        mayor.valor = r2(mayor.valor + diferencia);
        ajuste_redondeo = diferencia;
    }

    return { lineas, subtotal, total_impuestos, total, pagos: pagosFinales, ajuste_redondeo };
}

module.exports = { construirFactura };
