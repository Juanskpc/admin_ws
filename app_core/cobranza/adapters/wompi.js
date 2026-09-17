/**
 * Adaptador Wompi (F2) — la opción local de Colombia: PSE, Nequi, botón Bancolombia y tarjetas,
 * todos con la misma tarifa (2,65% + $700 + IVA).
 *
 * Documentación consultada el 2026-09-08:
 *   GET  /v1/merchants/<public_key>   → `acceptance_token` (los términos que acepta el pagador)
 *   POST /v1/payment_sources          → guarda el medio de pago y devuelve un id reutilizable
 *   POST /v1/transactions             → cobra contra ese id
 *   GET  /v1/transactions/<id>        → estado
 *   Eventos: cuerpo firmado con SHA256(valores + timestamp + secreto_de_eventos)
 *
 * ## Este SÍ puede cobrar solo
 *
 * A diferencia de dLocal Go, Wompi guarda una «fuente de pago» permanente: el cliente autentica
 * una vez y a partir de ahí se le puede debitar sin que esté delante. Por eso es el candidato
 * natural para el débito automático mensual en Colombia — y por eso `soportaRecurrente` es true.
 *
 * ## Dos firmas distintas que se confunden con facilidad
 *
 *   - **Firma de integridad** (`WOMPI_INTEGRITY_SECRET`): la calculamos NOSOTROS al cobrar, para
 *     que nadie altere el monto por el camino. Es SHA256(referencia + monto + moneda + secreto).
 *   - **Firma de eventos** (`WOMPI_EVENTS_SECRET`): la calcula WOMPI en cada webhook y la
 *     verificamos nosotros. Concatena los valores que nombra `signature.properties`, el
 *     `timestamp` y el secreto.
 *
 * Son secretos distintos y usar uno donde va el otro falla de formas poco obvias.
 *
 * ⚠️ **Sin credenciales todavía.** Escrito contra la documentación, **no ejecutado contra el
 * sandbox**. Antes de activar `wompi` en `cob_pasarela`: un cobro de prueba completo.
 */
'use strict';
const crypto = require('crypto');

const codigo = 'wompi';

/**
 * El ambiente lo deciden LAS LLAVES, no `NODE_ENV`.
 *
 * Antes era al revés, y escondía una trampa cara: el checkout (`checkout.wompi.co`) es la misma URL
 * para pruebas y producción y el ambiente lo elige la llave pública. Con llaves `pub_prod_` en un
 * `.env` local, el checkout cobraba **dinero real** mientras el backend —por no estar en
 * producción— consultaba el sandbox con llaves de producción y la confirmación fallaba. Cobrar de
 * verdad y no enterarse. Pasó el 2026-09-14 con las llaves recién sacadas del panel.
 *
 * @returns {'sandbox'|'produccion'|'mixto'|null} null si faltan llaves.
 */
function ambienteDeLlaves() {
    const llaves = [
        [process.env.WOMPI_PUBLIC_KEY, 'pub_test_', 'pub_prod_'],
        [process.env.WOMPI_PRIVATE_KEY, 'prv_test_', 'prv_prod_'],
        [process.env.WOMPI_INTEGRITY_SECRET, 'test_integrity_', 'prod_integrity_'],
    ];
    // El secreto de eventos es opcional para cobrar, pero si está tiene que ser del mismo ambiente.
    if (process.env.WOMPI_EVENTS_SECRET) {
        llaves.push([process.env.WOMPI_EVENTS_SECRET, 'test_events_', 'prod_events_']);
    }

    if (llaves.slice(0, 3).some(([valor]) => !valor)) return null;
    if (llaves.every(([valor, test]) => valor.startsWith(test))) return 'sandbox';
    if (llaves.every(([valor, , prod]) => valor.startsWith(prod))) return 'produccion';
    return 'mixto';
}

function baseUrl() {
    return ambienteDeLlaves() === 'produccion'
        ? 'https://production.wompi.co/v1'
        : 'https://sandbox.wompi.co/v1';
}

let avisoMostrado = false;

