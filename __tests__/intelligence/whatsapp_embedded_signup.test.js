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

    // ── Coexistencia y registro (2026-09-28) ──────────────────────────────────────────

    /** Un fetch que guarda lo que se le pidió y contesta en orden. */
    function fetchGrabador(...respuestas) {
        const llamadas = [];
        const impl = async (url, opciones = {}) => {
            llamadas.push({ url, opciones });
            const r = respuestas[Math.min(llamadas.length - 1, respuestas.length - 1)];
            return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => JSON.stringify(r.cuerpo) };
        };
        return { impl, llamadas };
    }

    test('listarNumeros() normaliza la lista y detecta la coexistencia (is_on_biz_app)', async () => {
        const f = fetchGrabador({
            cuerpo: {
                data: [
                    {
                        id: '111',
                        display_phone_number: '+57 323 638 8196',
                        verified_name: 'Mi Negocio',
                        platform_type: 'CLOUD_API',
                        is_on_biz_app: true,
                    },
                ],
            },
        });
        const r = await embeddedSignupApi.listarNumeros({ wabaId: 'W1', accessToken: 'T', fetchImpl: f.impl });
        expect(r).toEqual([
            {
                id: '111',
                numeroE164: '+57 323 638 8196',
                nombreVerificado: 'Mi Negocio',
                platformType: 'CLOUD_API',
                enAppBusiness: true,
            },
        ]);
        expect(f.llamadas[0].url).toContain('/W1/phone_numbers?fields=');
        expect(f.llamadas[0].url).toContain('is_on_biz_app');
    });

    test('listarNumeros() reintenta con los campos mínimos si Meta no reconoce uno (#100)', async () => {
        const f = fetchGrabador(
            { ok: false, status: 400, cuerpo: { error: { code: 100, message: 'nonexisting field' } } },
            { cuerpo: { data: [{ id: '222', display_phone_number: '+57 300', platform_type: 'NOT_APPLICABLE' }] } }
        );
        const r = await embeddedSignupApi.listarNumeros({ wabaId: 'W1', accessToken: 'T', fetchImpl: f.impl });
        expect(f.llamadas).toHaveLength(2);
        expect(f.llamadas[1].url).not.toContain('is_on_biz_app');
        expect(r[0]).toMatchObject({ id: '222', enAppBusiness: null, platformType: 'NOT_APPLICABLE' });
    });

    test('registrarNumero() manda messaging_product y el PIN en el cuerpo JSON', async () => {
        const f = fetchGrabador({ cuerpo: { success: true } });
        const r = await embeddedSignupApi.registrarNumero({
            phoneNumberId: '111',
            accessToken: 'T',
            pin: '012345',
            fetchImpl: f.impl,
        });
        expect(r).toEqual({ registrado: true });
        expect(f.llamadas[0].url).toContain('/111/register');
        expect(f.llamadas[0].opciones.method).toBe('POST');
        expect(JSON.parse(f.llamadas[0].opciones.body)).toEqual({ messaging_product: 'whatsapp', pin: '012345' });
    });

    test('registrarNumero() sin un PIN de 6 dígitos no llama a Meta', async () => {
        await expect(
            embeddedSignupApi.registrarNumero({ phoneNumberId: '111', accessToken: 'T', pin: '123' })
        ).rejects.toMatchObject({ code: 'META_REGISTRO_DATOS_INCOMPLETOS' });
    });

    test('registrarNumero() rechazado conserva el error de Meta en .detalle', async () => {
        const f = fetchGrabador({ ok: false, status: 400, cuerpo: { error: { code: 133005, message: 'PIN mismatch' } } });
        await expect(
            embeddedSignupApi.registrarNumero({ phoneNumberId: '111', accessToken: 'T', pin: '000000', fetchImpl: f.impl })
        ).rejects.toMatchObject({ code: 'META_REGISTRO_FALLIDO', detalle: { code: 133005 } });
    });

    test('solicitarSincronizacion() pide smb_app_data con el sync_type', async () => {
        const f = fetchGrabador({ cuerpo: { messaging_product: 'whatsapp', request_id: 'REQ-1' } });
        const r = await embeddedSignupApi.solicitarSincronizacion({
            phoneNumberId: '111',
            accessToken: 'T',
            tipo: 'history',
            fetchImpl: f.impl,
        });
        expect(r).toEqual({ solicitado: true, idSolicitud: 'REQ-1' });
        expect(f.llamadas[0].url).toContain('/111/smb_app_data');
        expect(JSON.parse(f.llamadas[0].opciones.body)).toEqual({ messaging_product: 'whatsapp', sync_type: 'history' });
    });

    test('solicitarSincronizacion() con un tipo desconocido no llama a Meta', async () => {
        await expect(
            embeddedSignupApi.solicitarSincronizacion({ phoneNumberId: '111', accessToken: 'T', tipo: 'todo' })
        ).rejects.toMatchObject({ code: 'META_SINCRONIZACION_DATOS_INCOMPLETOS' });
    });

    test('desuscribirApp() usa DELETE sobre subscribed_apps', async () => {
        const f = fetchGrabador({ cuerpo: { success: true } });
        const r = await embeddedSignupApi.desuscribirApp({ wabaId: 'W1', accessToken: 'T', fetchImpl: f.impl });
        expect(r).toEqual({ desuscrito: true });
        expect(f.llamadas[0].url).toContain('/W1/subscribed_apps');
        expect(f.llamadas[0].opciones.method).toBe('DELETE');
    });
});

