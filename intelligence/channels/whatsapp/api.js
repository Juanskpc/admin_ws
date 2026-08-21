/**
 * Cliente de la Cloud API — el único sitio de todo el proyecto que le habla a Meta (F8-A).
 *
 * ## Por qué está aislado en un archivo de veinte líneas útiles
 *
 * Es la parte del canal que **no se puede verificar sin un número de verdad**. Todo lo demás de
 * F8-A —firma, normalización de la entrada, renderizado de la salida— se prueba en local con
 * cargas reales repetidas. Esto no: hasta que exista la cuenta de Meta, es código escrito contra
 * una documentación. Tenerlo apartado y pequeño es lo que hace que esa frontera se vea en el
 * `git diff` en vez de quedar diluida por el adaptador.
 *
 * Y por eso se inyecta: los tests le pasan un doble y ejercitan el adaptador entero sin red.
 *
 * ## Errores: distinguir «vuelve a intentarlo» de «no insistas»
 *
 * El gateway reintenta lo que lance (hasta `CANAL_ENTREGA_MAX_INTENTOS`). Un 429 o un 5xx de Meta
 * merecen reintento; un 400 «el número no está en WhatsApp» no se arregla insistiendo — cinco
 * intentos idénticos solo retrasan el *dead letter* y ensucian el registro. Se marca con
 * `reintentable` para que quien lo lea sepa qué esperar, aunque hoy el gateway reintente igual:
 * el backoff y el descarte fino son lo primero que hará falta cuando Meta empiece a devolver 429
 * de verdad (ver la nota de `gateway.js`).
 */
'use strict';
const configReal = require('./config');

/** Cuánto se espera a Meta. Su webhook nos da 10 s; nosotros no podemos colgarnos más. */
const TIMEOUT_MS = Number(process.env.WHATSAPP_TIMEOUT_MS) || 8000;

function fallo(mensaje, { code, statusCode, reintentable, detalle }) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode ?? null;
    e.reintentable = Boolean(reintentable);
    e.detalle = detalle ?? null;
    return e;
}

/**
 * Manda un mensaje ya renderizado.
 *
 * @param {Object} opciones
 * @param {string} opciones.para — el número del destinatario, tal como llegó en el webhook.
 * @param {Object} opciones.payload — lo que devolvió `adaptador.renderizar()`.
 * @param {Function} [opciones.fetchImpl] — inyectable; por defecto el `fetch` de Node 22.
 * @param {Object} [opciones.config]
 * @returns {Promise<{wamid: string|null}>}
 */
async function enviarMensaje({ para, payload, fetchImpl = globalThis.fetch, config = configReal }) {
    const c = config.leer();
    if (!c.token || !c.phoneNumberId) {
        throw fallo('El canal de WhatsApp no está configurado (falta token o número).', {
            code: 'WHATSAPP_SIN_CONFIGURAR',
            reintentable: false,
        });
    }

    const url = `${c.baseUrl}/${c.versionApi}/${c.phoneNumberId}/messages`;
    const cuerpo = { messaging_product: 'whatsapp', recipient_type: 'individual', to: para, ...payload };

    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);

    let respuesta;
    try {
        respuesta = await fetchImpl(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(cuerpo),
            signal: control.signal,
        });
    } catch (error) {
        // Red caída o timeout: reintentable sin dudarlo.
        throw fallo(`No se pudo llamar a la Cloud API: ${error.message}`, {
            code: 'WHATSAPP_RED',
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

    if (!respuesta.ok) {
        const meta = datos?.error || {};
        throw fallo(
            `La Cloud API rechazó el envío (${respuesta.status}): ${meta.message || 'sin detalle'}`,
            {
                code: `WHATSAPP_${meta.code ?? respuesta.status}`,
                statusCode: respuesta.status,
                // 429 y 5xx se reintentan; un 4xx de argumento, no.
                reintentable: respuesta.status === 429 || respuesta.status >= 500,
                detalle: meta,
            }
        );
    }

    return { wamid: datos?.messages?.[0]?.id ?? null };
}

module.exports = { enviarMensaje, TIMEOUT_MS };
