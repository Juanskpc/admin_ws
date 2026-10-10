/**
 * Cartera — los cálculos que deciden cuánto se fue en comisiones y en 4x1000. Sin base.
 *
 * Ejecutar: npx jest __tests__/cartera/calculos.test.js
 */
'use strict';

jest.mock('../../app_core/models/conection', () => ({ sequelize: { QueryTypes: {} } }));
jest.mock('../../app_core/dao/carteraDao', () => ({}));
jest.mock('../../app_core/helpers/auditHelper', () => ({ registrarEvento: jest.fn() }));
jest.mock('../../app_admin_api/services/trmService', () => ({ trmVigente: jest.fn() }));

const C = require('../../app_admin_api/services/carteraService');

const WOMPI = { porcentaje: 2.65, fijo: 700, fijo_moneda: 'COP', iva_pct: 19, retencion_pct: 0 };
const DLOCAL = { porcentaje: 1.99, fijo: 0.2, fijo_moneda: 'USD', iva_pct: 0, retencion_pct: 0 };

describe('estimarComision', () => {
    test('Wompi sobre el Plan Básico: 2,65% + $700 + IVA (cobro-mensualidades.md §2.1)', () => {
        const e = C.estimarComision({ montoCop: 27999, tarifa: WOMPI });
        expect(e.comision).toBe(1442); // 742 + 700
        expect(e.iva_comision).toBe(274);
        expect(e.comision + e.iva_comision).toBe(1716); // la cifra del documento
        expect(e.completa).toBe(true);
    });

    test('dLocal con fijo en USD usa la TRM', () => {
        const e = C.estimarComision({ montoCop: 27999, tarifa: DLOCAL, trm: 4000 });
        expect(e.comision).toBe(1357); // 557 + 800
        expect(e.iva_comision).toBe(0);
    });

    test('sin TRM, solo la parte porcentual y lo dice', () => {
        const e = C.estimarComision({ montoCop: 27999, tarifa: DLOCAL, trm: null });
        expect(e.comision).toBe(557);
        expect(e.completa).toBe(false);
    });

    test('sin tarifa, cero', () => {
        expect(C.estimarComision({ montoCop: 1000, tarifa: null }).comision).toBe(0);
    });
});

describe('calcularGmf', () => {
    test('una salida de una cuenta bancaria paga 4 por mil del débito completo', () => {
        expect(C.calcularGmf({ tipo: 'egreso', montoCop: 1000000, aplicaGmf: true })).toBe(4000);
        expect(
            C.calcularGmf({ tipo: 'egreso', montoCop: 100000, comision: 5000, aplicaGmf: true })
        ).toBe(420);
    });

    test('un traslado también es una salida', () => {
        expect(C.calcularGmf({ tipo: 'transferencia', montoCop: 500000, aplicaGmf: true })).toBe(2000);
    });

    test('los ingresos, las cuentas sin GMF y lo marcado exento no pagan', () => {
        expect(C.calcularGmf({ tipo: 'ingreso', montoCop: 1000000, aplicaGmf: true })).toBe(0);
        expect(C.calcularGmf({ tipo: 'egreso', montoCop: 1000000, aplicaGmf: false })).toBe(0);
        expect(C.calcularGmf({ tipo: 'egreso', montoCop: 1000000, aplicaGmf: true, exento: true })).toBe(0);
    });
});

