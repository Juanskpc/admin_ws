/**
 * Adaptador Wompi — `consultarPorReferencia`: `GET /v1/transactions?reference=<ref>` con la llave
 * PRIVADA, devolviendo siempre un arreglo con la forma de `consultarTransaccion`.
 *
 * ⚠️ Escrito contra la documentación; NO ejecutado contra el sandbox (la documentación de Wompi no
 * estaba accesible al escribirlo). Estas pruebas fijan nuestro lado del contrato con `fetch`
 * simulado: la ruta, la llave, la traducción de estados y la tolerancia a `data` como arreglo,
 * objeto o vacío.
 */
'use strict';

process.env.WOMPI_PUBLIC_KEY = 'pub_test_abc';
process.env.WOMPI_PRIVATE_KEY = 'prv_test_secreta';
process.env.WOMPI_INTEGRITY_SECRET = 'test_integrity_x';

const wompi = require('../../app_core/cobranza/adapters/wompi');

function fetchDevuelve(cuerpo, ok = true, status = 200) {
    global.fetch = jest.fn(async () => ({ ok, status, text: async () => JSON.stringify(cuerpo) }));
}

afterEach(() => { delete global.fetch; });

describe('consultarPorReferencia', () => {
    test('pide por referencia, con la llave privada, y normaliza los estados', async () => {
        fetchDevuelve({ data: [
            { id: 't1', status: 'DECLINED', reference: 'EA-13-202609-abc', amount_in_cents: 2799900, currency: 'COP' },
            { id: 't2', status: 'APPROVED', reference: 'EA-13-202609-abc', amount_in_cents: 2799900, currency: 'COP' },
        ] });

        const r = await wompi.consultarPorReferencia('EA-13-202609-abc');

        const [url, opciones] = global.fetch.mock.calls[0];
        expect(url).toBe('https://sandbox.wompi.co/v1/transactions?reference=EA-13-202609-abc');
        expect(opciones.headers.Authorization).toBe('Bearer prv_test_secreta');
        expect(r.map((t) => t.estado)).toEqual(['rechazada', 'aprobada']);
        expect(r[1]).toMatchObject({ idExterno: 't2', payload: { amount_in_cents: 2799900, currency: 'COP' } });
    });

    test('sin transacciones → arreglo vacío (no lanza)', async () => {
        fetchDevuelve({ data: [] });
        expect(await wompi.consultarPorReferencia('EA-1-202609-x')).toEqual([]);
    });

    test('tolera `data` como objeto', async () => {
        fetchDevuelve({ data: { id: 't9', status: 'PENDING', reference: 'r' } });
        const r = await wompi.consultarPorReferencia('r');
        expect(r).toHaveLength(1);
        expect(r[0].estado).toBe('pendiente');
    });

    test('la referencia se codifica en la URL', async () => {
        fetchDevuelve({ data: [] });
        await wompi.consultarPorReferencia('a b&c');
        expect(global.fetch.mock.calls[0][0]).toContain('reference=a%20b%26c');
    });

    test('un error de Wompi lanza un error tipado (el conciliador lo cuenta y sigue)', async () => {
        fetchDevuelve({ error: { type: 'INPUT_VALIDATION_ERROR' } }, false, 422);
        await expect(wompi.consultarPorReferencia('x')).rejects.toMatchObject({ code: 'PASARELA_ERROR' });
    });

    test('sin referencia no llama a Wompi', async () => {
        fetchDevuelve({ data: [] });
        expect(await wompi.consultarPorReferencia('')).toEqual([]);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
