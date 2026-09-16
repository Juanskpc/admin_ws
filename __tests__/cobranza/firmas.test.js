/**
 * Cobranza — verificación de firmas de webhook.
 *
 * Es el código más peligroso del módulo: si acepta lo que no debe, cualquiera activa planes
 * gratis con un `curl`; si rechaza lo que sí debe, los pagos entran y nadie se entera. Y no se
 * puede probar contra las pasarelas hasta tener credenciales.
 *
 * Estas pruebas construyen eventos firmados **según la documentación de cada pasarela** y
 * comprueban las dos direcciones: que el legítimo pase y que el manipulado no. No sustituyen a
 * un cobro real en sandbox, pero sí atrapan el 90% de los errores de esta clase — un orden de
 * concatenación equivocado, el secreto que no es, o un `===` sobre buffers de distinto tamaño.
 *
 * Ejecutar: npx jest __tests__/cobranza/
 */
'use strict';
const crypto = require('crypto');

const wompi = require('../../app_core/cobranza/adapters/wompi');
const dlocal = require('../../app_core/cobranza/adapters/dlocal');

/** Un `req` de Express con lo justo que miran los adaptadores. */
function fakeReq(cuerpo, cabeceras = {}) {
    const crudo = Buffer.from(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo), 'utf8');
    return {
        rawBody: crudo,
        ip: '127.0.0.1',
        get: (nombre) => cabeceras[nombre] ?? cabeceras[nombre.toLowerCase()] ?? undefined,
    };
}

// ── Wompi ───────────────────────────────────────────────────────────────────────────────

const EVENTS_SECRET = 'test_events_ABC123';

/** Construye un evento de Wompi con su checksum correcto, tal y como lo manda Wompi. */
function eventoWompi({ id = '1234-1610641025-49201', status = 'APPROVED', amount = 2799900 } = {}) {
    const timestamp = 1530291411;
    const data = {
        transaction: {
            id,
            status,
            amount_in_cents: amount,
            reference: 'EA-6-202609',
        },
    };
    const propiedades = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
    const concatenado = propiedades
        .map((ruta) => ruta.split('.').reduce((nodo, clave) => nodo?.[clave], data))
        .join('');
    const checksum = crypto
        .createHash('sha256')
        .update(`${concatenado}${timestamp}${EVENTS_SECRET}`)
        .digest('hex');

    return {
        event: 'transaction.updated',
        data,
        environment: 'test',
        signature: { properties: propiedades, checksum },
        timestamp,
        sent_at: '2026-09-08T16:45:05.000Z',
    };
}

describe('Wompi — firma de eventos', () => {
    const anterior = process.env.WOMPI_EVENTS_SECRET;
    beforeAll(() => {
        process.env.WOMPI_EVENTS_SECRET = EVENTS_SECRET;
    });
    afterAll(() => {
        process.env.WOMPI_EVENTS_SECRET = anterior;
    });

    test('acepta un evento legítimo y extrae la transacción', async () => {
        const r = await wompi.verificarFirmaWebhook(fakeReq(eventoWompi()));
        expect(r.valida).toBe(true);
        expect(r.idExterno).toBe('1234-1610641025-49201');
        expect(r.referencia).toBe('EA-6-202609');
        expect(r.tipo).toBe('transaction.updated');
    });

    test('el id del evento incluye el estado: dos cambios distintos no se pisan', async () => {
        const aprobada = await wompi.verificarFirmaWebhook(fakeReq(eventoWompi()));
        const pendiente = await wompi.verificarFirmaWebhook(
            fakeReq(eventoWompi({ status: 'PENDING' })),
        );
        // Si el id fuera solo la transacción, el UNIQUE del webhook descartaría el segundo
        // cambio de estado como «duplicado» y la factura se quedaría colgada.
        expect(aprobada.idEvento).not.toBe(pendiente.idEvento);
    });

    test('rechaza un monto manipulado', async () => {
        const evento = eventoWompi();
        evento.data.transaction.amount_in_cents = 100; // el checksum ya no cuadra
        const r = await wompi.verificarFirmaWebhook(fakeReq(evento));
        expect(r.valida).toBe(false);
    });

    test('rechaza un estado manipulado a APPROVED', async () => {
        const evento = eventoWompi({ status: 'DECLINED' });
        evento.data.transaction.status = 'APPROVED';
        const r = await wompi.verificarFirmaWebhook(fakeReq(evento));
        expect(r.valida).toBe(false);
    });

    test('rechaza si el secreto no es el nuestro', async () => {
        process.env.WOMPI_EVENTS_SECRET = 'otro_secreto';
        const r = await wompi.verificarFirmaWebhook(fakeReq(eventoWompi()));
        expect(r.valida).toBe(false);
        process.env.WOMPI_EVENTS_SECRET = EVENTS_SECRET;
    });

    test('rechaza un cuerpo que no es JSON, sin reventar', async () => {
        const r = await wompi.verificarFirmaWebhook(fakeReq('esto no es json'));
        expect(r.valida).toBe(false);
        expect(r.payload).toBeNull();
    });
});