describe('efectoEnCuentas', () => {
    test('ingreso: llega el monto menos comisión, IVA de la comisión y retención', () => {
        const [e] = C.efectoEnCuentas({
            tipo: 'ingreso', id_cuenta: 1, monto_cop: 59999, comision: 2290, iva_comision: 435,
            retencion: 2400, gmf: 0,
        });
        expect(e).toEqual({ id_cuenta: 1, delta: 59999 - 2290 - 435 - 2400 });
    });

    test('egreso: sale el monto más sus cargos', () => {
        expect(C.efectoEnCuentas({ tipo: 'egreso', id_cuenta: 1, monto_cop: 100000, gmf: 400 }))
            .toEqual([{ id_cuenta: 1, delta: -100400 }]);
    });

    test('traslado: el origen paga los cargos, el destino recibe el monto', () => {
        expect(
            C.efectoEnCuentas({
                tipo: 'transferencia', id_cuenta: 2, id_cuenta_destino: 1, monto_cop: 300000,
                comision: 1000, gmf: 0,
            })
        ).toEqual([{ id_cuenta: 2, delta: -301000 }, { id_cuenta: 1, delta: 300000 }]);
    });

    test('sin tasa (monto_cop null) no mueve el saldo por el monto', () => {
        expect(C.efectoEnCuentas({ tipo: 'egreso', id_cuenta: 1, monto_cop: null })[0].delta).toBe(-0);
    });
});

describe('cifrasDelPeriodo', () => {
    test('la retención no baja el resultado (se recupera al declarar) pero sí la caja', () => {
        const c = C.cifrasDelPeriodo({
            ingresos: 1000000, egresos: 300000, comisiones_pasarela: 50000,
            comisiones_bancarias: 10000, retenciones: 40000, gmf: 2000,
        });
        expect(c.resultado).toBe(1000000 - 300000 - 60000 - 2000);
        expect(c.caja_neta).toBe(c.resultado - 40000);
        expect(c.gmf_deducible).toBe(1000);
        expect(c.margen).toBeCloseTo(0.638);
    });

    test('sin ingresos el margen es null, no NaN ni infinito', () => {
        expect(C.cifrasDelPeriodo({ egresos: 100 }).margen).toBeNull();
    });
});

describe('movimientoDeFactura', () => {
    const base = {
        id_factura: 7, id_negocio: 6, negocio: 'Zona Burger', referencia: 'EA-6-202610',
        moneda: 'COP', total: 59999, retencion_declarada: 0, fecha: '2026-10-02',
        medio_pago_texto: null, numero_factura: null,
    };
    const cuenta = { id_cuenta: 2, aplica_gmf: false };

    test('Wompi sin comisión registrada: se estima con la tarifa y queda «estimado»', () => {
        const m = C.movimientoDeFactura(
            { ...base, pasarela: 'wompi', comision_pasarela: 0 },
            { cuenta, idCategoria: 1, tarifa: WOMPI, trm: null }
        );
        expect(m.comision).toBe(2290);
        expect(m.iva_comision).toBe(435);
        expect(m.estimado).toBe(true);
        expect(m.origen).toBe('cobranza');
        expect(m.id_cuenta).toBe(2);
    });

    test('la comisión real tecleada en Cobranza manda y no queda estimado', () => {
        const m = C.movimientoDeFactura(
            { ...base, pasarela: 'wompi', comision_pasarela: 2500, retencion_declarada: 2400 },
            { cuenta, idCategoria: 1, tarifa: WOMPI, trm: null }
        );
        expect(m.comision).toBe(2500);
        expect(m.iva_comision).toBe(0);
        expect(m.retencion).toBe(2400);
        expect(m.estimado).toBe(false);
    });

    test('transferencia manual: sin comisión', () => {
        const m = C.movimientoDeFactura(
            { ...base, pasarela: 'manual', comision_pasarela: 0 },
            { cuenta, idCategoria: 1, tarifa: { porcentaje: 0, fijo: 0 }, trm: null }
        );
        expect(m.comision).toBe(0);
        expect(m.estimado).toBe(false);
    });

    test('moneda sin tasa conocida (CLP): se guarda sin monto en pesos, por revisar', () => {
        const m = C.movimientoDeFactura(
            { ...base, pasarela: 'dlocal', comision_pasarela: 0, moneda: 'CLP', total: 9900 },
            { cuenta, idCategoria: 1, tarifa: DLOCAL, trm: 4000 }
        );
        expect(m.monto_cop).toBeNull();
        expect(m.estimado).toBe(true);
    });
});

test('el código de una categoría nueva sale del nombre sin tildes', () => {
    expect(C._codigoDe('Cafetería y almuerzos')).toBe('CAFETERIA_Y_ALMUERZOS');
});
