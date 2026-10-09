'use strict';
/**
 * Adaptador de Factus (proveedor tecnológico). Es lo único de EscalApp que habla con su API.
 *
 * Cumple el puerto de `./index.js`: recibe las credenciales **por parámetro** —cada negocio tiene
 * su propia cuenta de Factus (D2)— y no toca la base ni lee `process.env.FACTUS_*`, que son solo
 * de los scripts de sandbox.
 *
 * Lo que aquí se da por cierto salió de respuestas reales del sandbox, no de la documentación:
 * `scripts/factus_factura_prueba.js` (2026-09-14) y `scripts/factus_sondeo.js` (2026-10-08, §5 de
 * `docs/plan-fe-restaurante.md`). El cliente HTTP sigue al que ya corre en producción en Orbita
 * (`sst_ws/src/modules/facturacion/adaptadores/factus.cliente.js`), con una diferencia de fondo:
 * allá hay una sola cuenta y aquí una sesión por cuenta.
 *
 * Tres cosas que no dan error y conviene saber:
 *   1. **Repetir un `reference_code` no duplica**: Factus devuelve el mismo documento, con el
 *      mismo número. Por eso un reintento va siempre con la MISMA referencia.
 *   2. **Avisos y rechazos llegan mezclados en `errors`**; solo es rechazo si el texto dice
 *      «Rechazo». Una factura validada trae avisos casi siempre.
 *   3. **`validated_at` viene como `08-10-2026 09:23:26 PM`**: día-mes-año, hora de Bogotá.
 *      `new Date()` lo lee como 10 de agosto.
 */

const URL = { PRUEBAS: 'https://api-sandbox.factus.com.co', PRODUCCION: 'https://api.factus.com.co' };
const TIMEOUT_MS = 8000;
/** No se sale con un token al que le queda menos de esto. */
const MARGEN_TOKEN_MS = 60000;

/**
 * Factus v2 solo ha validado la unidad `94` (unidad): en Orbita se probaron 8 códigos que su
 * propia documentación lista como válidos y los 8 volvieron «código unidad de medida inválido».
 * Un código no confirmado se envía como `94` en vez de dejar que rechace la factura entera.
 */
const UNIDADES_CONFIRMADAS = new Set(['94']);

/** Cómo nombra Factus el documento de cada rango (es un texto, no un código). */
const TIPO_DE_RANGO = { 'factura de venta': 'FV', 'nota crédito': 'NC' };
/** …y con qué código hay que pedírselo al crearlo (tabla de referencia de Factus). */
const CODIGO_DE_RANGO = { FV: '21', NC: '22' };

const RUTAS = {
    FV: { emitir: '/v2/bills/validate', ver: '/v2/bills', eliminar: '/v2/bills/destroy/reference' },
    NC: { emitir: '/v2/credit-notes/validate', ver: '/v2/credit-notes' },
};

function fallo(mensaje, code, statusCode) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

function baseUrl(ambiente) {
    if (!URL[ambiente]) throw fallo(`Ambiente de facturación inválido: ${ambiente}`, 'FE_AMBIENTE_INVALIDO', 500);
    // D15: una factura de prueba en producción quema un consecutivo real y es un documento
    // fiscal ante la DIAN. Fuera de producción, el ambiente PRODUCCION no existe.
    if (ambiente === 'PRODUCCION' && process.env.NODE_ENV !== 'production') {
        throw fallo(
            'El ambiente PRODUCCION de facturación solo se puede usar con NODE_ENV=production.',
            'FE_AMBIENTE_PROHIBIDO',
            500
        );
    }
    return URL[ambiente];
}

const txt = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

// ─── HTTP y token ──────────────────────────────────────────────────────────────────────────

/** Lee el cuerpo sin asumir que sea JSON: un 502 de un proxy llega en HTML. */
async function leer(r) {
    const t = await r.text();
    if (!t) return null;
    try {
        return JSON.parse(t);
    } catch {
        return { crudo: t.slice(0, 500) };
    }
}

