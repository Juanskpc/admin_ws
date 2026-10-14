/**
 * Adaptador Wompi — el débito automático (2026-10-14), con `fetch` simulado:
 *
 *   - `getTerminos` devuelve los DOS documentos (reglamento y datos personales) con su enlace,
 *   - `tokenizarMetodo` manda `accept_personal_auth` además del `acceptance_token`,
 *   - `cobrar` con fuente de pago usa una referencia DISTINTA por intento (Wompi rechaza la
 *     repetida y el reintento a los 3 días la repetía), firma esa referencia y marca `recurrent`.
 */
'use strict';

process.env.WOMPI_PUBLIC_KEY = 'pub_test_abc';
process.env.WOMPI_PRIVATE_KEY = 'prv_test_secreta';
process.env.WOMPI_INTEGRITY_SECRET = 'test_integrity_x';

const crypto = require('crypto');
const wompi = require('../../app_core/cobranza/adapters/wompi');

function fetchDevuelve(...respuestas) {
    const cola = [...respuestas];
    global.fetch = jest.fn(async () => {
        const cuerpo = cola.length > 1 ? cola.shift() : cola[0];
        return { ok: true, status: 200, text: async () => JSON.stringify(cuerpo) };
    });
}
const cuerpoEnviado = (n = 0) => JSON.parse(global.fetch.mock.calls[n][1].body);

afterEach(() => {
    delete global.fetch;
});

test('getTerminos devuelve reglamento y autorización de datos, con sus enlaces', async () => {
    fetchDevuelve({
        data: {
            presigned_acceptance: { acceptance_token: 'acc-1', permalink: 'https://w/reglamento.pdf' },
            presigned_personal_data_auth: { acceptance_token: 'auth-1', permalink: 'https://w/datos.pdf' },
        },
    });
    const t = await wompi.getTerminos();
    expect(global.fetch.mock.calls[0][0]).toBe('https://sandbox.wompi.co/v1/merchants/pub_test_abc');
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer pub_test_abc');
    expect(t).toEqual({
        acceptanceToken: 'acc-1',
        permalink: 'https://w/reglamento.pdf',
        personalAuthToken: 'auth-1',
        personalPermalink: 'https://w/datos.pdf',
    });
});

test('tokenizarMetodo manda las dos aceptaciones y devuelve solo lo que se puede mostrar', async () => {
    fetchDevuelve({
        data: { id: 1234, type: 'CARD', public_data: { brand: 'VISA', last_four: '4242', exp_month: '12', exp_year: '30' } },
    });
    const f = await wompi.tokenizarMetodo({
        tokenTarjeta: 'tok_test_1',
        acceptanceToken: 'acc-1',
        personalAuthToken: 'auth-1',
        email: 'a@b.co',
    });
    expect(global.fetch.mock.calls[0][0]).toBe('https://sandbox.wompi.co/v1/payment_sources');
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer prv_test_secreta');
    expect(cuerpoEnviado()).toEqual({
        type: 'CARD',
        token: 'tok_test_1',
        customer_email: 'a@b.co',
        acceptance_token: 'acc-1',
        accept_personal_auth: 'auth-1',
    });
    expect(f).toEqual({ tokenExterno: '1234', tipo: 'CARD', marca: 'VISA', ultimos4: '4242', mesExp: 12, anioExp: 30 });
});

test('cobrar con fuente de pago: referencia única por intento, firmada, y marcada como recurrente', async () => {
    fetchDevuelve(
        { data: { id: 'tx-1', status: 'PENDING', reference: 'x' } },
        { data: { id: 'tx-2', status: 'APPROVED', reference: 'y' } }
    );
    const a = await wompi.cobrar({ referencia: 'EA-17-202610', monto: 27999, moneda: 'COP', token: '1234', email: 'a@b.co' });
    await new Promise((r) => setTimeout(r, 2));
    await wompi.cobrar({ referencia: 'EA-17-202610', monto: 27999, moneda: 'COP', token: '1234', email: 'a@b.co' });

    const c1 = cuerpoEnviado(0);
    const c2 = cuerpoEnviado(1);
    expect(c1.reference).toMatch(/^EA-17-202610-[a-z0-9]+$/);
    expect(c2.reference).not.toBe(c1.reference);
    expect(c1).toMatchObject({ payment_source_id: 1234, recurrent: true, amount_in_cents: 2799900, currency: 'COP' });
    const firma = crypto
        .createHash('sha256')
        .update(`${c1.reference}2799900COPtest_integrity_x`)
        .digest('hex');
    expect(c1.signature).toBe(firma);

    // Lo que queda guardado permite a la conciliación y al webhook reconocer el débito.
    expect(a).toMatchObject({ estado: 'pendiente', idExterno: 'tx-1' });
    expect(a.payload).toMatchObject({ modo: 'fuente-de-pago' });
});
