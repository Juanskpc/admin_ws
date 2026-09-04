/**
 * Suite del NIT (FE-1) — `app_core/helpers/nit.js`.
 *
 * No toca la base de datos: es aritmética pura y se puede correr en cualquier sitio.
 *
 *   npx jest __tests__/facturacion/nit.test.js
 *
 * Los dos casos de verdad son NIT públicos y conocidos, comprobados a mano antes de escribir el
 * código: la DIAN (800197268-4) y Bancolombia (890903938-8). Sin al menos un caso con respuesta
 * conocida de antemano, un test de un algoritmo solo comprueba que el código hace lo que hace.
 */
'use strict';

const { normalizarDocumento, calcularDv, esDvValido, separarNit } = require('../../app_core/helpers/nit');

describe('normalizarDocumento', () => {
    test('quita puntos, guiones y espacios', () => {
        expect(normalizarDocumento('900.123.456')).toBe('900123456');
        expect(normalizarDocumento('900 123 456')).toBe('900123456');
        expect(normalizarDocumento('900-123-456')).toBe('900123456');
    });

    test('acepta números y no solo cadenas', () => {
        expect(normalizarDocumento(900123456)).toBe('900123456');
    });

    test('devuelve null cuando no queda nada utilizable', () => {
        expect(normalizarDocumento(null)).toBeNull();
        expect(normalizarDocumento(undefined)).toBeNull();
        expect(normalizarDocumento('')).toBeNull();
        expect(normalizarDocumento('   ')).toBeNull();
        expect(normalizarDocumento('sin dígitos')).toBeNull();
    });
});

describe('calcularDv — contra NIT reales', () => {
    test('DIAN: 800197268 → 4', () => {
        expect(calcularDv('800197268')).toBe(4);
    });

    test('Bancolombia: 890903938 → 8', () => {
        expect(calcularDv('890903938')).toBe(8);
    });

    test('da igual cómo venga escrito', () => {
        expect(calcularDv('800.197.268')).toBe(4);
        expect(calcularDv(800197268)).toBe(4);
    });

    test('devuelve null si no hay número o es absurdamente largo', () => {
        expect(calcularDv(null)).toBeNull();
        expect(calcularDv('abc')).toBeNull();
        expect(calcularDv('1'.repeat(16))).toBeNull();
    });
});

describe('esDvValido', () => {
    test('acepta el dígito correcto, en número o en texto', () => {
        expect(esDvValido('800197268', 4)).toBe(true);
        expect(esDvValido('800197268', '4')).toBe(true);
    });

    test('rechaza el equivocado', () => {
        expect(esDvValido('800197268', 5)).toBe(false);
        expect(esDvValido('890903938', 4)).toBe(false);
    });

    test('rechaza entradas que no son un dígito suelto', () => {
        expect(esDvValido('800197268', null)).toBe(false);
        expect(esDvValido('800197268', '')).toBe(false);
        expect(esDvValido('800197268', '44')).toBe(false);
        expect(esDvValido(null, 4)).toBe(false);
    });
});

describe('separarNit', () => {
    test('separa el DV cuando viene marcado con guion', () => {
        expect(separarNit('800197268-4')).toEqual({
            numero: '800197268',
            dv: '4',
            dvCalculado: 4,
            coherente: true,
        });
    });

    test('separa también con puntos y espacios alrededor del guion', () => {
        expect(separarNit('800.197.268 - 4')).toMatchObject({ numero: '800197268', dv: '4', coherente: true });
    });

    test('avisa cuando el DV que trae NO corresponde', () => {
        // Este es el caso que hay que cazar antes de enviar nada: la DIAN rechaza el documento
        // entero y el mensaje de error no siempre dice que el problema era el DV.
        expect(separarNit('800197268-9')).toEqual({
            numero: '800197268',
            dv: '9',
            dvCalculado: 4,
            coherente: false,
        });
    });

    test('NO adivina el DV cuando viene todo pegado', () => {
        // '8001972684' puede ser un NIT de 10 dígitos o uno de 9 con el DV pegado. Las dos
        // lecturas son válidas y solo el RUT lo resuelve, así que no se elige ninguna.
        const r = separarNit('8001972684');
        expect(r.numero).toBe('8001972684');
        expect(r.dv).toBeNull();
        expect(r.coherente).toBeNull();
    });

    test('entradas vacías no revientan', () => {
        for (const v of [null, undefined, '', '   ', 'x']) {
            expect(separarNit(v)).toEqual({ numero: null, dv: null, dvCalculado: null, coherente: null });
        }
    });
});
