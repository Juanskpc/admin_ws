const { normalizarE164Colombia } = require('../../app_core/helpers/telefono');

describe('normalizarE164Colombia', () => {
    describe('formatos que aparecen en producción', () => {
        // Los cinco resuelven al mismo humano. Es lo que hace posible la Ficha 360:
        // sin esta convergencia, un mismo cliente sería cinco personas distintas.
        it.each([
            ['3001112233', 'crudo'],
            ['300 111 2233', 'con espacios'],
            ['300-111-2233', 'con guiones'],
            ['+57 300 111 2233', 'con prefijo país'],
            ['573001112233', 'con 57 pegado'],
            ['03001112233', 'con troncal 0'],
            ['(300) 111 2233', 'con paréntesis'],
        ])('normaliza %s (%s) a +573001112233', (entrada) => {
            expect(normalizarE164Colombia(entrada)).toBe('+573001112233');
        });
    });

    describe('rechaza lo que no es un móvil utilizable', () => {
        it.each([
            [null, 'null'],
            [undefined, 'undefined'],
            ['', 'cadena vacía'],
            ['   ', 'solo espacios'],
            ['abc', 'sin dígitos'],
            ['12345', 'demasiado corto'],
            ['6012345678', 'fijo (empieza en 6)'],
            ['1234567', 'fijo legacy de 7 dígitos'],
            ['0000000000', 'dígito repetido'],
            ['3333333333', 'dígito repetido que parece móvil'],
            ['30011122334455', 'demasiado largo'],
            ['2001112233', 'diez dígitos pero no empieza en 3'],
        ])('rechaza %s (%s)', (entrada) => {
            expect(normalizarE164Colombia(entrada)).toBeNull();
        });
    });

    it('es idempotente sobre un valor ya normalizado', () => {
        const unaVez = normalizarE164Colombia('3001112233');
        expect(normalizarE164Colombia(unaVez)).toBe(unaVez);
    });

    it('acepta valores numéricos, no solo cadenas', () => {
        expect(normalizarE164Colombia(3001112233)).toBe('+573001112233');
    });
});
