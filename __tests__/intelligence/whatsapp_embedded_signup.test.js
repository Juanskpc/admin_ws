/**
 * Embedded Signup + Coexistencia (F8-D, Opción B del panel) — lo nuevo desde que un negocio
 * puede traer su propio número en vez de depender siempre de la WABA nuestra.
 *
 * Tres capas, tres formas de probarlas:
 *   - `credencialCifrada`: pura, sin base ni red.
 *   - `embeddedSignupApi`: pura, con `fetch` inyectado — igual que `api.js` se prueba en
 *     `whatsapp.test.js`.
 *   - `canalEmbeddedSignup` + `numeros.js`/`config.js`: contra la base de verdad, porque lo que
 *     importa es que una fila escrita por el servicio la lea correctamente la caché del canal —
 *     con dobles se probaría la forma, no la costura real entre `app_core` e `intelligence`.
 */
'use strict';

require('dotenv').config();
if (!process.env.WHATSAPP_TOKEN_KEY) {
    process.env.WHATSAPP_TOKEN_KEY = require('crypto').randomBytes(32).toString('base64');
}

const { cifrar, descifrar } = require('../../app_core/helpers/credencialCifrada');
const embeddedSignupApi = require('../../app_core/whatsapp/embeddedSignupApi');

// ── credencialCifrada (pura) ────────────────────────────────────────────────────────────

describe('credencialCifrada', () => {
    test('cifra y descifra el mismo texto', () => {
        const original = 'EAAG_token_de_prueba';
        expect(descifrar(cifrar(original))).toBe(original);
    });

    test('rechaza descifrar con la clave equivocada, sin decir cuál de las dos falló', () => {
        const cifrado = cifrar('algo');
        const claveOriginal = process.env.WHATSAPP_TOKEN_KEY;
        process.env.WHATSAPP_TOKEN_KEY = require('crypto').randomBytes(32).toString('base64');
        try {
            expect(() => descifrar(cifrado)).toThrow(
                expect.objectContaining({ code: 'CIFRADO_FALLO_VERIFICACION' })
            );
        } finally {
            process.env.WHATSAPP_TOKEN_KEY = claveOriginal;
        }
    });

    test('sin WHATSAPP_TOKEN_KEY, cifrar() falla con un código reconocible', () => {
        const claveOriginal = process.env.WHATSAPP_TOKEN_KEY;
        delete process.env.WHATSAPP_TOKEN_KEY;
        try {
            expect(() => cifrar('x')).toThrow(expect.objectContaining({ code: 'CIFRADO_CLAVE_FALTANTE' }));
        } finally {
            process.env.WHATSAPP_TOKEN_KEY = claveOriginal;
        }
    });
});

// ── embeddedSignupApi (pura, fetch inyectado) ───────────────────────────────────────────

