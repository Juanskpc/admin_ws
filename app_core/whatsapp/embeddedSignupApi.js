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
/**
 * Versión propia, separada de `WHATSAPP_API_VERSION` (la de mensajería), a propósito: la
 * coexistencia (`smb_app_data`, `is_on_biz_app`) salió en 2025 y los ejemplos de Meta la usan
 * desde v23.0. Subir aquí no toca cómo se envían los mensajes; subir la de mensajería sí.
 */
const VERSION_API = process.env.META_EMBEDDED_SIGNUP_API_VERSION || 'v23.0';
const BASE_URL = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com';

function fallo(mensaje, { code, statusCode, reintentable, detalle }) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode ?? null;
    e.reintentable = Boolean(reintentable);
    e.detalle = detalle ?? null;
    return e;
}

async function llamar(url, { fetchImpl = globalThis.fetch, metodo = 'GET', cuerpo = null } = {}) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
    let respuesta;
    try {
        const opciones = { method: metodo, signal: control.signal };
        if (cuerpo) {
            opciones.headers = { 'Content-Type': 'application/json' };
            opciones.body = JSON.stringify(cuerpo);
        }
        respuesta = await fetchImpl(url, opciones);
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

/**
 * Lo contrario de `suscribirApp()`: deja de recibir los webhooks de la WABA del cliente. Se usa
 * cuando el propio negocio se desconecta desde el panel — sin esto, Meta seguiría mandándonos sus
 * mensajes (que el webhook descartaría como ajenos, pero seguirían saliendo de su cuenta).
 *
 * @returns {Promise<{desuscrito: boolean}>}
 */
async function desuscribirApp({
    wabaId,
    accessToken,
    fetchImpl = globalThis.fetch,
    baseUrl = BASE_URL,
    versionApi = VERSION_API,
}) {
    if (!wabaId || !accessToken) {
        throw fallo('Faltan datos para desuscribir la app (wabaId o accessToken).', {
            code: 'META_SUSCRIPCION_DATOS_INCOMPLETOS',
            statusCode: 400,
            reintentable: false,
        });
    }

    const { ok, status, datos } = await llamar(
        `${baseUrl}/${versionApi}/${wabaId}/subscribed_apps` +
            `?access_token=${encodeURIComponent(accessToken)}`,
        { fetchImpl, metodo: 'DELETE' }
    );

    if (!ok) {
        throw fallo(`Meta rechazó quitar la suscripción a la WABA (${status}).`, {
            code: 'META_DESUSCRIPCION_FALLIDA',
            statusCode: 502,
            reintentable: status === 429 || status >= 500,
            detalle: datos?.error,
        });
    }

    return { desuscrito: Boolean(datos?.success) };
}

/** Campos del número que interesan. `is_on_biz_app` es el que delata la coexistencia. */
const CAMPOS_NUMERO = 'id,display_phone_number,verified_name,platform_type,is_on_biz_app';
/** Respaldo si Meta no reconoce algún campo en esta versión (error #100): lo mínimo que usamos. */
const CAMPOS_NUMERO_MINIMOS = 'id,display_phone_number,verified_name,platform_type';

/**
 * Los números que hay en la WABA del cliente, leídos **con su propio token**.
 *
 * ## Para qué sirve, además de mostrar el número
 *
 *   1. **Verificar el `phone_number_id` que manda el navegador.** El evento del SDK lo trae, pero
 *      el navegador es del cliente: aquí se comprueba contra Meta que ese número está de verdad en
 *      la WABA que concedió el token. Un id ajeno no pasa.
 *   2. **Descubrirlo cuando el navegador no lo manda.** En coexistencia el evento
 *      `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` puede llegar solo con `waba_id` y `business_id`,
 *      y a veces el evento no llega antes de que caduque el `code`. Con la WABA ya probada por
 *      `resolverWaba()`, la lista de números es la fuente fiable.
 *   3. **Saber si es coexistencia** (`is_on_biz_app`) y si ya está registrado en la Cloud API
 *      (`platform_type === 'CLOUD_API'`), que decide si hay que llamar a `/register`.
 *
 * @returns {Promise<Array<{id: string, numeroE164: string|null, nombreVerificado: string|null,
 *           platformType: string|null, enAppBusiness: boolean|null}>>}
 */
async function listarNumeros({
    wabaId,
    accessToken,
    fetchImpl = globalThis.fetch,
    baseUrl = BASE_URL,
    versionApi = VERSION_API,
}) {
    if (!wabaId || !accessToken) {
        throw fallo('Faltan datos para listar los números (wabaId o accessToken).', {
            code: 'META_NUMEROS_DATOS_INCOMPLETOS',
            statusCode: 400,
            reintentable: false,
        });
    }

    const pedir = (campos) =>
        llamar(
            `${baseUrl}/${versionApi}/${wabaId}/phone_numbers` +
                `?fields=${campos}&access_token=${encodeURIComponent(accessToken)}`,
            { fetchImpl }
        );

    let { ok, status, datos } = await pedir(CAMPOS_NUMERO);
    if (!ok && datos?.error?.code === 100) {
        ({ ok, status, datos } = await pedir(CAMPOS_NUMERO_MINIMOS));
    }

    if (!ok) {
        throw fallo(`Meta rechazó la consulta de los números de la WABA (${status}).`, {
            code: 'META_NUMEROS_FALLIDO',
            statusCode: 502,
            reintentable: status === 429 || status >= 500,
            detalle: datos?.error,
        });
    }

    return (datos?.data || []).map((n) => ({
        id: String(n.id),
        numeroE164: n.display_phone_number ?? null,
        nombreVerificado: n.verified_name ?? null,
        platformType: n.platform_type ?? null,
        enAppBusiness: typeof n.is_on_biz_app === 'boolean' ? n.is_on_biz_app : null,
    }));
}

/**
 * Registra un número **dedicado** en la Cloud API — sin esto, un número recién creado por
 * Embedded Signup recibe webhooks pero no puede enviar un solo mensaje.
 *
 * ⚠️ **Nunca para coexistencia.** Un número que vive en la app WhatsApp Business ya está
 * registrado por la propia app; llamar a `/register` sobre él lo sacaría de la app del dueño.
 *
 * El `pin` es la verificación en dos pasos del número: lo fija esta llamada, así que quien llama
 * debe guardarlo (cifrado) para poder volver a registrar el número en el futuro.
 *
 * @returns {Promise<{registrado: boolean}>}
 */
async function registrarNumero({
    phoneNumberId,
    accessToken,
    pin,
    fetchImpl = globalThis.fetch,
    baseUrl = BASE_URL,
    versionApi = VERSION_API,
}) {
    if (!phoneNumberId || !accessToken || !/^\d{6}$/.test(String(pin || ''))) {
        throw fallo('Faltan datos para registrar el número (phoneNumberId, accessToken o PIN de 6 dígitos).', {
            code: 'META_REGISTRO_DATOS_INCOMPLETOS',
            statusCode: 400,
            reintentable: false,
        });
    }

    const { ok, status, datos } = await llamar(
        `${baseUrl}/${versionApi}/${phoneNumberId}/register` +
            `?access_token=${encodeURIComponent(accessToken)}`,
        { fetchImpl, metodo: 'POST', cuerpo: { messaging_product: 'whatsapp', pin: String(pin) } }
    );

    if (!ok) {
        throw fallo(
            `Meta rechazó el registro del número (${status}): ${datos?.error?.message || 'sin detalle'}`,
            {
                code: 'META_REGISTRO_FALLIDO',
                statusCode: 502,
                reintentable: status === 429 || status >= 500,
                detalle: datos?.error,
            }
        );
    }

    return { registrado: Boolean(datos?.success) };
}

/** Los dos tipos de sincronización que ofrece la coexistencia, en el orden en que se piden. */
const SINCRONIZACIONES = Object.freeze(['smb_app_state_sync', 'history']);

/**
 * Pide a Meta que empiece a mandar por webhook los contactos (`smb_app_state_sync`) o el
 * historial de chats (`history`) de la app WhatsApp Business del cliente.
 *
 * ## Por qué se llama justo al conectar
 *
 * Meta solo acepta esta petición en las **24 horas** siguientes a la conexión: después ya no hay
 * forma de pedirla sin volver a conectar el número. Y solo se puede pedir **una vez** por tipo.
 * El historial solo llega si el dueño aceptó compartirlo en su celular durante el escaneo del QR;
 * si no, Meta manda un webhook `history` con un error y no pasa nada más.
 *
 * Los chats NO dependen de esto: siguen en el celular del dueño pase lo que pase. Esto es lo que
 * nos llega a nosotros, no lo que el dueño conserva.
 *
 * @returns {Promise<{solicitado: boolean, idSolicitud: string|null}>}
 */
async function solicitarSincronizacion({
    phoneNumberId,
    accessToken,
    tipo,
    fetchImpl = globalThis.fetch,
    baseUrl = BASE_URL,
    versionApi = VERSION_API,
}) {
    if (!phoneNumberId || !accessToken || !SINCRONIZACIONES.includes(tipo)) {
        throw fallo('Faltan datos para pedir la sincronización (phoneNumberId, accessToken o tipo).', {
            code: 'META_SINCRONIZACION_DATOS_INCOMPLETOS',
            statusCode: 400,
            reintentable: false,
        });
    }

    const { ok, status, datos } = await llamar(
        `${baseUrl}/${versionApi}/${phoneNumberId}/smb_app_data` +
            `?access_token=${encodeURIComponent(accessToken)}`,
        { fetchImpl, metodo: 'POST', cuerpo: { messaging_product: 'whatsapp', sync_type: tipo } }
    );

    if (!ok) {
        throw fallo(`Meta rechazó la sincronización "${tipo}" (${status}).`, {
            code: 'META_SINCRONIZACION_FALLIDA',
            statusCode: 502,
            reintentable: false,
            detalle: datos?.error,
        });
    }

    return { solicitado: true, idSolicitud: datos?.request_id ?? null };
}

module.exports = {
    canjearCodigo,
    resolverWaba,
    resolverNumero,
    suscribirApp,
    desuscribirApp,
    listarNumeros,
    registrarNumero,
    solicitarSincronizacion,
    SINCRONIZACIONES,
    VERSION_API,
};
