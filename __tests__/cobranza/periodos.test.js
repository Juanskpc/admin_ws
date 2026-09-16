/**
 * Cobranza — aritmética de períodos de facturación.
 *
 * Estas pruebas NO tocan la base: son la parte del módulo que se puede equivocar en silencio
 * y cobrar de más. El bug clásico de la facturación mensual es que el 31 de enero + 1 mes dé
 * el 3 de marzo; a un cliente al que se le corre el ciclo tres días cada mes se le termina
 * cobrando trece veces al año, y nadie lo nota hasta que reclama.
 *
 * Ejecutar: npx jest __tests__/cobranza/
 */
'use strict';
const { _fechas } = require('../../app_admin_api/services/cobranzaService');
const { sumarCiclo, diaAnterior, sumarDia, construirReferencia, hoyBogota } = _fechas;

/** El período que cubre una factura que arranca en `inicio`: [inicio, fin] inclusive. */
function periodo(inicio, ciclo = 'mensual') {
    return { inicio, fin: diaAnterior(sumarCiclo(inicio, ciclo)) };
}

describe('sumarCiclo — fin de mes', () => {
    test('31 de enero + 1 mes es el 28 de febrero, no el 3 de marzo', () => {
        expect(sumarCiclo('2026-01-31', 'mensual')).toBe('2026-02-28');
    });

    test('respeta el año bisiesto', () => {
        expect(sumarCiclo('2028-01-31', 'mensual')).toBe('2028-02-29');
    });

    test('cruza el fin de año', () => {
        expect(sumarCiclo('2026-12-15', 'mensual')).toBe('2027-01-15');
    });

    test('el ciclo anual suma un año', () => {
        expect(sumarCiclo('2026-09-08', 'anual')).toBe('2027-09-08');
    });
});

describe('períodos de facturación', () => {
    test('un mes normal termina el día anterior al mismo día del mes siguiente', () => {
        expect(periodo('2026-09-01')).toEqual({ inicio: '2026-09-01', fin: '2026-09-30' });
        expect(periodo('2026-03-15')).toEqual({ inicio: '2026-03-15', fin: '2026-04-14' });
    });

    test('los períodos consecutivos no se solapan ni dejan huecos', () => {
        const primero = periodo('2026-01-31');
        const segundo = periodo(sumarDia(primero.fin));

        expect(segundo.inicio).toBe(sumarDia(primero.fin));
        expect(primero.fin < segundo.inicio).toBe(true);
    });

    test('doce meses encadenados cubren un año sin perder días', () => {
        let inicio = '2026-01-31';
        const inicios = [];
        for (let i = 0; i < 12; i += 1) {
            const p = periodo(inicio);
            inicios.push(p.inicio);
            inicio = sumarDia(p.fin);
        }
        // Doce cobros y ni uno más: el ciclo no se adelanta mes a mes.
        expect(inicios).toHaveLength(12);
        expect(inicios[0]).toBe('2026-01-31');
        expect(inicio > '2027-01-01').toBe(true);
        expect(inicio <= '2027-02-01').toBe(true);
    });

    test('el ciclo anual cubre un año menos un día', () => {
        expect(periodo('2026-09-08', 'anual')).toEqual({
            inicio: '2026-09-08',
            fin: '2027-09-07',
        });
    });
});

describe('referencia idempotente', () => {
    test('tiene el formato EA-<id_negocio>-<AAAAMM>', () => {
        expect(construirReferencia(6, '2026-09-01')).toBe('EA-6-202609');
        expect(construirReferencia(12, '2026-11-30')).toBe('EA-12-202611');
    });

    test('dos fechas del mismo mes producen la MISMA referencia', () => {
        // Es lo que impide cobrar dos veces el mismo mes: la segunda inserción choca contra
        // el UNIQUE de cob_factura.
        expect(construirReferencia(6, '2026-09-01')).toBe(construirReferencia(6, '2026-09-28'));
    });

    test('negocios distintos nunca comparten referencia', () => {
        expect(construirReferencia(6, '2026-09-01')).not.toBe(construirReferencia(7, '2026-09-01'));
    });
});

describe('hoyBogota', () => {
    test('devuelve una fecha YYYY-MM-DD', () => {
        expect(hoyBogota()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('usa el día de Bogotá, no el UTC', () => {
        // A las 22:00 de Bogotá ya es el día siguiente en UTC. `toISOString()` daría el día
        // equivocado cada noche, y con él la referencia del mes equivocado los días 30 y 31.
        const enBogota = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Bogota',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(new Date());
        expect(hoyBogota()).toBe(enBogota);
    });
});
