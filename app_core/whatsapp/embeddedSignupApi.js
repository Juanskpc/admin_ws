/**
 * Cliente de la Graph API de Meta para Embedded Signup — canje de `code`, resolución de la WABA
 * concedida, suscripción de la app.
 *
 * ## Por qué esto no vive en `intelligence/channels/whatsapp/api.js`
 *
 * Ese archivo habla con la **Cloud API de mensajería** (enviar un mensaje, con el token de sistema
 * que cubre nuestra WABA) y `intelligence/` se monta con guarda (`fs.existsSync`, el "test del
 * apagón" de ADR-005) — borrar el directorio no puede tumbar nada fuera de él. Este archivo habla
 * con la **Graph API de Business Management** (OAuth de un cliente, gestión de SU WABA) y lo llama
 * `app_admin_api`, que se monta sin guarda. Si viviera dentro de `intelligence/`, un `require`
 * desde `app_admin_api` rompería esa garantía. Por eso vive en `app_core/`, la capa neutral de la
 * que ya dependen los dos (igual que `numeros.js` ya hace `require('.../app_core/models/conection')`
 * en la otra dirección).
 *
 * El patrón (fetch inyectable, `AbortController`, error tipado `reintentable`) es el mismo que
 * `intelligence/channels/whatsapp/api.js` — se replica a propósito, no se importa.
 *
 * ⚠️ `resolverWaba()` usa `debug_token`, que es lo que ya usa `scripts/whatsapp_diagnostico.js`
 * para inspeccionar un token de usuario. Revisar el contrato exacto de **Embedded Signup v4**
 * (obligatorio desde el 15 de octubre de 2026, ver `docs/embedded-signup.md` §3) antes de dar esto
 * por definitivo — la forma de las tres funciones no depende de esa revisión, el detalle interno sí.
 */
'use strict';

const TIMEOUT_MS = Number(process.env.WHATSAPP_TIMEOUT_MS) || 8000;
const VERSION_API = process.env.WHATSAPP_API_VERSION || 'v21.0';
const BASE_URL = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com';

function fallo(mensaje, { code, statusCode, reintentable, detalle }) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode ?? null;
    e.reintentable = Boolean(reintentable);
    e.detalle = detalle ?? null;
    return e;
}

async function llamar(url, { fetchImpl = globalThis.fetch, metodo = 'GET' } = {}) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
    let respuesta;
    try {
        respuesta = await fetchImpl(url, { method: metodo, signal: control.signal });
    } catch (error) {
        throw fallo(`No se pudo llamar a la Graph API: ${error.message}`, {
            code: 'META_RED',
            reintentable: true,
        });
    } finally {
        clearTimeout(reloj);
    }

    const texto = await respuesta.text();
    let datos = null;
    try {
        datos = texto ? JSON.parse(texto) : null;
    } catch {
        datos = { crudo: texto.slice(0, 500) };
    }
    return { ok: respuesta.ok, status: respuesta.status, datos };
}

/**
 * Canjea el `code` de corta vida que devuelve el SDK de Embedded Signup por un token de acceso.
 *
 * @returns {Promise<{accessToken: string, expiresIn: number|null}>}
 */
async function canjearCodigo({
    code,
    appId = process.env.WHATSAPP_APP_ID,
    appSecret = process.env.WHATSAPP_APP_SECRET,
    fetchImpl = globalThis.fetch,
    baseUrl = BASE_URL,
    versionApi = VERSION_API,
}) {
    if (!code || !appId || !appSecret) {
        throw fallo('Faltan datos para canjear el code (code, appId o appSecret).', {
            code: 'META_CANJE_DATOS_INCOMPLETOS',
            statusCode: 400,
            reintentable: false,
        });
    }

    const url =
        `${baseUrl}/${versionApi}/oauth/access_token` +
        `?client_id=${encodeURIComponent(appId)}` +
        `&client_secret=${encodeURIComponent(appSecret)}` +
        `&code=${encodeURIComponent(code)}`;

    const { ok, status, datos } = await llamar(url, { fetchImpl });

    if (!ok) {
        // Un code caducado o ya usado no se arregla reintentando con el mismo — Meta lo rechaza
        // siempre igual (regla de los 30 segundos: el frontend debe pedir uno nuevo).
        throw fallo(
            `Meta rechazó el canje del code (${status}): ${datos?.error?.message || 'sin detalle'}`,
            { code: 'META_CANJE_FALLIDO', statusCode: 502, reintentable: false, detalle: datos?.error }
        );
    }

    if (!datos?.access_token) {
        throw fallo('Meta aceptó la llamada pero no devolvió access_token.', {
            code: 'META_CANJE_FALLIDO',
            statusCode: 502,
            reintentable: false,
            detalle: datos,
        });
    }

    return { accessToken: datos.access_token, expiresIn: datos.expires_in ?? null };
}

/**
 * Resuelve qué WABA concedió el cliente, inspeccionando el propio token con `debug_token` — el
 * mismo mecanismo que ya usa `scripts/whatsapp_diagnostico.js`. Es la fuente **autoritativa** del
 * `wabaId`: sale de lo que el token realmente concedió, no de lo que el navegador diga — un
 * cliente no puede mentir sobre a qué WABA tiene acceso, porque esto lo verifica del lado del
 * servidor contra Meta.
 *
 * ## Por qué esto ya NO devuelve `businessId`
 *
 * La primera versión sacaba `businessId` del primer `target_ids` de `granular_scopes`, sin
 * comprobar el `scope` — en la práctica, el mismo valor que `wabaId` casi siempre (coincidieron
 * los dos en la prueba real del 2026-09-19, y no era casualidad buena: es el bug). El Business
 * Manager y la WABA son conceptos distintos en Meta, y `debug_token` no da un `scope` separado
 * para el negocio. El `business_id` real sale del propio evento `WA_EMBEDDED_SIGNUP`/`FINISH` del
 * navegador (`canalWhatsappController.js` lo recibe del panel) — no es un dato de seguridad como
 * el `wabaId` (no gobierna a qué se tiene acceso), así que confiar en lo que manda el frontend
 * para esto es aceptable.
 *
 * @returns {Promise<{wabaId: string}>}
 */