// ── elegirNumero (pura): qué número de la WABA se está conectando ──────────────────────

describe('canalEmbeddedSignup.elegirNumero', () => {
    const { elegirNumero } = require('../../app_core/whatsapp/canalEmbeddedSignup');
    const n = (id, extra = {}) => ({ id, numeroE164: `+57 ${id}`, platformType: null, enAppBusiness: null, ...extra });

    test('con el id del navegador y la lista de Meta, devuelve el de la lista (datos de Meta, no del navegador)', () => {
        const r = elegirNumero({ numeros: [n('1'), n('2', { enAppBusiness: true })], phoneNumberId: '2', modo: 'nuevo' });
        expect(r).toMatchObject({ id: '2', enAppBusiness: true });
    });

    test('un id que no está en la WABA concedida se rechaza — el navegador no decide qué número es', () => {
        expect(() => elegirNumero({ numeros: [n('1')], phoneNumberId: '999', modo: 'nuevo' })).toThrow(
            expect.objectContaining({ code: 'CANAL_NUMERO_NO_CONCEDIDO', statusCode: 400 })
        );
    });

    test('sin id del navegador y un solo número, ese es', () => {
        expect(elegirNumero({ numeros: [n('7')], phoneNumberId: null, modo: 'coexistencia' }).id).toBe('7');
    });

    test('sin id, en coexistencia, prefiere el único que está en la app Business', () => {
        const r = elegirNumero({
            numeros: [n('1', { enAppBusiness: false }), n('2', { enAppBusiness: true })],
            phoneNumberId: null,
            modo: 'coexistencia',
        });
        expect(r.id).toBe('2');
    });

    test('sin id y varios candidatos: no se adivina', () => {
        expect(() => elegirNumero({ numeros: [n('1'), n('2')], phoneNumberId: null, modo: 'nuevo' })).toThrow(
            expect.objectContaining({ code: 'CANAL_NUMERO_AMBIGUO' })
        );
    });

    test('WABA sin números (FINISH_ONLY_WABA): mensaje enseñable', () => {
        expect(() => elegirNumero({ numeros: [], phoneNumberId: null, modo: 'coexistencia' })).toThrow(
            expect.objectContaining({ code: 'CANAL_SIN_NUMERO', statusCode: 422 })
        );
    });

    test('sin lista (Meta no contestó): sigue con el id del navegador; sin él, falla', () => {
        expect(elegirNumero({ numeros: null, phoneNumberId: '5', modo: 'nuevo' }).id).toBe('5');
        expect(() => elegirNumero({ numeros: null, phoneNumberId: null, modo: 'nuevo' })).toThrow(
            expect.objectContaining({ code: 'CANAL_NUMERO_NO_RESUELTO' })
        );
    });
});

// ── interpretarWebhook (pura): lo que trae la coexistencia ─────────────────────────────

