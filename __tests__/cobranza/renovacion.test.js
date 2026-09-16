/**
 * Cobranza — hasta cuándo queda el plan después de pagar.
 *
 * Regla del dueño (2026-09-15): un pago compra UN ciclo que se suma a la FECHA DE VENCIMIENTO,
 * no al día en que se paga. «Se me venció el 10 de septiembre, se dieron 5 días más, pago el 15:
 * la renovación no es hasta el 15 de octubre, es hasta el 10, porque esa fue la fecha de
 * vencimiento.»
 *
 * Son fechas: si esto se rompe no falla nada, simplemente se regalan (o se roban) días.
 *
 * Ejecutar: npx jest __tests__/cobranza/
 */
'use strict';
const { calcularRenovacion } = require('../../app_admin_api/services/cobranzaService');

describe('renovación de un ciclo mensual', () => {
    test('el ejemplo del dueño: vence 10-sep, paga el 15 en gracia → hasta el 10-oct', () => {
        expect(calcularRenovacion({ fin: '2026-09-10', hoy: '2026-09-15', ciclo: 'mensual' })).toEqual({
            inicio: '2026-09-11',
            fin: '2026-10-10',
        });
    });

    test('los días de gracia no se regalan: pagar al final de la gracia da el mismo vencimiento', () => {
        const alDia = calcularRenovacion({ fin: '2026-09-10', hoy: '2026-09-11', ciclo: 'mensual' });
        const tarde = calcularRenovacion({ fin: '2026-09-10', hoy: '2026-09-15', ciclo: 'mensual' });
        expect(tarde.fin).toBe(alDia.fin);
    });

    test('pagar por adelantado no hace perder días: vence 1-oct, paga 27-sep → hasta 1-nov', () => {
        expect(calcularRenovacion({ fin: '2026-10-01', hoy: '2026-09-27', ciclo: 'mensual' }).fin).toBe(
            '2026-11-01',
        );
    });

    test('un plan contratado por 2 meses suma UN mes por pago, no dos', () => {
        // Contratado el 10-sep por 2 meses → vence 10-nov. Paga una mensualidad → 10-dic.
        expect(calcularRenovacion({ fin: '2026-11-10', hoy: '2026-11-08', ciclo: 'mensual' }).fin).toBe(
            '2026-12-10',
        );
    });

    test('pagar el mismo día en que termina el mes comprado todavía cubre hoy', () => {
        expect(calcularRenovacion({ fin: '2026-09-10', hoy: '2026-10-10', ciclo: 'mensual' })).toEqual({
            inicio: '2026-09-11',
            fin: '2026-10-10',
        });
    });

    test('si pagó tan tarde que ese mes ya pasó, el ciclo arranca el día del pago', () => {
        // Anclar al 10-sep lo dejaría hasta el 10-oct: pagaría el 20-oct y seguiría vencido.
        expect(calcularRenovacion({ fin: '2026-09-10', hoy: '2026-10-20', ciclo: 'mensual' })).toEqual({
            inicio: '2026-10-20',
            fin: '2026-11-20',
        });
    });

    test('fin de mes: vence 31-ene → hasta 28-feb, no 3-mar', () => {
        expect(calcularRenovacion({ fin: '2027-01-31', hoy: '2027-01-30', ciclo: 'mensual' }).fin).toBe(
            '2027-02-28',
        );
    });

    test('sin plan activo, el ciclo arranca hoy', () => {
        expect(calcularRenovacion({ fin: null, hoy: '2026-09-15', ciclo: 'mensual' })).toEqual({
            inicio: '2026-09-15',
            fin: '2026-10-15',
        });
    });

    test('ciclo anual: suma un año al vencimiento', () => {
        expect(calcularRenovacion({ fin: '2026-09-10', hoy: '2026-09-12', ciclo: 'anual' }).fin).toBe(
            '2027-09-10',
        );
    });

    test('dos pagos seguidos encadenan dos meses sin huecos ni solapes', () => {
        const primero = calcularRenovacion({ fin: '2026-09-10', hoy: '2026-09-15', ciclo: 'mensual' });
        const segundo = calcularRenovacion({ fin: primero.fin, hoy: '2026-09-15', ciclo: 'mensual' });
        expect(segundo).toEqual({ inicio: '2026-10-11', fin: '2026-11-10' });
    });
});