function pedir(url, opciones) {
    return fetch(url, { ...opciones, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** `${ambiente}:${username}` → { token, venceEn, renovando } */
const sesiones = new Map();

function sesionDe(credenciales, ambiente) {
    const clave = `${ambiente}:${credenciales.username}`;
    if (!sesiones.has(clave)) sesiones.set(clave, { token: null, venceEn: 0, renovando: null });
    return sesiones.get(clave);
}

async function pedirToken(credenciales, ambiente) {
    let r;
    let cuerpo;
    try {
        r = await pedir(`${baseUrl(ambiente)}/oauth/token`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'password',
                client_id: credenciales.client_id,
                client_secret: credenciales.client_secret,
                username: credenciales.username,
                password: credenciales.password,
            }),
        });
        cuerpo = await leer(r);
    } catch (err) {
        const e = fallo('Factus no respondió al pedir la sesión.', 'FE_PROVEEDOR_SIN_RESPUESTA', 502);
        e.errorRed = err?.name || 'Error';
        throw e;
    }
    if (!r.ok || !cuerpo?.access_token) {
        // Nunca el cuerpo entero ni lo que se envió: solo el código de error de OAuth.
        throw fallo(
            `Factus rechazó las credenciales (HTTP ${r.status}${cuerpo?.error ? `, ${cuerpo.error}` : ''}).`,
            'FE_CREDENCIALES_INVALIDAS',
            401
        );
    }
    return { token: cuerpo.access_token, venceEn: Date.now() + Number(cuerpo.expires_in || 600) * 1000 };
}

async function obtenerToken(credenciales, ambiente) {
    const sesion = sesionDe(credenciales, ambiente);
    if (sesion.token && sesion.venceEn - Date.now() > MARGEN_TOKEN_MS) return sesion.token;
    // Una sola petición de token en vuelo por cuenta: dos cobros a la vez no piden dos.
    sesion.renovando ??= pedirToken(credenciales, ambiente)
        .then((nuevo) => {
            sesion.token = nuevo.token;
            sesion.venceEn = nuevo.venceEn;
            return nuevo.token;
        })
        .finally(() => {
            sesion.renovando = null;
        });
    return sesion.renovando;
}

/**
 * Llama a Factus. **No lanza por fallos de red ni de credenciales**: devuelve
 * `{ status, cuerpo, errorRed }` y `clasificar` decide. Solo lanza `FE_AMBIENTE_*`, que es un
 * error nuestro y no algo que reintentar.
 *
 * Ante un 401 pide un token nuevo y repite UNA vez. No reintenta nada más por su cuenta.
 */
async function llamar({ credenciales, ambiente, metodo, ruta, json }) {
    const url = `${baseUrl(ambiente)}${ruta}`;
    for (let intento = 0; intento < 2; intento++) {
        let token;
        try {
            token = await obtenerToken(credenciales, ambiente);
        } catch (err) {
            if (err.code === 'FE_CREDENCIALES_INVALIDAS') return { status: 401, cuerpo: null };
            if (err.code === 'FE_PROVEEDOR_SIN_RESPUESTA') return { status: null, cuerpo: null, errorRed: err.errorRed };
            throw err;
        }
        let r;
        try {
            r = await pedir(url, {
                method: metodo,
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: json === undefined ? undefined : JSON.stringify(json),
            });
        } catch (err) {
            return { status: null, cuerpo: null, errorRed: err?.name || 'Error' };
        }
        if (r.status === 401 && intento === 0) {
            sesionDe(credenciales, ambiente).token = null;
            continue;
        }
        return { status: r.status, cuerpo: await leer(r) };
    }
    return { status: 401, cuerpo: null };
}

/** Olvida las sesiones (para las pruebas, y al cambiar las credenciales de un negocio). */
function olvidarTokens() {
    sesiones.clear();
}

// ─── Clasificación ─────────────────────────────────────────────────────────────────────────

