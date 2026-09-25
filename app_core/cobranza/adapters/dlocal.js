/**
 * Adaptador dLocal Go (F1) — la opción global: Colombia, Chile y 13 países más.
 *
 * Documentación consultada el 2026-09-08:
 *   POST /v1/payments        crear un cobro → devuelve `redirect_url` y `status` PENDING
 *   GET  /v1/payments/:id    estado del cobro
 *   Notificaciones           POST a `notification_url` con `{ payment_id }` y firma HMAC
 *
 * Autenticación: `Authorization: Bearer <API_KEY>:<SECRET_KEY>` (así, con dos puntos).
 * Estados: PENDING · PAID · REJECTED · CANCELLED · EXPIRED.
 *
 * ## Por qué `cobrar()` devuelve `pendiente` y no `aprobada`
 *
 * dLocal Go es un **checkout alojado**: se crea el cobro, se manda al cliente a `redirect_url`
 * y el dinero entra —o no— minutos u horas después. Devolver «aprobada» porque la API contestó
 * 200 sería confundir «el cobro existe» con «el cliente pagó», que es el error que activa planes
 * sin haber cobrado un peso. Lo que devuelve la creación es un link; lo que cierra la factura es
 * el webhook (o la consulta de respaldo).
 *
 * ## Lo que este adaptador NO hace todavía: débito automático
 *
 * dLocal permite guardar tarjeta con `allow_recurring: true`, **pero el token solo sirve
 * durante 15 minutos** después del pago, lo que no da para un cobro mensual desatendido. El
 * camino bueno es su API de suscripciones (planes con frecuencia MONTHLY), y eso exige decidir
 * quién es dueño del ciclo — hoy lo somos nosotros (`docs/cobro-mensualidades.md` §3.1).
 * Mientras tanto: factura + link de pago, que ya desbloquea al cliente de Chile.
 *
 * ⚠️ **Sin credenciales todavía.** El código está escrito contra la documentación pero **no se
 * ha ejecutado contra el sandbox**. Antes de activar `dlocal` en `cob_pasarela` hay que hacer
 * un cobro de prueba de punta a punta.
 */
'use strict';
const crypto = require('crypto');

const codigo = 'dlocal';

/** Sandbox mientras no sea producción: cobrarle de verdad a alguien desde un portátil, no. */
function baseUrl() {
    return process.env.NODE_ENV === 'production'
        ? 'https://api.dlocalgo.com'
        : 'https://api-sbx.dlocalgo.com';
}

function credenciales() {
    const apiKey = process.env.DLOCAL_API_KEY;
    const secret = process.env.DLOCAL_SECRET_KEY;
    if (!apiKey || !secret) {
        const e = new Error(
            'dLocal Go no está configurado: faltan DLOCAL_API_KEY y/o DLOCAL_SECRET_KEY.'
        );
        e.code = 'PASARELA_SIN_CREDENCIALES';
        e.statusCode = 503;
        throw e;
    }
    return { apiKey, secret };
}

function estaConfigurada() {
    return Boolean(process.env.DLOCAL_API_KEY && process.env.DLOCAL_SECRET_KEY);
}