describe('interpretarWebhook — coexistencia', () => {
    const { interpretarWebhook } = require('../../intelligence/channels/whatsapp/adaptador');
    const config = {
        resolverNegocio: (id) => (id === 'PHONE-C' ? 42 : null),
        resolverNegocioPorWaba: (waba) => (waba === 'WABA-C' ? 42 : null),
    };
    const webhook = (field, value, wabaId = 'WABA-C') => ({
        object: 'whatsapp_business_account',
        entry: [{ id: wabaId, changes: [{ field, value }] }],
    });

    test('account_update SIN metadata (la forma real de Meta) se atribuye por la WABA', () => {
        const r = interpretarWebhook(
            webhook('account_update', {
                phone_number: '573236388196',
                event: 'PARTNER_REMOVED',
                disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
            }),
            { config }
        );
        expect(r.ajenos).toBe(0);
        expect(r.avisos).toEqual([
            expect.objectContaining({ idNegocio: 42, evento: 'PARTNER_REMOVED', motivo: 'PRIMARY_INACTIVITY' }),
        ]);
    });

    test('account_update de una WABA desconocida sigue siendo ajeno', () => {
        const r = interpretarWebhook(webhook('account_update', { event: 'PARTNER_REMOVED' }, 'OTRA'), { config });
        expect(r.ajenos).toBe(1);
        expect(r.avisos).toEqual([]);
    });

    test('un config sin resolverNegocioPorWaba (antiguo) no revienta', () => {
        const r = interpretarWebhook(webhook('account_update', { event: 'PARTNER_REMOVED' }), {
            config: { resolverNegocio: () => null },
        });
        expect(r.ajenos).toBe(1);
    });

    test('el historial de la app NO entra como mensajes del cliente — solo se cuenta', () => {
        const r = interpretarWebhook(
            webhook('history', {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'PHONE-C' },
                history: [
                    {
                        metadata: { phase: 0, chunk_order: 1, progress: 100 },
                        threads: [
                            { id: '573001112233', messages: [{ from: '573001112233', id: 'w1', type: 'text', text: { body: 'hola' } }, { id: 'w2' }] },
                            { id: '573004445566', messages: [{ id: 'w3' }] },
                        ],
                    },
                ],
            }),
            { config }
        );
        expect(r.mensajes).toEqual([]);
        expect(r.sincronizaciones).toEqual([
            expect.objectContaining({ idNegocio: 42, tipo: 'historial', progreso: 100, hilos: 2, mensajes: 3, error: null }),
        ]);
    });

    test('historial rechazado por el dueño (2593109) se reporta como error, sin mensajes', () => {
        const r = interpretarWebhook(
            webhook('history', {
                metadata: { phone_number_id: 'PHONE-C' },
                history: [{ errors: [{ code: 2593109, title: 'History sync declined' }] }],
            }),
            { config }
        );
        expect(r.sincronizaciones[0]).toMatchObject({ tipo: 'historial', error: { codigo: 2593109 } });
    });

    test('los contactos de la app (smb_app_state_sync) se cuentan', () => {
        const r = interpretarWebhook(
            webhook('smb_app_state_sync', {
                metadata: { phone_number_id: 'PHONE-C' },
                state_sync: [
                    { type: 'contact', contact: { full_name: 'Ana', phone_number: '573001112233' }, action: 'add' },
                    { type: 'contact', contact: { phone_number: '573009998877' }, action: 'remove' },
                ],
            }),
            { config }
        );
        expect(r.mensajes).toEqual([]);
        expect(r.sincronizaciones).toEqual([
            expect.objectContaining({ tipo: 'contactos', contactos: 2, altas: 1, bajas: 1 }),
        ]);
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

    /**
     * Doble de la Graph API. Sin `listarNumeros` a propósito (salvo que un test lo pase): así se
     * ejercita el camino de «Meta no devolvió la lista», que sigue con el id del navegador.
     * `llamadas` registra qué se pidió, para comprobar lo que NO debe pasar (p. ej. `/register`
     * en coexistencia).
     */
    const apiFalsa = (over = {}) => {
        const llamadas = [];
        const grabar = (nombre, respuesta) => async (args) => {
            llamadas.push({ nombre, args });
            return typeof respuesta === 'function' ? respuesta(args) : respuesta;
        };
        return {
            llamadas,
            canjearCodigo: grabar('canjearCodigo', { accessToken: 'TOKEN-DE-PRUEBA' }),
            resolverWaba: grabar('resolverWaba', { wabaId: 'WABA-DE-PRUEBA' }),
            resolverNumero: grabar('resolverNumero', { numeroE164: '+57 300 000 0000' }),
            suscribirApp: grabar('suscribirApp', { suscrito: true }),
            desuscribirApp: grabar('desuscribirApp', { desuscrito: true }),
            registrarNumero: grabar('registrarNumero', { registrado: true }),
            solicitarSincronizacion: grabar('solicitarSincronizacion', { solicitado: true, idSolicitud: 'R' }),
            ...over,
        };
    };
    const nombres = (api) => api.llamadas.map((l) => l.nombre);

    beforeAll(async () => {
        const fila = await sequelize.query(
            `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 1;`,
            { type: sequelize.QueryTypes.SELECT }
        );
        if (!fila[0]) throw new Error('No hay negocio activo. Corre scripts/seed_dev_local.js.');
        idNegocio = fila[0].id_negocio;
    });

    afterEach(async () => {
        await sequelize.query(
            `DELETE FROM platform.numero_canal
              WHERE id_negocio = :idNegocio OR id_externo LIKE 'PHONE-%';`,
            { replacements: { idNegocio }, logging: false }
        );
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
            coexistencia: false,
            sincronizacion: null,
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
        expect(resultado).toMatchObject({ idExterno: 'PHONE-1B', numeroE164: null, wabaId: 'WABA-DE-PRUEBA' });
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

    // ── Coexistencia y número dedicado (2026-09-28) ──────────────────────────────────────

    const leerFila = async (idExterno) =>
        (
            await sequelize.query(
                `SELECT id_negocio, estado, coexistencia, pin_cifrado, token_cifrado, numero_e164
                   FROM platform.numero_canal WHERE id_externo = :idExterno;`,
                { replacements: { idExterno }, type: sequelize.QueryTypes.SELECT }
            )
        )[0];

    test(
        'coexistencia: NO registra el número, pide contactos + historial y lo guarda como coexistencia',
        async () => {
            const api = apiFalsa({
                listarNumeros: async () => [
                    { id: 'PHONE-CX', numeroE164: '+57 323 638 8196', platformType: 'CLOUD_API', enAppBusiness: true },
                ],
            });
            // Sin phoneNumberId: el evento FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING puede no traerlo.
            const r = await canalEmbeddedSignup.conectar({ idNegocio, code: 'c', modo: 'coexistencia', api });

            expect(r).toMatchObject({
                idExterno: 'PHONE-CX',
                numeroE164: '+57 323 638 8196',
                coexistencia: true,
                sincronizacion: { contactos: true, historial: true },
            });
            expect(nombres(api)).not.toContain('registrarNumero');
            expect(api.llamadas.filter((l) => l.nombre === 'solicitarSincronizacion').map((l) => l.args.tipo)).toEqual([
                'smb_app_state_sync',
                'history',
            ]);

            const fila = await leerFila('PHONE-CX');
            expect(fila).toMatchObject({ estado: 'A', coexistencia: true, pin_cifrado: null });

            const estado = await canalEmbeddedSignup.obtenerEstado({ idNegocio });
            expect(estado).toMatchObject({ conectado: true, coexistencia: true, numeroE164: '+57 323 638 8196' });

            await numeros.asegurarCargado({ forzar: true });
            expect(numeros.coexistenciaDeNegocio(idNegocio)).toBe(true);
            expect(numeros.negocioDeWaba('WABA-DE-PRUEBA')).toBe(idNegocio);
        },
        15000
    );

    test('coexistencia: si la sincronización falla, la conexión queda hecha igual', async () => {
        const api = apiFalsa({
            listarNumeros: async () => [{ id: 'PHONE-CX2', numeroE164: '+57 1', platformType: 'CLOUD_API', enAppBusiness: true }],
            solicitarSincronizacion: async () => {
                throw new Error('fuera de las 24 h');
            },
        });
        const r = await canalEmbeddedSignup.conectar({ idNegocio, code: 'c', modo: 'coexistencia', api });
        expect(r).toMatchObject({ coexistencia: true, sincronizacion: { contactos: false, historial: false } });
        expect((await leerFila('PHONE-CX2')).estado).toBe('A');
    });

    test('Meta manda sobre el modo pedido: pidió «nuevo» pero el número está en la app → coexistencia', async () => {
        const api = apiFalsa({
            listarNumeros: async () => [{ id: 'PHONE-CX3', numeroE164: '+57 2', platformType: 'CLOUD_API', enAppBusiness: true }],
        });
        const r = await canalEmbeddedSignup.conectar({ idNegocio, code: 'c', phoneNumberId: 'PHONE-CX3', modo: 'nuevo', api });
        expect(r.coexistencia).toBe(true);
        expect(nombres(api)).not.toContain('registrarNumero');
    });

    test('número dedicado sin registrar: se registra con un PIN de 6 dígitos que queda cifrado', async () => {
        const api = apiFalsa({
            listarNumeros: async () => [
                { id: 'PHONE-NV', numeroE164: '+57 3', platformType: 'NOT_APPLICABLE', enAppBusiness: false },
            ],
        });
        const r = await canalEmbeddedSignup.conectar({ idNegocio, code: 'c', phoneNumberId: 'PHONE-NV', modo: 'nuevo', api });
        expect(r).toMatchObject({ coexistencia: false, sincronizacion: null });

        const registro = api.llamadas.find((l) => l.nombre === 'registrarNumero');
        expect(registro.args.phoneNumberId).toBe('PHONE-NV');
        expect(registro.args.pin).toMatch(/^\d{6}$/);

        const fila = await leerFila('PHONE-NV');
        expect(fila.coexistencia).toBe(false);
        expect(descifrar(fila.pin_cifrado)).toBe(registro.args.pin);
    });

    test('número dedicado ya en la Cloud API (platform_type CLOUD_API): no se vuelve a registrar', async () => {
        const api = apiFalsa({
            listarNumeros: async () => [{ id: 'PHONE-NV2', numeroE164: '+57 4', platformType: 'CLOUD_API', enAppBusiness: false }],
        });
        await canalEmbeddedSignup.conectar({ idNegocio, code: 'c', phoneNumberId: 'PHONE-NV2', api });
        expect(nombres(api)).not.toContain('registrarNumero');
    });

    test('reconectar el mismo número dedicado reutiliza su PIN (otro distinto daría 133005)', async () => {
        const lista = async () => [{ id: 'PHONE-NV3', numeroE164: '+57 5', platformType: 'NOT_APPLICABLE', enAppBusiness: false }];
        const api1 = apiFalsa({ listarNumeros: lista });
        await canalEmbeddedSignup.conectar({ idNegocio, code: 'c', phoneNumberId: 'PHONE-NV3', api: api1 });
        const pin1 = api1.llamadas.find((l) => l.nombre === 'registrarNumero').args.pin;

        await canalEmbeddedSignup.desconectar({ idNegocio, motivo: 'prueba' });

        const api2 = apiFalsa({ listarNumeros: lista });
        await canalEmbeddedSignup.conectar({ idNegocio, code: 'c', phoneNumberId: 'PHONE-NV3', api: api2 });
        expect(api2.llamadas.find((l) => l.nombre === 'registrarNumero').args.pin).toBe(pin1);
    });

    test('si /register falla, no queda ninguna fila y el error es enseñable (PIN previo → 133005)', async () => {
        const api = apiFalsa({
            listarNumeros: async () => [{ id: 'PHONE-NV4', numeroE164: '+57 6', platformType: 'NOT_APPLICABLE', enAppBusiness: false }],
            registrarNumero: async () => {
                const e = new Error('Meta rechazó');
                e.code = 'META_REGISTRO_FALLIDO';
                e.detalle = { code: 133005 };
                throw e;
            },
        });
        await expect(
            canalEmbeddedSignup.conectar({ idNegocio, code: 'c', phoneNumberId: 'PHONE-NV4', api })
        ).rejects.toMatchObject({ code: 'META_REGISTRO_FALLIDO', statusCode: 502, message: expect.stringContaining('verificación en dos pasos') });
        expect(await leerFila('PHONE-NV4')).toBeUndefined();
    });

    test('un phoneNumberId que no está en la WABA concedida no se guarda', async () => {
        const api = apiFalsa({ listarNumeros: async () => [{ id: 'PHONE-OK', numeroE164: null, platformType: 'CLOUD_API', enAppBusiness: true }] });
        await expect(
            canalEmbeddedSignup.conectar({ idNegocio, code: 'c', phoneNumberId: 'PHONE-AJENO', api })
        ).rejects.toMatchObject({ code: 'CANAL_NUMERO_NO_CONCEDIDO' });
        expect(nombres(api)).not.toContain('suscribirApp');
    });

    test('el mismo número activo en OTRO negocio: 409, y no se le quita', async () => {
        const otro = await sequelize.query(
            `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' AND id_negocio <> :idNegocio
              ORDER BY id_negocio LIMIT 1;`,
            { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
        );
        if (!otro[0]) return; // una base con un solo negocio no puede probar esto
        await sequelize.query(
            `INSERT INTO platform.numero_canal (canal, id_externo, id_negocio, estado, origen)
             VALUES ('whatsapp', 'PHONE-OTRO', :otro, 'A', 'embedded_signup');`,
            { replacements: { otro: otro[0].id_negocio } }
        );
        const api = apiFalsa();
        await expect(
            canalEmbeddedSignup.conectar({ idNegocio, code: 'c', phoneNumberId: 'PHONE-OTRO', api })
        ).rejects.toMatchObject({ code: 'CANAL_NUMERO_EN_OTRO_NEGOCIO', statusCode: 409 });
        expect((await leerFila('PHONE-OTRO')).id_negocio).toBe(otro[0].id_negocio);
        expect(nombres(api)).not.toContain('suscribirApp');
    });

    test('desconectar desde el panel quita la suscripción en Meta con el token, y luego lo borra', async () => {
        await canalEmbeddedSignup.conectar({ idNegocio, code: 'c', phoneNumberId: 'PHONE-DS', api: apiFalsa() });
        const api = apiFalsa();
        const r = await canalEmbeddedSignup.desconectar({ idNegocio, desuscribir: true, api });
        expect(r).toEqual({ desconectado: true });
        const des = api.llamadas.find((l) => l.nombre === 'desuscribirApp');
        expect(des.args).toEqual({ wabaId: 'WABA-DE-PRUEBA', accessToken: 'TOKEN-DE-PRUEBA' });
        expect(await leerFila('PHONE-DS')).toMatchObject({ estado: 'I', token_cifrado: null });
    });

    test('desconectar: si Meta falla al desuscribir, la desconexión local sigue', async () => {
        await canalEmbeddedSignup.conectar({ idNegocio, code: 'c', phoneNumberId: 'PHONE-DS2', api: apiFalsa() });
        const api = apiFalsa({
            desuscribirApp: async () => {
                throw new Error('Meta caído');
            },
        });
        expect(await canalEmbeddedSignup.desconectar({ idNegocio, desuscribir: true, api })).toEqual({ desconectado: true });
    });

    test(
        'account_update con la forma REAL de Meta (sin metadata, solo entry.id = WABA) revoca la fila',
        async () => {
            await canalEmbeddedSignup.conectar({ idNegocio, code: 'c1', phoneNumberId: 'PHONE-6', api: apiFalsa() });
            await numeros.asegurarCargado({ forzar: true });

            await adaptador.recibirWebhook(
                {
                    object: 'whatsapp_business_account',
                    entry: [
                        {
                            id: 'WABA-DE-PRUEBA',
                            changes: [
                                {
                                    field: 'account_update',
                                    value: {
                                        phone_number: '573000000000',
                                        event: 'PARTNER_REMOVED',
                                        disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
                                    },
                                },
                            ],
                        },
                    ],
                },
                { config }
            );

            expect(await leerFila('PHONE-6')).toMatchObject({ estado: 'I', token_cifrado: null });

            // Y el negocio se entera por la campana: el número es suyo y solo él puede reconectarlo.
            const aviso = await sequelize.query(
                `SELECT titulo, mensaje FROM general.gener_notificacion
                  WHERE id_negocio = :idNegocio AND tipo = 'WHATSAPP_DESCONECTADO'
                  ORDER BY id_notificacion DESC LIMIT 1;`,
                { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
            );
            expect(aviso[0].mensaje).toContain('14 días');
            await sequelize.query(
                `DELETE FROM general.gener_notificacion WHERE id_negocio = :idNegocio AND tipo = 'WHATSAPP_DESCONECTADO';`,
                { replacements: { idNegocio } }
            );
        },
        15000
    );
});
