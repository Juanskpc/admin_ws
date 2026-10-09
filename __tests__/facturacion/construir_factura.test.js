/**
 * `construirFactura` — el cálculo puro de líneas y totales (R3.2 de `docs/plan-fe-restaurante.md`).
 *
 * No toca la base ni la red. Los números del caso de INC salen de una factura real del sandbox
 * de Factus (2026-09-14): si este test cambia, hay que volver a probar contra el sandbox.
 *
 * Correr con:  npx jest __tests__/facturacion/construir_factura.test.js
 */
'use strict';

const { construirFactura } = require('../../app_core/facturacion/construirFactura');

const SIN = { codigo_impuesto: 'ZZ', tarifa_impuesto: 0, unidad_medida: '94' };
const INC = { codigo_impuesto: '04', tarifa_impuesto: 8, unidad_medida: '94' };
const DOMICILIO_SIN = { codigo: 'ZZ', tarifa: 0 };

const sinImpuesto = () => [
    { codigo: 'HAMB', descripcion: 'Hamburguesa sencilla', cantidad: 2, precio_bruto: 20000, ...SIN },
    { codigo: 'LIMO', descripcion: 'Limonada natural', cantidad: 1, precio_bruto: 6000, ...SIN },
];

describe('construirFactura', () => {
    test('INC 8% con el impuesto dentro del precio de carta', () => {
        const f = construirFactura({
            items: [
                { codigo: 'HAMB', descripcion: 'Hamburguesa sencilla', cantidad: 2, precio_bruto: 22000, ...INC },
                { codigo: 'LIMO', descripcion: 'Limonada natural', cantidad: 1, precio_bruto: 6500, ...INC },
            ],
            domicilio: 0,
            impuestoDomicilio: DOMICILIO_SIN,
            descuento: 0,
            totalPedido: 50500,
            pagos: [{ codigo_dian: '10', valor: 50500 }],
        });
        expect(f.lineas.map((l) => l.precio_neto)).toEqual([20370.37, 6018.52]);
        expect(f.subtotal).toBe(46759.26);
        expect(f.total_impuestos).toBe(3740.74);
        expect(f.total).toBe(50500);
        expect(f.ajuste_redondeo).toBe(0);
        expect(f.lineas.map((l) => l.orden)).toEqual([1, 2]);
    });

    test('sin impuesto', () => {
        const f = construirFactura({
            items: sinImpuesto(),
            impuestoDomicilio: DOMICILIO_SIN,
            totalPedido: 46000,
            pagos: [{ codigo_dian: '10', valor: 46000 }],
        });
        expect(f.total).toBe(46000);
        expect(f.total_impuestos).toBe(0);
    });

    test('el domicilio es una línea aparte, la última', () => {
        const f = construirFactura({
            items: sinImpuesto(),
            domicilio: 5000,
            impuestoDomicilio: DOMICILIO_SIN,
            totalPedido: 51000,
            pagos: [{ codigo_dian: '10', valor: 51000 }],
        });
        expect(f.lineas).toHaveLength(3);
        expect(f.lineas[2].es_domicilio).toBe(true);
        expect(f.lineas[0].es_domicilio).toBe(false);
        expect(f.total).toBe(51000);
    });

    test('el descuento se reparte en el precio de cada línea', () => {
        const f = construirFactura({
            items: sinImpuesto(),
            impuestoDomicilio: DOMICILIO_SIN,
            descuento: 4600,
            totalPedido: 41400,
            pagos: [{ codigo_dian: '10', valor: 41400 }],
        });
        expect(f.lineas.map((l) => l.precio_bruto)).toEqual([18000, 5400]);
        expect(f.total).toBe(41400);
    });

    test('un descuento que cubre todo el pedido no se factura así', () => {
        expect(() =>
            construirFactura({
                items: sinImpuesto(),
                impuestoDomicilio: DOMICILIO_SIN,
                descuento: 46000,
                totalPedido: 0,
                pagos: [],
            })
        ).toThrow(expect.objectContaining({ code: 'FE_DESCUENTO_TOTAL' }));
    });

    test('multipago: los pagos quedan intactos', () => {
        const pagos = [
            { codigo_dian: '10', valor: 30000 },
            { codigo_dian: '47', valor: 16000 },
        ];
        const f = construirFactura({ items: sinImpuesto(), impuestoDomicilio: DOMICILIO_SIN, totalPedido: 46000, pagos });
        expect(f.pagos).toEqual(pagos);
        expect(f.ajuste_redondeo).toBe(0);
    });

    test('los céntimos del redondeo los absorbe el pago mayor', () => {
        const f = construirFactura({
            items: [{ codigo: 'X', descripcion: 'Empanada', cantidad: 3, precio_bruto: 7333, ...INC }],
            impuestoDomicilio: DOMICILIO_SIN,
            totalPedido: 21999,
            pagos: [{ codigo_dian: '10', valor: 21999 }],
        });
        expect(f.lineas[0].precio_neto).toBe(6789.81);
        expect(f.subtotal).toBe(20369.43);
        expect(f.total_impuestos).toBe(1629.55);
        expect(f.total).toBe(21998.98);
        expect(f.pagos[0].valor).toBe(21998.98);
        expect(f.ajuste_redondeo).toBe(-0.02);
    });

    test('un descuadre de verdad no se disfraza de redondeo', () => {
        expect(() =>
            construirFactura({
                items: sinImpuesto(),
                impuestoDomicilio: DOMICILIO_SIN,
                totalPedido: 46000,
                pagos: [{ codigo_dian: '10', valor: 45000 }],
            })
        ).toThrow(expect.objectContaining({ code: 'FE_TOTALES_NO_CUADRAN' }));
    });

    test('no modifica lo que recibe', () => {
        const items = sinImpuesto();
        const pagos = [{ codigo_dian: '10', valor: 41400 }];
        construirFactura({ items, impuestoDomicilio: DOMICILIO_SIN, descuento: 4600, totalPedido: 41400, pagos });
        expect(items[0].precio_bruto).toBe(20000);
        expect(pagos[0].valor).toBe(41400);
    });
});