/** Factus mezcla avisos y rechazos en `errors`; solo es rechazo si el texto dice «Rechazo». */
function clasificarErrores(errors) {
    const entradas = Object.entries(errors || {}).map(([codigo, v]) => ({ codigo, mensaje: String(v) }));
    return {
        rechazos: entradas.filter((x) => /rechazo/i.test(x.mensaje)),
        avisos: entradas.filter((x) => !/rechazo/i.test(x.mensaje)),
    };
}

/** `08-10-2026 09:23:26 PM` (día-mes-año, hora de Bogotá) → ISO con zona. */
function fechaDeFactus(valor) {
    const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?$/i.exec(String(valor || '').trim());
    if (!m) return null;
    let hora = Number(m[4]);
    if (m[7]) hora = (hora % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
    return `${m[3]}-${m[2]}-${m[1]}T${String(hora).padStart(2, '0')}:${m[5]}:${m[6]}-05:00`;
}

/** Los 400/422 de validación traen los campos en `data.errors` o `errors`, cada uno con su lista. */
function erroresDeValidacion(cuerpo) {
    const e = cuerpo?.data?.errors ?? cuerpo?.errors;
    if (!e || typeof e !== 'object') return [];
    return Object.entries(e).map(([codigo, v]) => ({
        codigo,
        mensaje: Array.isArray(v) ? v.join(' ') : String(v),
    }));
}

/**
 * Convierte la respuesta de una emisión (o de una consulta) en un `ResultadoEmision`.
 * El orden de las reglas importa: es el de R2.2 del plan.
 */
function clasificar({ status, cuerpo, errorRed }) {
    const base = {
        httpStatus: status ?? null,
        numero: null,
        cufe: null,
        fechaValidacion: null,
        urlPublica: null,
        urlQr: null,
        avisos: [],
        rechazos: [],
        respuesta: cuerpo ?? null,
    };
    if (errorRed) {
        return { ...base, resultado: 'ERROR_RED', mensaje: 'Factus no responde; se reintentará.' };
    }
    if (status === 401) {
        return {
            ...base,
            resultado: 'ERROR_CREDENCIALES',
            mensaje: 'Factus no acepta las credenciales de este negocio. Hay que revisarlas.',
        };
    }
    if (status === 409) {
        return {
            ...base,
            resultado: 'BLOQUEADO_PENDIENTE',
            mensaje: 'Hay otra factura pendiente en Factus para este negocio.',
        };
    }
    if (status === 400 || status === 422) {
        const rechazos = erroresDeValidacion(cuerpo);
        return {
            ...base,
            resultado: 'RECHAZADO',
            rechazos,
            mensaje: rechazos.map((x) => x.mensaje).join(' ') || cuerpo?.message || 'Factus rechazó el documento.',
        };
    }
    if (status === 429 || status >= 500 || status < 200 || status >= 300) {
        return { ...base, resultado: 'ERROR_PROVEEDOR', mensaje: `Factus respondió HTTP ${status}; se reintentará.` };
    }

    // La nota crédito ha llegado envuelta en `credit_note` y también plana.
    const doc = cuerpo?.data?.credit_note || cuerpo?.data || {};
    const { rechazos, avisos } = clasificarErrores(doc.errors);
    if (rechazos.length) {
        return {
            ...base,
            resultado: 'RECHAZADO',
            avisos,
            rechazos,
            mensaje: rechazos.map((x) => x.mensaje).join(' '),
        };
    }
    if (!doc.is_validated) {
        return {
            ...base,
            resultado: 'PENDIENTE_DIAN',
            avisos,
            mensaje: 'La DIAN todavía no valida el documento; se reintentará con los mismos datos.',
        };
    }
    return {
        ...base,
        resultado: 'ACEPTADO',
        numero: doc.number || null,
        cufe: doc.cufe || doc.cude || null,
        fechaValidacion: fechaDeFactus(doc.validated_at),
        urlPublica: doc.links?.public_url || null,
        urlQr: doc.links?.qr || null,
        avisos,
        mensaje: `Documento ${doc.number} validado por la DIAN.`,
    };
}

// ─── Traducción: nuestro documento → JSON de Factus ────────────────────────────────────────

function traducirComprador(a) {
    if (a.consumidor_final === true) {
        return {
            identification_document_code: '13',
            identification: '222222222222',
            names: 'Consumidor Final',
            legal_organization_code: '2',
        };
    }
    // El sondeo validó cédula y NIT solo con estos campos: Factus no exige tributo, dirección ni
    // municipio (rellena «No informado» y ZZ).
    const c = {
        identification_document_code: a.tipo_documento,
        identification: a.numero_documento,
        legal_organization_code: a.tipo_persona,
    };
    if (a.tipo_documento === '31' && a.dv !== null && a.dv !== undefined) c.dv = String(a.dv);
    if (a.tipo_persona === '1') c.company = a.razon_social;
    else c.names = a.nombres;
    if (a.correo) c.email = a.correo;
    if (a.telefono) c.phone = a.telefono;
    if (a.direccion) c.address = a.direccion;
    return c;
}

function traducirLinea(l) {
    return {
        code_reference: l.codigo,
        name: l.descripcion,
        quantity: txt(l.cantidad),
        discount_rate: '0.00',
        price: txt(l.precio_neto),
        unit_measure_code: UNIDADES_CONFIRMADAS.has(String(l.unidad_medida)) ? String(l.unidad_medida) : '94',
        standard_code: '999',
        taxes:
            l.codigo_impuesto === 'ZZ'
                ? [{ is_excluded: true }]
                : [{ code: l.codigo_impuesto, rate: txt(l.tarifa_impuesto) }],
    };
}

function traducirPagos(pagos) {
    return pagos.map((p) => ({
        payment_form: '1', // contado
        payment_method_code: p.codigo_dian,
        amount: txt(p.valor),
    }));
}

function traducirFactura({ documento, lineas, idRango }) {
    return {
        reference_code: documento.codigo_referencia,
        document: '01', // factura electrónica de venta (D1)
        operation_type: '10', // estándar
        numbering_range_id: idRango, // D3
        // El correo al comprador lo manda EscalApp con la marca del negocio (correoFactura.js),
        // no el proveedor: si los dos lo mandaran, el cliente recibiría dos correos.
        send_email: false,
        observation: `Pedido ${documento.origen_referencia}`,
        payment_details: traducirPagos(documento.pagos),
        customer: traducirComprador(documento.adquiriente),
        items: lineas.map(traducirLinea),
    };
}

/** Anulación total (D17): mismo cuerpo que la factura más la referencia a la que anula. */
function traducirNotaCredito({ documento, lineas, facturaReferencia, idRango }) {
    return {
        reference_code: documento.codigo_referencia,
        correction_concept_code: '2', // anulación de la factura electrónica
        customization_id: '20', // nota que referencia una factura
        bill_number: facturaReferencia.numero,
        numbering_range_id: idRango,
        send_email: false,
        observation: `Anula la factura ${facturaReferencia.numero} (pedido ${documento.origen_referencia})`,
        payment_details: traducirPagos(documento.pagos),
        customer: traducirComprador(documento.adquiriente),
        items: lineas.map(traducirLinea),
    };
}

// ─── El puerto ─────────────────────────────────────────────────────────────────────────────

async function probarConexion({ credenciales, ambiente }) {
    const r = await llamar({ credenciales, ambiente, metodo: 'GET', ruta: '/v2/companies' });
    if (r.errorRed) throw fallo('Factus no responde.', 'FE_PROVEEDOR_SIN_RESPUESTA', 502);
    if (r.status === 401) throw fallo('Factus no acepta esas credenciales.', 'FE_CREDENCIALES_INVALIDAS', 401);
    if (r.status !== 200) throw fallo(`Factus respondió HTTP ${r.status}.`, 'FE_PROVEEDOR_ERROR', 502);
    const e = r.cuerpo?.data || {};
    return { nit: e.nit ?? null, dv: e.dv ?? null, razon_social: e.company || e.names || e.trade_name || null };
}

async function listarRangos({ credenciales, ambiente }) {
    const filas = [];
    for (let pagina = 1, ultima = 1; pagina <= ultima; pagina++) {
        const r = await llamar({ credenciales, ambiente, metodo: 'GET', ruta: `/v2/numbering-ranges?page=${pagina}` });
        if (r.status !== 200) throw fallo(`Factus respondió HTTP ${r.status ?? 'sin respuesta'}.`, 'FE_PROVEEDOR_ERROR', 502);
        const d = r.cuerpo?.data;
        filas.push(...(Array.isArray(d) ? d : d?.data || []));
        ultima = d?.pagination?.last_page ?? 1;
    }
    return filas
        .filter((x) => x.is_active && !x.deleted_at)
        .map((x) => ({
            id: Number(x.id),
            // Lo que no es factura ni nota crédito (documento soporte, nómina) sale con null y
            // quien sincroniza lo omite, en vez de adivinarle un tipo.
            tipoDocumento: TIPO_DE_RANGO[String(x.document || '').trim().toLowerCase()] ?? null,
            prefijo: x.prefix ?? null,
            desde: x.from ?? null,
            hasta: x.to ?? null,
            actual: x.current ?? null,
            resolucion: x.resolution_number ?? null,
            vigenciaDesde: x.start_date ?? null,
            vigenciaHasta: x.end_date ?? null,
            vencido: Boolean(Number(x.is_expired)),
        }));
}

/**
 * Lo que la DIAN tiene asociado al software de este negocio. Es el paso previo a crear el rango:
 * el cliente asocia el prefijo en el portal de la DIAN y aquí se ve si ya aparece.
 */
async function listarRangosDian({ credenciales, ambiente }) {
    const r = await llamar({ credenciales, ambiente, metodo: 'GET', ruta: '/v2/numbering-ranges/dian' });
    if (r.status !== 200) throw fallo(`Factus respondió HTTP ${r.status ?? 'sin respuesta'}.`, 'FE_PROVEEDOR_ERROR', 502);
    const d = r.cuerpo?.data;
    return (Array.isArray(d) ? d : d?.data || []).map((x) => ({
        prefijo: x.prefix ?? null,
        resolucion: x.resolution_number != null ? String(x.resolution_number) : null,
        desde: x.from ?? null,
        hasta: x.to ?? null,
        vigenciaDesde: x.start_date ?? null,
        vigenciaHasta: x.end_date ?? null,
    }));
}

/**
 * Crea el rango en Factus. **Factus no lo toma solo** de la DIAN: hasta que alguien lo crea por
 * aquí, `listarRangos` no lo devuelve y no se puede emitir (aprendido en Orbita, 2026-10-07).
 *
 * La factura lleva la resolución que autorizó la DIAN; la nota crédito no tiene resolución y solo
 * necesita prefijo y número de inicio.
 */
async function crearRango({ credenciales, ambiente, tipoDocumento, prefijo, resolucion = null, actual }) {
    const json = { document: CODIGO_DE_RANGO[tipoDocumento], prefix: prefijo, current: String(actual) };
    if (!json.document) throw fallo(`Tipo de rango inválido: ${tipoDocumento}`, 'FE_RANGO_INVALIDO', 422);
    if (resolucion) json.resolution_number = String(resolucion);
    const r = await llamar({ credenciales, ambiente, metodo: 'POST', ruta: '/v2/numbering-ranges', json });
    if (r.status === null || r.status >= 400) {
        const detalle = erroresDeValidacion(r.cuerpo).map((x) => x.mensaje).join(' ') || r.cuerpo?.message || '';
        throw fallo(
            `Factus no creó el rango (HTTP ${r.status ?? 'sin respuesta'}). ${detalle}`.trim(),
            'FE_RANGO_NO_CREADO',
            [400, 409, 422].includes(r.status) ? 422 : 502
        );
    }
    const x = r.cuerpo?.data ?? {};
    return { id: Number(x.id), prefijo: x.prefix ?? prefijo, actual: x.current ?? actual };
}

async function emitirFactura(args) {
    const payload = traducirFactura(args);
    const r = await llamar({ ...args, metodo: 'POST', ruta: RUTAS.FV.emitir, json: payload });
    return { ...clasificar(r), payload };
}

async function emitirNotaCredito(args) {
    const payload = traducirNotaCredito(args);
    const r = await llamar({ ...args, metodo: 'POST', ruta: RUTAS.NC.emitir, json: payload });
    return { ...clasificar(r), payload };
}

/**
 * ¿Llegó a Factus un envío del que no supimos la respuesta? Busca por referencia y, si está,
 * trae el documento entero (la búsqueda no devuelve el CUFE ni los enlaces).
 *
 * @returns {Promise<object|null>} `null` = Factus no tiene nada con esa referencia.
 */
async function consultarPorReferencia({ credenciales, ambiente, codigoReferencia }) {
    const busqueda = await llamar({
        credenciales,
        ambiente,
        metodo: 'GET',
        ruta: `/v2/bills?filter[reference_code]=${encodeURIComponent(codigoReferencia)}`,
    });
    if (busqueda.status !== 200) return { ...clasificar(busqueda), payload: null };
    const d = busqueda.cuerpo?.data;
    const lista = Array.isArray(d) ? d : d?.data || [];
    // El filtro de Factus no promete ser exacto: se compara aquí.
    const hallado = lista.find((x) => x.reference_code === codigoReferencia);
    if (!hallado) return null;
    const detalle = await llamar({
        credenciales,
        ambiente,
        metodo: 'GET',
        ruta: `${RUTAS.FV.ver}/${encodeURIComponent(hallado.number)}`,
    });
    return { ...clasificar(detalle), payload: null };
}

/** Quita de Factus una factura que no se validó: mientras exista, bloquea las siguientes (409). */
async function eliminarPendiente({ credenciales, ambiente, codigoReferencia }) {
    const r = await llamar({
        credenciales,
        ambiente,
        metodo: 'DELETE',
        ruta: `${RUTAS.FV.eliminar}/${encodeURIComponent(codigoReferencia)}`,
    });
    if (r.status === null || r.status >= 400) {
        throw fallo(
            `No se pudo eliminar la factura pendiente (HTTP ${r.status ?? 'sin respuesta'}).`,
            'FE_PROVEEDOR_ERROR',
            502
        );
    }
}

async function descargarArchivo({ credenciales, ambiente, numero, tipo, documento = 'FV' }) {
    const [sufijo, campo] = tipo === 'PDF' ? ['download-pdf', 'pdf_base_64_encoded'] : ['download-xml', 'xml_base_64_encoded'];
    const r = await llamar({
        credenciales,
        ambiente,
        metodo: 'GET',
        ruta: `${RUTAS[documento].ver}/${encodeURIComponent(numero)}/${sufijo}`,
    });
    const b64 = r.cuerpo?.data?.[campo];
    if (!b64) throw fallo(`Factus no devolvió el ${tipo} de ${numero}.`, 'FE_ARCHIVO_NO_DISPONIBLE', 502);
    return Buffer.from(b64, 'base64');
}

module.exports = {
    codigo: 'FACTUS',
    probarConexion,
    listarRangos,
    listarRangosDian,
    crearRango,
    emitirFactura,
    emitirNotaCredito,
    consultarPorReferencia,
    eliminarPendiente,
    descargarArchivo,
    // Expuestas para las pruebas y para quien necesite la traducción sin enviar nada.
    clasificar,
    traducirFactura,
    traducirNotaCredito,
    fechaDeFactus,
    olvidarTokens,
};