async function resolverWaba({
    accessToken,
    appId = process.env.WHATSAPP_APP_ID,
    appSecret = process.env.WHATSAPP_APP_SECRET,
    fetchImpl = globalThis.fetch,
    baseUrl = BASE_URL,
    versionApi = VERSION_API,
}) {
    if (!accessToken) {
        throw fallo('Falta el accessToken para resolver la WABA concedida.', {
            code: 'META_RESOLVER_WABA_SIN_TOKEN',
            statusCode: 400,
            reintentable: false,
        });
    }

    const tokenApp = `${appId}|${appSecret}`;
    const url =
        `${baseUrl}/${versionApi}/debug_token` +
        `?input_token=${encodeURIComponent(accessToken)}` +
        `&access_token=${encodeURIComponent(tokenApp)}`;

    const { ok, status, datos } = await llamar(url, { fetchImpl });

    if (!ok) {
        throw fallo(`Meta rechazó la inspección del token (${status}).`, {
            code: 'META_RESOLVER_WABA_FALLIDO',
            statusCode: 502,
            reintentable: false,
            detalle: datos?.error,
        });
    }

    const granular = datos?.data?.granular_scopes || [];
    const wabaScope = granular.find((s) => s.scope === 'whatsapp_business_management');
    const wabaId = wabaScope?.target_ids?.[0] ?? null;

    if (!wabaId) {
        throw fallo(
            'El token no concedió ninguna cuenta de WhatsApp Business (whatsapp_business_management vacío).',
            { code: 'META_RESOLVER_WABA_SIN_ACTIVO', statusCode: 502, reintentable: false, detalle: datos }
        );
    }

    return { wabaId };
}

/**
 * El número en formato legible (`+57 315 281 2484`), a partir del `phone_number_id`.
 *
 * ## Por qué esto es una llamada aparte, y no algo que lea el evento del navegador
 *
 * La primera versión de este código asumía que el evento `WA_EMBEDDED_SIGNUP`/`FINISH` traía
 * `display_phone_number` — no es así: probado en producción el 2026-09-19 (`numero_e164` quedó
 * vacío en la primera conexión real) y confirmado después contra la documentación de Meta: ese
 * evento solo trae `phone_number_id`, `waba_id` y `business_id`. El número legible hay que
 * pedirlo aparte, por servidor, con el mismo token que ya se tiene.
 *
 * Es cosmético, no funcional — `phoneNumberId` ya es suficiente para enviar mensajes — así que
 * quien llama a esto puede seguir adelante si falla; no vale la pena tumbar una conexión por no
 * poder mostrar el número en la pantalla del panel.
 *
 * @returns {Promise<{numeroE164: string|null}>}
 */
async function resolverNumero({
    phoneNumberId,
    accessToken,
    fetchImpl = globalThis.fetch,
    baseUrl = BASE_URL,
    versionApi = VERSION_API,
}) {
    if (!phoneNumberId || !accessToken) {
        throw fallo('Faltan datos para resolver el número (phoneNumberId o accessToken).', {
            code: 'META_RESOLVER_NUMERO_DATOS_INCOMPLETOS',
            statusCode: 400,
            reintentable: false,
        });
    }

    const url =
        `${baseUrl}/${versionApi}/${phoneNumberId}` +
        `?fields=display_phone_number` +
        `&access_token=${encodeURIComponent(accessToken)}`;

    const { ok, status, datos } = await llamar(url, { fetchImpl });

    if (!ok) {
        throw fallo(`Meta rechazó la consulta del número (${status}).`, {
            code: 'META_RESOLVER_NUMERO_FALLIDO',
            statusCode: 502,
            reintentable: false,
            detalle: datos?.error,
        });
    }

    return { numeroE164: datos?.display_phone_number ?? null };
}

/**
 * Suscribe nuestra app a la WABA del cliente para que sus webhooks lleguen a nuestro endpoint.
 *
 * @returns {Promise<{suscrito: boolean}>}
 */
async function suscribirApp({
    wabaId,
    accessToken,
    fetchImpl = globalThis.fetch,
    baseUrl = BASE_URL,
    versionApi = VERSION_API,
}) {
    if (!wabaId || !accessToken) {
        throw fallo('Faltan datos para suscribir la app (wabaId o accessToken).', {
            code: 'META_SUSCRIPCION_DATOS_INCOMPLETOS',
            statusCode: 400,
            reintentable: false,
        });
    }

    const url =
        `${baseUrl}/${versionApi}/${wabaId}/subscribed_apps` +
        `?access_token=${encodeURIComponent(accessToken)}`;

    const { ok, status, datos } = await llamar(url, { fetchImpl, metodo: 'POST' });

    if (!ok) {
        throw fallo(`Meta rechazó la suscripción a la WABA (${status}).`, {
            code: 'META_SUSCRIPCION_FALLIDA',
            statusCode: 502,
            reintentable: status === 429 || status >= 500,
            detalle: datos?.error,
        });
    }

    return { suscrito: Boolean(datos?.success) };
}

module.exports = { canjearCodigo, resolverWaba, resolverNumero, suscribirApp };
