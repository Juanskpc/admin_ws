/**
 * Cobranza — Wompi solo cobra con llaves coherentes con el ambiente.
 *
 * El 2026-09-14 el `.env` local tenía llaves de PRODUCCIÓN. El checkout de Wompi elige el ambiente
 * por la llave pública, así que un «pago de prueba» habría cobrado dinero real, mientras el backend
 * consultaba el sandbox y no lo confirmaba. Estas pruebas fijan la guarda que lo impide.
 *
 * Ejecutar: npx jest __tests__/cobranza/
 */
'use strict';

const wompi = require('../../app_core/cobranza/adapters/wompi');

const VARIABLES = [
    'NODE_ENV',
    'WOMPI_PUBLIC_KEY',
    'WOMPI_PRIVATE_KEY',
    'WOMPI_INTEGRITY_SECRET',
    'WOMPI_EVENTS_SECRET',
    'WOMPI_PERMITIR_PRODUCCION_LOCAL',
];
const previas = {};

function llavesDe(ambiente) {
    const p = ambiente === 'test' ? 'test' : 'prod';
    process.env.WOMPI_PUBLIC_KEY = `pub_${p}_abc`;
    process.env.WOMPI_PRIVATE_KEY = `prv_${p}_abc`;
    process.env.WOMPI_INTEGRITY_SECRET = `${p}_integrity_abc`;
    process.env.WOMPI_EVENTS_SECRET = `${p}_events_abc`;
}

beforeAll(() => {
    for (const v of VARIABLES) previas[v] = process.env[v];
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

beforeEach(() => {
    for (const v of VARIABLES) delete process.env[v];
});

afterAll(() => {
    for (const v of VARIABLES) {
        if (previas[v] === undefined) delete process.env[v];
        else process.env[v] = previas[v];
    }
    console.warn.mockRestore();
});

describe('Wompi — llaves y ambiente', () => {
    test('llaves de pruebas en local → puede cobrar (sandbox, sin dinero real)', () => {
        process.env.NODE_ENV = 'development';
        llavesDe('test');
        expect(wompi.estaConfigurada()).toBe(true);
    });

    test('llaves de PRODUCCIÓN en local → NO puede cobrar', () => {
        process.env.NODE_ENV = 'development';
        llavesDe('prod');
        expect(wompi.estaConfigurada()).toBe(false);
    });

    test('llaves de producción en local con permiso explícito → puede cobrar', () => {
        process.env.NODE_ENV = 'development';
        process.env.WOMPI_PERMITIR_PRODUCCION_LOCAL = 'true';
        llavesDe('prod');
        expect(wompi.estaConfigurada()).toBe(true);
    });

    test('llaves de producción en producción → puede cobrar', () => {
        process.env.NODE_ENV = 'production';
        llavesDe('prod');
        expect(wompi.estaConfigurada()).toBe(true);
    });

    test('llaves mezcladas (pública de pruebas, privada de producción) → NO puede cobrar', () => {
        process.env.NODE_ENV = 'production';
        llavesDe('prod');
        process.env.WOMPI_PUBLIC_KEY = 'pub_test_abc';
        expect(wompi.estaConfigurada()).toBe(false);
    });

    test('secreto de eventos de otro ambiente → NO puede cobrar', () => {
        process.env.NODE_ENV = 'development';
        llavesDe('test');
        process.env.WOMPI_EVENTS_SECRET = 'prod_events_abc';
        expect(wompi.estaConfigurada()).toBe(false);
    });

    test('faltan llaves → NO puede cobrar', () => {
        process.env.NODE_ENV = 'development';
        process.env.WOMPI_PUBLIC_KEY = 'pub_test_abc';
        expect(wompi.estaConfigurada()).toBe(false);
    });
});
