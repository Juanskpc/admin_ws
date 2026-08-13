/**
 * Identity Resolver (F5-D).
 *
 * Lo que se prueba aquí no es "que devuelva datos", sino las dos cosas que, si se rompen,
 * rompen algo grave y en silencio:
 *
 *   1. Que el Principal de un contacto **no alcance otro negocio**. Es la misma frontera
 *      multi-inquilino de F2, y un canal público es justo donde más barato sale atacarla.
 *   2. Que un teléfono dudoso se resuelva a `null` en vez de a un número inventado, porque
 *      una persona duplicada por normalización no da error: da métricas mal durante meses.
 */
'use strict';

const { principalDeContacto, normalizarTelefono } = require('../../intelligence/engine/identidad');
const { TIPO } = require('../../app_core/authz/principal');

describe('Identity Resolver — Principal de contacto', () => {
    test('opera sobre su negocio y sobre ningún otro', () => {
        const principal = principalDeContacto(7);

        expect(principal.puedeOperarEn(7)).toBe(true);
        expect(principal.puedeOperarEn(8)).toBe(false);
        expect(principal.idsNegocio()).toEqual([7]);
    });

    test('acepta el id de negocio como número o como texto, sin abrir el alcance', () => {
        // El id llega desde una fila de la base y podría venir como string; lo que no puede
        // pasar es que esa diferencia de tipo se convierta en un fallo de autorización.
        const principal = principalDeContacto('7');

        expect(principal.puedeOperarEn(7)).toBe(true);
        expect(principal.puedeOperarEn('7')).toBe(true);
        expect(principal.puedeOperarEn(70)).toBe(false);
    });

    test('es de tipo contacto, sin usuario y sin super admin', () => {
        const principal = principalDeContacto(3);

        expect(principal.tipo).toBe(TIPO.CONTACTO);
        expect(principal.id_usuario).toBeNull();
        expect(principal.es_super_admin).toBe(false);
    });

    test('no hereda ningún rol', () => {
        // Un contacto no es un empleado con menos permisos. Si algún día alguien mete un rol
        // aquí "para que pueda hacer X", este test se lo dice antes de que llegue a producción.
        expect(principalDeContacto(3).rolesEn(3)).toEqual([]);
    });

    test('un super admin nunca sale de aquí', () => {
        // `puedeOperarEn` devuelve true para cualquier negocio si es_super_admin. Que este
        // productor no pueda emitirlo es lo que impide que un canal anónimo escale.
        expect(principalDeContacto(1).puedeOperarEn(999)).toBe(false);
    });

    test.each([null, undefined, 0, -1, 'abc', 1.5])('rechaza el id de negocio %p', (malo) => {
        expect(() => principalDeContacto(malo)).toThrow(/id_negocio/);
    });
});

describe('Identity Resolver — normalización de teléfono', () => {
    test.each([
        ['3114682492', '+573114682492'],
        ['311 468 2492', '+573114682492'],
        ['311-468-2492', '+573114682492'],
        ['+57 311 468 2492', '+573114682492'],
        ['573114682492', '+573114682492'],
    ])('los formatos del mismo móvil colapsan: %s', (entrada, esperado) => {
        // Es el caso real del backfill de F0: cinco formatos, una sola persona.
        expect(normalizarTelefono(entrada)).toBe(esperado);
    });

    test('un fijo de Bogotá también se normaliza', () => {
        expect(normalizarTelefono('6011234567')).toBe('+576011234567');
    });

    test.each([
        ['', 'vacío'],
        [null, 'nulo'],
        [undefined, 'ausente'],
        ['123', 'demasiado corto'],
        ['no soy un telefono', 'basura'],
        ['00000000000000000', 'demasiado largo'],
    ])('devuelve null ante %p (%s) en vez de inventar', (entrada) => {
        expect(normalizarTelefono(entrada)).toBeNull();
    });
});
