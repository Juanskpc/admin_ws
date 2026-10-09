/**
 * `normalizarComprador` (R3.1 de `docs/plan-fe-restaurante.md`). Sin base de datos.
 *
 * Correr con:  npx jest __tests__/facturacion/comprador.test.js
 */
'use strict';

const { normalizarComprador } = require('../../app_core/facturacion/comprador');

const empresa = (extra = {}) => ({
    tipo_persona: '1',
    tipo_documento: '31',
    numero_documento: '800.197.268',
    razon_social: 'Empresa Prueba SAS',
    ...extra,
});

const invalido = expect.objectContaining({ code: 'FE_COMPRADOR_INVALIDO', statusCode: 422 });

describe('normalizarComprador', () => {
    test('sin comprador devuelve null: lo decide quien llama', () => {
        expect(normalizarComprador(null)).toBeNull();
        expect(normalizarComprador(undefined)).toBeNull();
    });

    test('un NIT sin DV: se calcula', () => {
        const c = normalizarComprador(empresa());
        expect(c.numero_documento).toBe('800197268');
        expect(c.dv).toBe('4');
        expect(c.consumidor_final).toBe(false);
    });

    test('un NIT con el DV equivocado dice cuál es el correcto', () => {
        expect(() => normalizarComprador(empresa({ dv: '5' }))).toThrow(invalido);
        expect(() => normalizarComprador(empresa({ dv: '5' }))).toThrow(/debería ser 4/);
    });

    test('una persona jurídica sin razón social no pasa', () => {
        expect(() => normalizarComprador(empresa({ razon_social: '  ' }))).toThrow(invalido);
    });

    test('una persona natural sin nombre no pasa', () => {
        expect(() =>
            normalizarComprador({ tipo_persona: '2', tipo_documento: '13', numero_documento: '1000000009' })
        ).toThrow(invalido);
    });

    test('un correo mal escrito no pasa', () => {
        expect(() => normalizarComprador(empresa({ correo: 'sin-arroba' }))).toThrow(invalido);
    });

    test('una cédula no lleva DV y los vacíos quedan en null', () => {
        const c = normalizarComprador({
            tipo_persona: '2',
            tipo_documento: '13',
            numero_documento: '1.000.000.009',
            nombres: ' Cliente Prueba ',
            correo: '',
        });
        expect(c).toEqual({
            consumidor_final: false,
            tipo_persona: '2',
            tipo_documento: '13',
            numero_documento: '1000000009',
            dv: null,
            razon_social: null,
            nombres: 'Cliente Prueba',
            correo: null,
            telefono: null,
            direccion: null,
        });
    });

    test('un pasaporte conserva sus letras', () => {
        const c = normalizarComprador({
            tipo_persona: '2',
            tipo_documento: '41',
            numero_documento: 'AB123456',
            nombres: 'Turista',
        });
        expect(c.numero_documento).toBe('AB123456');
    });
});