async function llamar(ruta, { metodo = 'GET', cuerpo = null } = {}) {
    const { apiKey, secret } = credenciales();

    const respuesta = await fetch(`${baseUrl()}${ruta}`, {
        method: metodo,
        headers: {
            Authorization: `Bearer ${apiKey}:${secret}`,
            'Content-Type': 'application/json',
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        // Un cobro colgado bloquearía el cron entero: mejor fallar y reintentar mañana.
        signal: AbortSignal.timeout(20_000),
    });

    const texto = await respuesta.text();
    let datos = null;
    try {
        datos = texto ? JSON.parse(texto) : null;
    } catch {
        datos = { raw: texto.slice(0, 500) };
    }

    if (!respuesta.ok) {
        const e = new Error(
            `dLocal respondió ${respuesta.status}: ${datos?.message || datos?.raw || 'sin detalle'}`
        );
        e.code = 'PASARELA_ERROR';
        e.statusCode = 502;
        e.detalle = datos;
        throw e;
    }
    return datos;
}

/**
 * Traduce el vocabulario de dLocal al nuestro. Que esta tabla viva aquí y no en el servicio es
 * justamente el punto del adaptador: arriba solo existen 'aprobada', 'pendiente' y 'rechazada'.
 */
function traducirEstado(estadoDlocal) {
    switch (String(estadoDlocal || '').toUpperCase()) {
        case 'PAID':
            return 'aprobada';
        case 'REJECTED':
        case 'CANCELLED':
        case 'EXPIRED':
            return 'rechazada';
        default:
            return 'pendiente';
    }
}

/** Quita del payload lo que no debe quedar guardado (datos del pagador). */
function limpiar(datos) {
    if (!datos || typeof datos !== 'object') return datos;
    const { payer, card, ...resto } = datos;
    return {
        ...resto,
        // De la tarjeta solo lo que sirve para reconocerla en una disputa.
        card: card ? { last4: card.last4 ?? null, brand: card.brand ?? null } : undefined,
    };
}

/**
 * Crea el cobro y devuelve el link de pago.
 *
 * `order_id` es NUESTRA referencia (`EA-<negocio>-<AAAAMM>`): así, si algo se cruza, la
 * conciliación con dLocal se hace por un identificador que significa algo para las dos partes.
 *
 * ## Por qué lleva sufijo por intento
 *
 * dLocal exige `order_id` único por comercio: reusarlo devuelve `400 Order id is duplicated`
 * (visto el 2026-09-15 en sandbox). Sin sufijo, un cliente que abre el checkout y no termina de
 * pagar **no puede volver a intentarlo nunca** — la factura queda impagable. Es el mismo motivo
 * por el que los links de Wompi lo llevan, y el webhook ya recorta hasta la referencia base
 * (`cobranzaWebhookService.buscarFactura`), así que el pago sigue encontrando su factura.
 */
async function cobrar({
    referencia,
    monto,
    moneda,
    pais = 'CO',
    descripcion = null,
    urlRetorno = null,
}) {
    const datos = await llamar('/v1/payments', {
        metodo: 'POST',
        cuerpo: {
            amount: Number(monto),
            currency: moneda,
            country: pais,
            order_id: `${referencia}-${Date.now().toString(36)}`,
            description: (descripcion || `EscalApp ${referencia}`).slice(0, 100),
            notification_url: `${process.env.APP_PUBLIC_URL || ''}/admin/cobranza/webhook/dlocal`,
            // La decide el servidor según el origen del pago; nunca el navegador (redirect abierto).
            success_url: urlRetorno || process.env.COBRANZA_SUCCESS_URL || undefined,
            back_url: process.env.COBRANZA_BACK_URL || undefined,
        },
    });

    return {
        estado: traducirEstado(datos?.status),
        idExterno: datos?.id ? String(datos.id) : null,
        codigoRespuesta: datos?.status ?? null,
        mensaje: datos?.redirect_url
            ? 'Cobro creado. El cliente debe completar el pago en el link.'
            : 'Cobro creado.',
        urlPago: datos?.redirect_url ?? null,
        payload: limpiar(datos),
    };
}

async function consultarTransaccion(idExterno) {
    const datos = await llamar(`/v1/payments/${encodeURIComponent(idExterno)}`);
    return {
        estado: traducirEstado(datos?.status),
        idExterno: datos?.id ? String(datos.id) : idExterno,
        codigoRespuesta: datos?.status ?? null,
        mensaje: datos?.status_detail || null,
        payload: limpiar(datos),
    };
}

/**
 * Verifica la firma de una notificación.
 *
 * dLocal firma con `Authorization: V2-HMAC-SHA256, Signature: <hex>`, donde el mensaje es
 * **API key + el cuerpo crudo** y la llave es el secret. De ahí que el router capture los bytes
 * tal cual llegan: reserializar el JSON cambia el orden de las claves y el escapado, y la firma
 * deja de casar por una diferencia invisible.
 *
 * La comparación va con `timingSafeEqual`: comparar hashes con `===` filtra información por el
 * tiempo de respuesta. Es barato hacerlo bien.
 */
async function verificarFirmaWebhook(req) {
    const cabecera = req.get('Authorization') || '';
    const recibida = (cabecera.match(/Signature\s*[:=]\s*([a-f0-9]+)/i) || [])[1];
    const crudo = req.rawBody instanceof Buffer ? req.rawBody.toString('utf8') : '';

    let payload = null;
    try {
        payload = crudo ? JSON.parse(crudo) : null;
    } catch {
        payload = null;
    }

    if (!recibida || !crudo || !estaConfigurada()) {
        return { valida: false, idEvento: null, tipo: null, payload };
    }

    const { apiKey, secret } = credenciales();
    const calculada = crypto
        .createHmac('sha256', secret)
        .update(`${apiKey}${crudo}`)
        .digest('hex');

    const a = Buffer.from(calculada, 'utf8');
    const b = Buffer.from(recibida.toLowerCase(), 'utf8');
    const valida = a.length === b.length && crypto.timingSafeEqual(a, b);

    // La notificación solo trae `payment_id`: el estado hay que preguntarlo. Es más seguro,
    // porque un cuerpo falsificado no puede afirmar «pagado» — el estado lo dice la API.
    const idPago = payload?.payment_id ? String(payload.payment_id) : null;

    return {
        valida,
        idEvento: idPago ? `dlocal:${idPago}` : null,
        tipo: 'payment.updated',
        idExterno: idPago,
        payload,
    };
}

async function tokenizarMetodo() {
    const e = new Error(
        'El débito automático con dLocal Go exige su API de suscripciones (pendiente). ' +
            'Hoy el cobro se hace con link de pago.'
    );
    e.code = 'PASARELA_SIN_TOKENIZACION';
    e.statusCode = 501;
    throw e;
}

module.exports = {
    codigo,
    soportaRecurrente: false,
    estaConfigurada,
    tokenizarMetodo,
    cobrar,
    consultarTransaccion,
    // Sin `consultarPorReferencia` a propósito: `cobrar()` guarda el id del pago (`id_externo`) al
    // crear el cobro, así que la conciliación pregunta con `consultarTransaccion(id_externo)`.
    verificarFirmaWebhook,
};