/**
 * ¿Puede cobrar Wompi en este proceso? No basta con que haya llaves:
 *
 *   - **Mezcladas** (una de pruebas y otra de producción) → no. Las dos APIs no se hablan y el
 *     fallo sería confuso e intermitente.
 *   - **De producción fuera de producción** → no, salvo `WOMPI_PERMITIR_PRODUCCION_LOCAL=true`.
 *     Probar desde un portátil no debería poder cobrarle a nadie por accidente.
 *
 * Cuando se niega lo avisa una vez en consola: una pasarela que desaparece del selector sin
 * explicación es peor que una que falla con un mensaje claro.
 */
function estaConfigurada() {
    const ambiente = ambienteDeLlaves();
    if (!ambiente) return false;

    let motivo = null;
    if (ambiente === 'mixto') {
        motivo = 'las llaves mezclan pruebas (test) y producción (prod)';
    } else if (
        ambiente === 'produccion' &&
        process.env.NODE_ENV !== 'production' &&
        process.env.WOMPI_PERMITIR_PRODUCCION_LOCAL !== 'true'
    ) {
        motivo =
            'hay llaves de PRODUCCIÓN fuera de producción: un pago de prueba cobraría dinero real';
    } else if (ambiente === 'sandbox' && process.env.NODE_ENV === 'production') {
        // El reverso del caso anterior, y el más caro de los dos: con llaves de sandbox en el
        // servidor, CUALQUIER cliente paga con la tarjeta de prueba `4242…`, Wompi la aprueba y el
        // plan se extiende un mes sin que entre un peso. Mejor no ofrecer Wompi que regalar meses.
        motivo = 'hay llaves de PRUEBAS en producción: cualquiera pagaría con una tarjeta de prueba';
    }

    if (motivo) {
        if (!avisoMostrado) {
            console.warn(`⚠️  Wompi desactivado: ${motivo}. Usa las llaves de pruebas (pub_test_…).`);
            avisoMostrado = true;
        }
        return false;
    }
    return true;
}

function exigirConfiguracion() {
    if (!estaConfigurada()) {
        const e = new Error(
            'Wompi no está configurado: faltan WOMPI_PUBLIC_KEY, WOMPI_PRIVATE_KEY y/o ' +
                'WOMPI_INTEGRITY_SECRET.'
        );
        e.code = 'PASARELA_SIN_CREDENCIALES';
        e.statusCode = 503;
        throw e;
    }
}