describe('embeddedSignupApi', () => {
    const fetchOk = (cuerpo) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(cuerpo) });
    const fetchMal = (status, cuerpo) => async () => ({ ok: false, status, text: async () => JSON.stringify(cuerpo) });

    test('canjearCodigo() devuelve el access_token', async () => {
        const r = await embeddedSignupApi.canjearCodigo({
            code: 'abc',
            appId: '111',
            appSecret: 'sss',
            fetchImpl: fetchOk({ access_token: 'TOKEN123', expires_in: 5184000 }),
        });
        expect(r).toEqual({ accessToken: 'TOKEN123', expiresIn: 5184000 });
    });

    test('canjearCodigo() con un code caducado falla con META_CANJE_FALLIDO, no reintentable', async () => {
        await expect(
            embeddedSignupApi.canjearCodigo({
                code: 'viejo',
                appId: '111',
                appSecret: 'sss',
                fetchImpl: fetchMal(400, { error: { message: 'code caducado' } }),
            })
        ).rejects.toMatchObject({ code: 'META_CANJE_FALLIDO', statusCode: 502, reintentable: false });
    });

    test('resolverWaba() lee la WABA concedida del propio token (debug_token)', async () => {
        const r = await embeddedSignupApi.resolverWaba({
            accessToken: 'TOKEN123',
            appId: '111',
            appSecret: 'sss',
            fetchImpl: fetchOk({
                data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['WABA789'] }] },
            }),
        });
        expect(r).toEqual({ wabaId: 'WABA789' });
    });

    test('resolverWaba() sin ningún activo concedido falla — tener el permiso no es tener el activo', async () => {
        await expect(
            embeddedSignupApi.resolverWaba({
                accessToken: 'TOKEN123',
                appId: '111',
                appSecret: 'sss',
                fetchImpl: fetchOk({ data: { granular_scopes: [] } }),
            })
        ).rejects.toMatchObject({ code: 'META_RESOLVER_WABA_SIN_ACTIVO' });
    });

    test('suscribirApp() reporta si Meta aceptó la suscripción', async () => {
        const r = await embeddedSignupApi.suscribirApp({
            wabaId: 'WABA789',
            accessToken: 'TOKEN123',
            fetchImpl: fetchOk({ success: true }),
        });
        expect(r).toEqual({ suscrito: true });
    });

    // El evento WA_EMBEDDED_SIGNUP/FINISH del navegador no trae display_phone_number (probado en
    // producción el 2026-09-19) — resolverNumero() es la llamada aparte que lo consigue de verdad.
    test('resolverNumero() devuelve el número legible a partir del phone_number_id', async () => {
        const r = await embeddedSignupApi.resolverNumero({
            phoneNumberId: 'PHONE-1',
            accessToken: 'TOKEN123',
            fetchImpl: fetchOk({ display_phone_number: '+57 315 281 2484' }),
        });
        expect(r).toEqual({ numeroE164: '+57 315 281 2484' });
    });

    test('resolverNumero() sin phoneNumberId o accessToken falla sin llamar a Meta', async () => {
        await expect(
            embeddedSignupApi.resolverNumero({ phoneNumberId: null, accessToken: 'TOKEN123' })
        ).rejects.toMatchObject({ code: 'META_RESOLVER_NUMERO_DATOS_INCOMPLETOS' });
    });
});

// ── canalEmbeddedSignup + numeros.js/config.js: contra la base de verdad ───────────────