// ── dLocal Go ───────────────────────────────────────────────────────────────────────────

const DL_API_KEY = 'dl_key_123';
const DL_SECRET = 'dl_secret_456';

function firmaDlocal(crudo) {
    return crypto.createHmac('sha256', DL_SECRET).update(`${DL_API_KEY}${crudo}`).digest('hex');
}

describe('dLocal Go — firma de notificaciones', () => {
    const previas = { key: process.env.DLOCAL_API_KEY, secret: process.env.DLOCAL_SECRET_KEY };
    beforeAll(() => {
        process.env.DLOCAL_API_KEY = DL_API_KEY;
        process.env.DLOCAL_SECRET_KEY = DL_SECRET;
    });
    afterAll(() => {
        process.env.DLOCAL_API_KEY = previas.key;
        process.env.DLOCAL_SECRET_KEY = previas.secret;
    });

    test('acepta una notificación legítima y extrae el payment_id', async () => {
        const crudo = JSON.stringify({ payment_id: 'PAY-99', status: 'PAID' });
        const req = fakeReq(crudo, {
            Authorization: `V2-HMAC-SHA256, Signature: ${firmaDlocal(crudo)}`,
        });

        const r = await dlocal.verificarFirmaWebhook(req);
        expect(r.valida).toBe(true);
        expect(r.idExterno).toBe('PAY-99');
        expect(r.idEvento).toBe('dlocal:PAY-99');
    });

    test('la firma se calcula sobre los BYTES, no sobre el objeto reserializado', async () => {
        // Mismo contenido, distinto orden de claves: los bytes cambian y la firma del original
        // no vale. Es exactamente lo que pasaría si `express.json()` parseara antes.
        const original = JSON.stringify({ payment_id: 'PAY-99', status: 'PAID' });
        const reserializado = JSON.stringify({ status: 'PAID', payment_id: 'PAY-99' });
        const req = fakeReq(reserializado, {
            Authorization: `V2-HMAC-SHA256, Signature: ${firmaDlocal(original)}`,
        });

        const r = await dlocal.verificarFirmaWebhook(req);
        expect(r.valida).toBe(false);
    });

    test('rechaza una firma inventada', async () => {
        const crudo = JSON.stringify({ payment_id: 'PAY-99' });
        const req = fakeReq(crudo, {
            Authorization: 'V2-HMAC-SHA256, Signature: ' + 'a'.repeat(64),
        });
        const r = await dlocal.verificarFirmaWebhook(req);
        expect(r.valida).toBe(false);
    });

    test('rechaza si no viene cabecera de firma', async () => {
        const r = await dlocal.verificarFirmaWebhook(fakeReq({ payment_id: 'PAY-99' }));
        expect(r.valida).toBe(false);
    });

    test('sin credenciales configuradas nunca da por válida una firma', async () => {
        delete process.env.DLOCAL_API_KEY;
        delete process.env.DLOCAL_SECRET_KEY;
        const crudo = JSON.stringify({ payment_id: 'PAY-99' });
        const req = fakeReq(crudo, {
            Authorization: `V2-HMAC-SHA256, Signature: ${firmaDlocal(crudo)}`,
        });

        const r = await dlocal.verificarFirmaWebhook(req);
        expect(r.valida).toBe(false);

        process.env.DLOCAL_API_KEY = DL_API_KEY;
        process.env.DLOCAL_SECRET_KEY = DL_SECRET;
    });
});

// ── El registro de adaptadores ──────────────────────────────────────────────────────────

describe('registro de adaptadores', () => {
    const { getAdaptador, getAdaptadorListo, estadoDeConfiguracion } = require('../../app_core/cobranza');

    test('las tres pasarelas tienen adaptador', () => {
        expect(estadoDeConfiguracion().map((a) => a.codigo).sort()).toEqual([
            'dlocal',
            'manual',
            'wompi',
        ]);
    });

    test('todos cumplen el mismo contrato', () => {
        for (const codigo of ['manual', 'dlocal', 'wompi']) {
            const a = getAdaptador(codigo);
            expect(typeof a.cobrar).toBe('function');
            expect(typeof a.consultarTransaccion).toBe('function');
            expect(typeof a.verificarFirmaWebhook).toBe('function');
            expect(typeof a.tokenizarMetodo).toBe('function');
            expect(typeof a.soportaRecurrente).toBe('boolean');
        }
    });

    test('una pasarela sin credenciales no se puede usar para cobrar', () => {
        const previo = process.env.WOMPI_PUBLIC_KEY;
        delete process.env.WOMPI_PUBLIC_KEY;

        expect(() => getAdaptadorListo('wompi')).toThrow(/credenciales/i);
        // Pero `manual` siempre está listo: no necesita llaves de nadie.
        expect(getAdaptadorListo('manual').codigo).toBe('manual');

        if (previo) process.env.WOMPI_PUBLIC_KEY = previo;
    });

    test('una pasarela inexistente falla con 501 y no con undefined', () => {
        expect(() => getAdaptador('paypal')).toThrow(/no está implementada/i);
    });
});