async function llamar(ruta, { metodo = 'GET', cuerpo = null, privada = true } = {}) {
    const llave = privada ? process.env.WOMPI_PRIVATE_KEY : process.env.WOMPI_PUBLIC_KEY;

    const respuesta = await fetch(`${baseUrl()}${ruta}`, {
        method: metodo,
        headers: {
            Authorization: `Bearer ${llave}`,
            'Content-Type': 'application/json',
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
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
            `Wompi respondió ${respuesta.status}: ${
                datos?.error?.reason || datos?.error?.type || datos?.raw || 'sin detalle'
            }`
        );
        e.code = 'PASARELA_ERROR';
        e.statusCode = 502;
        e.detalle = datos;
        throw e;
    }
    return datos;
}

function traducirEstado(estadoWompi) {
    switch (String(estadoWompi || '').toUpperCase()) {
        case 'APPROVED':
            return 'aprobada';
        case 'DECLINED':
        case 'ERROR':
        case 'VOIDED':
            return 'rechazada';
        default:
            return 'pendiente'; // PENDING
    }
}

/**
 * Wompi trabaja en **centavos y en enteros**. Mandar 27999.00 en vez de 2799900 cobra cien veces
 * menos y la API no se queja: es un número válido. De ahí que la conversión esté centralizada
 * aquí y no repartida por el servicio.
 */
function aCentavos(monto) {
    return Math.round(Number(monto) * 100);
}

/** El token de aceptación de términos: el pagador tiene que aceptarlos al guardar su medio. */
async function getAcceptanceToken() {
    exigirConfiguracion();
    const datos = await llamar(`/merchants/${process.env.WOMPI_PUBLIC_KEY}`, { privada: false });
    return datos?.data?.presigned_acceptance?.acceptance_token ?? null;
}

/**
 * Guarda el medio de pago y devuelve el id reutilizable.
 *
 * `tokenTarjeta` lo produce el widget de Wompi EN EL NAVEGADOR: aquí nunca entra un número de
 * tarjeta, y por eso el alcance PCI se queda en SAQ-A.
 */
async function tokenizarMetodo({ tokenTarjeta, acceptanceToken, email, tipo = 'CARD' }) {
    exigirConfiguracion();
    if (!tokenTarjeta) {
        const e = new Error('Falta el token de la tarjeta generado por el widget de Wompi.');
        e.code = 'TOKEN_REQUERIDO';
        e.statusCode = 422;
        throw e;
    }

    const datos = await llamar('/payment_sources', {
        metodo: 'POST',
        cuerpo: {
            type: tipo,
            token: tokenTarjeta,
            customer_email: email,
            acceptance_token: acceptanceToken || (await getAcceptanceToken()),
        },
    });

    const fuente = datos?.data;
    return {
        tokenExterno: String(fuente?.id),
        tipo: fuente?.type ?? tipo,
        marca: fuente?.public_data?.brand ?? null,
        ultimos4: fuente?.public_data?.last_four ?? null,
        mesExp: fuente?.public_data?.exp_month ? Number(fuente.public_data.exp_month) : null,
        anioExp: fuente?.public_data?.exp_year ? Number(fuente.public_data.exp_year) : null,
    };
}

/** La firma de integridad: SHA256(referencia + monto_en_centavos + moneda + secreto). */
function firmaIntegridad(referencia, centavos, moneda) {
    return crypto
        .createHash('sha256')
        .update(`${referencia}${centavos}${moneda}${process.env.WOMPI_INTEGRITY_SECRET}`)
        .digest('hex');
}

/**
 * Link de Web Checkout: la página de pago alojada por Wompi, donde el cliente elige PSE, Nequi,
 * botón Bancolombia o tarjeta. No es una llamada a la API — es una URL firmada.
 *
 * ## La referencia lleva sufijo, y no es capricho
 *
 * Wompi exige una referencia **única por transacción**. Si el primer intento del cliente se
 * rechaza (fondos, PSE caído) y reusáramos `EA-17-202609`, el segundo intento fallaría por
 * referencia repetida, con un error que al cliente no le dice nada. Por eso cada link lleva un
 * sufijo (`EA-17-202609-lx3k9a`) y el webhook recorta hasta la referencia base para encontrar la
 * factura.
 */
function linkCheckout({ referencia, monto, moneda, email, urlRetorno }) {
    const centavos = aCentavos(monto);
    const referenciaIntento = `${referencia}-${Date.now().toString(36)}`;

    const params = new URLSearchParams({
        'public-key': process.env.WOMPI_PUBLIC_KEY,
        currency: moneda,
        'amount-in-cents': String(centavos),
        reference: referenciaIntento,
        'signature:integrity': firmaIntegridad(referenciaIntento, centavos, moneda),
    });
    // Wompi BLOQUEA con un 403 de su firewall cualquier redirect-url que no sea https: con
    // `http://localhost` en desarrollo el checkout entero dejaba de cargar (2026-09-15). Solo se
    // envía si es https. Sin él, Wompi termina en su propia pantalla de resultado y la
    // confirmación llega por webhook o por «Verificar pago» en la consola.
    // `urlRetorno` lo decide el SERVIDOR según de dónde vino el pago (portal público o app con
    // sesión). Nunca llega del navegador: aceptar una URL de vuelta del cliente sería un redirect
    // abierto —cualquiera haría que Wompi devolviera a su sitio con aspecto de ser el nuestro—.
    const retorno = urlRetorno || process.env.COBRANZA_SUCCESS_URL || '';
    if (retorno.startsWith('https://')) params.set('redirect-url', retorno);
    if (email) params.set('customer-data:email', email);

    return { url: `https://checkout.wompi.co/p/?${params.toString()}`, referenciaIntento };
}

async function cobrar({ referencia, monto, moneda = 'COP', token, email, urlRetorno }) {
    exigirConfiguracion();

    // Sin fuente de pago guardada no hay débito posible: se abre el checkout y el cliente paga
    // allí. Es el camino del portal de pagos, que por diseño NUNCA usa un medio guardado.
    if (!token) {
        const { url, referenciaIntento } = linkCheckout({
            referencia,
            monto,
            moneda,
            email,
            urlRetorno,
        });
        return {
            estado: 'pendiente',
            idExterno: null,
            codigoRespuesta: 'CHECKOUT',
            mensaje: 'Link de pago creado. El cliente debe completar el pago en Wompi.',
            urlPago: url,
            payload: { reference: referenciaIntento, modo: 'web-checkout' },
        };
    }

    const centavos = aCentavos(monto);
    const datos = await llamar('/transactions', {
        metodo: 'POST',
        cuerpo: {
            amount_in_cents: centavos,
            currency: moneda,
            customer_email: email,
            reference: referencia,
            payment_source_id: Number(token),
            signature: firmaIntegridad(referencia, centavos, moneda),
        },
    });

    const tx = datos?.data;
    return {
        estado: traducirEstado(tx?.status),
        idExterno: tx?.id ? String(tx.id) : null,
        codigoRespuesta: tx?.status ?? null,
        mensaje: tx?.status_message || null,
        payload: { id: tx?.id, status: tx?.status, reference: tx?.reference },
    };
}

async function consultarTransaccion(idExterno) {
    exigirConfiguracion();
    const datos = await llamar(`/transactions/${encodeURIComponent(idExterno)}`);
    const tx = datos?.data;
    return {
        estado: traducirEstado(tx?.status),
        idExterno: tx?.id ? String(tx.id) : idExterno,
        codigoRespuesta: tx?.status ?? null,
        mensaje: tx?.status_message || null,
        // Monto y moneda viajan para que quien aplica el pago compruebe que coinciden con la
        // factura. La firma de integridad ya impide alterarlos en el checkout; esto es la
        // segunda llave, por si algún día la primera se configura mal.
        payload: {
            id: tx?.id,
            status: tx?.status,
            reference: tx?.reference,
            amount_in_cents: tx?.amount_in_cents ?? null,
            currency: tx?.currency ?? null,
        },
    };
}

/**
 * Verifica la firma de un evento: se concatenan los valores que nombra `signature.properties`
 * —en ese orden exacto— más el `timestamp` y el secreto de eventos, y se compara el SHA256.
 *
 * Las propiedades vienen como rutas ('transaction.id'), así que hay que navegarlas dentro de
 * `data`. Tomar los campos que uno cree que van, en el orden que uno cree, es la forma más
 * rápida de tener un verificador que dice «inválida» a eventos legítimos.
 */
async function verificarFirmaWebhook(req) {
    const crudo = req.rawBody instanceof Buffer ? req.rawBody.toString('utf8') : '';
    let payload = null;
    try {
        payload = crudo ? JSON.parse(crudo) : null;
    } catch {
        payload = null;
    }

    const secreto = process.env.WOMPI_EVENTS_SECRET;
    const propiedades = payload?.signature?.properties;
    const recibida = payload?.signature?.checksum;

    if (!secreto || !payload || !Array.isArray(propiedades) || !recibida) {
        return { valida: false, idEvento: null, tipo: payload?.event ?? null, payload };
    }

    const concatenado = propiedades
        .map((ruta) => ruta.split('.').reduce((nodo, clave) => nodo?.[clave], payload.data))
        .join('');

    const calculada = crypto
        .createHash('sha256')
        .update(`${concatenado}${payload.timestamp}${secreto}`)
        .digest('hex');

    const a = Buffer.from(calculada, 'utf8');
    const b = Buffer.from(String(recibida).toLowerCase(), 'utf8');
    const valida = a.length === b.length && crypto.timingSafeEqual(a, b);

    const tx = payload?.data?.transaction;
    return {
        valida,
        // Wompi no manda un id de evento propio: la pareja transacción + estado identifica el
        // hecho, y es lo que impide procesar dos veces el mismo cambio.
        idEvento: tx?.id ? `wompi:${tx.id}:${tx.status}` : null,
        tipo: payload?.event ?? null,
        idExterno: tx?.id ? String(tx.id) : null,
        referencia: tx?.reference ?? null,
        payload,
    };
}

module.exports = {
    codigo,
    soportaRecurrente: true,
    estaConfigurada,
    getAcceptanceToken,
    tokenizarMetodo,
    cobrar,
    consultarTransaccion,
    verificarFirmaWebhook,
};