describe('canalEmbeddedSignup — conecta, y el canal lo lee de verdad', () => {
    const Models = require('../../app_core/models/conection');
    const sequelize = Models.sequelize;
    const canalEmbeddedSignup = require('../../app_core/whatsapp/canalEmbeddedSignup');
    const numeros = require('../../intelligence/channels/whatsapp/numeros');
    const config = require('../../intelligence/channels/whatsapp/config');
    const adaptador = require('../../intelligence/channels/whatsapp/adaptador');

    let idNegocio;

    const apiFalsa = (over = {}) => ({
        canjearCodigo: async () => ({ accessToken: 'TOKEN-DE-PRUEBA' }),
        resolverWaba: async () => ({ wabaId: 'WABA-DE-PRUEBA' }),
        resolverNumero: async () => ({ numeroE164: '+57 300 000 0000' }),
        suscribirApp: async () => ({ suscrito: true }),
        ...over,
    });

    beforeAll(async () => {
        const fila = await sequelize.query(
            `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 1;`,
            { type: sequelize.QueryTypes.SELECT }
        );
        if (!fila[0]) throw new Error('No hay negocio activo. Corre scripts/seed_dev_local.js.');
        idNegocio = fila[0].id_negocio;
    });

    afterEach(async () => {
        await sequelize.query(`DELETE FROM platform.numero_canal WHERE id_negocio = :idNegocio;`, {
            replacements: { idNegocio },
            logging: false,
        });
        numeros._reiniciar();
    });

    afterAll(async () => {
        await sequelize.close();
    });

    test('conectar() guarda el token cifrado, y numeros.js/config.js lo leen tras recargar', async () => {
        const resultado = await canalEmbeddedSignup.conectar({
            idNegocio,
            code: 'code-1',
            phoneNumberId: 'PHONE-1',
            api: apiFalsa(),
        });
        expect(resultado).toEqual({
            idExterno: 'PHONE-1',
            numeroE164: '+57 300 000 0000',
            wabaId: 'WABA-DE-PRUEBA',
        });

        await numeros.asegurarCargado({ forzar: true });
        expect(numeros.negocioDe('PHONE-1')).toBe(idNegocio);
        expect(numeros.numeroDe(idNegocio)).toBe('PHONE-1');
        expect(numeros.origenDeNegocio(idNegocio)).toBe('embedded_signup');
        expect(numeros.tokenDeNegocio(idNegocio)).toBe('TOKEN-DE-PRUEBA');
        expect(config.tokenDeNegocio(idNegocio)).toBe('TOKEN-DE-PRUEBA');
    });

    test('conectar() guarda el businessId que manda el frontend — resolverWaba() ya no lo inventa', async () => {
        await canalEmbeddedSignup.conectar({
            idNegocio,
            code: 'code-1',
            phoneNumberId: 'PHONE-1C',
            businessId: 'BIZ-DEL-EVENTO-DEL-NAVEGADOR',
            api: apiFalsa(),
        });

        const fila = await sequelize.query(
            `SELECT waba_id, business_id FROM platform.numero_canal WHERE id_negocio = :idNegocio;`,
            { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
        );
        expect(fila[0]).toEqual({ waba_id: 'WABA-DE-PRUEBA', business_id: 'BIZ-DEL-EVENTO-DEL-NAVEGADOR' });
    });

    test('conectar() no se aborta si resolverNumero() falla — sigue con numeroE164 en null', async () => {
        const resultado = await canalEmbeddedSignup.conectar({
            idNegocio,
            code: 'code-1',
            phoneNumberId: 'PHONE-1B',
            api: apiFalsa({
                resolverNumero: async () => {
                    throw new Error('Meta caído, o lo que sea');
                },
            }),
        });
        expect(resultado).toEqual({ idExterno: 'PHONE-1B', numeroE164: null, wabaId: 'WABA-DE-PRUEBA' });
    });

    test('conectar() dos veces para el mismo negocio rechaza con CANAL_YA_CONECTADO (409)', async () => {
        await canalEmbeddedSignup.conectar({ idNegocio, code: 'c1', phoneNumberId: 'PHONE-2', api: apiFalsa() });
        await expect(
            canalEmbeddedSignup.conectar({ idNegocio, code: 'c2', phoneNumberId: 'PHONE-3', api: apiFalsa() })
        ).rejects.toMatchObject({ code: 'CANAL_YA_CONECTADO', statusCode: 409 });
    });

    test('obtenerEstado() y desconectar(): tras desconectar, ya no se reporta conectado', async () => {
        await canalEmbeddedSignup.conectar({ idNegocio, code: 'c1', phoneNumberId: 'PHONE-4', api: apiFalsa() });

        let estado = await canalEmbeddedSignup.obtenerEstado({ idNegocio });
        expect(estado).toMatchObject({ conectado: true, origen: 'embedded_signup' });

        const resultado = await canalEmbeddedSignup.desconectar({ idNegocio, motivo: 'PRIMARY_INACTIVITY' });
        expect(resultado).toEqual({ desconectado: true });

        estado = await canalEmbeddedSignup.obtenerEstado({ idNegocio });
        expect(estado.conectado).toBe(false);
    });

    test('desconectar() sin nada que desconectar devuelve desconectado:false — para el 409 del botón del panel', async () => {
        const resultado = await canalEmbeddedSignup.desconectar({ idNegocio, motivo: 'sin conexión' });
        expect(resultado).toEqual({ desconectado: false });
    });

    test(
        'un webhook account_update / PARTNER_REMOVED revoca la fila SOLO si origen=embedded_signup',
        async () => {
            await canalEmbeddedSignup.conectar({ idNegocio, code: 'c1', phoneNumberId: 'PHONE-5', api: apiFalsa() });
            await numeros.asegurarCargado({ forzar: true });

            const cuerpo = {
                object: 'whatsapp_business_account',
                entry: [
                    {
                        id: 'waba-x',
                        changes: [
                            {
                                field: 'account_update',
                                value: {
                                    metadata: { phone_number_id: 'PHONE-5' },
                                    event: 'PARTNER_REMOVED',
                                    disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'BUSINESS' },
                                    phone_number: 'PHONE-5',
                                },
                            },
                        ],
                    },
                ],
            };

            await adaptador.recibirWebhook(cuerpo, { config });

            const fila = await sequelize.query(
                `SELECT estado, token_cifrado FROM platform.numero_canal WHERE id_negocio = :idNegocio;`,
                { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
            );
            expect(fila[0].estado).toBe('I');
            expect(fila[0].token_cifrado).toBeNull();
        },
        15000
    );
});
