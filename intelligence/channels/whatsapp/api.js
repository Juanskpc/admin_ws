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
 * ¿A quién se le escribe: a un teléfono o a un BSUID?
 *
 * Un **Business-Scoped User ID** es la identidad que WhatsApp da a quien escribe sin enseñar su
 * número: `CO.1112947687726965` — indicativo de país, un punto, y dígitos. Meta los manda desde
 * marzo de 2026 y, con los nombres de usuario, un cliente nuevo puede llegar **solo** con eso.
 *
 * Se distinguen por el punto, y no hace falta más: un número de teléfono no lleva puntos en
 * ninguna de las formas en que Meta lo entrega. Una expresión regular más lista sería más
 * frágil el día que Meta añada un formato.
 */
function esBsuid(destinatario) {
    return /^[A-Za-z]{2}\.[A-Za-z0-9]+$/.test(String(destinatario || ''));
}

/**
 * Manda un mensaje ya renderizado.
 *
 * ⚠️ **A un BSUID se le escribe con `recipient`, no con `to`.** Es lo que dice la documentación
 * de Meta, y además `to` **tiene precedencia** si van los dos: mandar el BSUID en `to` no es
 * «casi correcto», es un envío que Meta no entrega y un cliente que no recibe nada.
 *
 * @param {Object} opciones
 * @param {string} opciones.para — el destinatario tal como llegó en el webhook: su número, o su
 *                 BSUID si no enseñó número.
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
    const cuerpo = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        ...(esBsuid(para) ? { recipient: para } : { to: para }),
        ...payload,
    };

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

module.exports = {
    esBsuid, enviarMensaje, TIMEOUT_MS };
