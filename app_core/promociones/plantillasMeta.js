/**
 * Las plantillas de promoción en la WABA **del inquilino** (F2 de `docs/promociones-masivas.md`).
 *
 * ## El muro que esto derriba
 *
 * Un mensaje a alguien que no escribió en las últimas 24 h solo sale por **plantilla aprobada por
 * Meta, palabra por palabra**. Y una promoción es texto nuevo cada semana. La salida, decidida en
 * §3 del documento: **una biblioteca de 2 plantillas reusables con huecos**, creadas y aprobadas
 * **antes** de que al dueño se le ocurra la promoción — no el viernes a las 6 p. m., que es cuando
 * se le ocurre.
 *
 * El texto vive en `intelligence/core/plantillas.js` y **de ahí se somete**. No se copia a mano al
 * gestor de Meta, que es lo que ya costó un `#132001` con `pedido_listo`: el catálogo no puede
 * derivar de lo aprobado si lo aprobado se genera desde el catálogo.
 *
 * ## ⚠️ En la WABA del inquilino, y solo si es suya
 *
 * Como Tech Provider, el número que conecta un inquilino crea **su propia** empresa y WABA
 * (`embedded-signup.md` §9.1). Las plantillas se crean ahí, con **su** token. Un negocio de alta
 * manual cuelga de NUESTRA WABA, y crearle una plantilla de marketing ahí significaría que **Meta
 * nos factura a nosotros** sus envíos y que su mala calificación es la nuestra — y la nuestra la
 * comparten todos los inquilinos. Por eso se comprueba `origen = 'embedded_signup'` y, si no, se
 * niega con un error tipado en vez de «funcionar».
 *
 * ## Los dos estados que importan
 *
 * Crear una plantilla no es tenerla: Meta la revisa. De minutos a 24 h, y puede rechazarla. Así
 * que `platform.plantilla_promocion` guarda el estado y **nadie envía con una que no esté
 * `APPROVED`**. El estado se refresca preguntándoselo a Meta (`sincronizar`), y el día que haga
 * falta tiempo real está el webhook `message_template_status_update` — que no se usa todavía a
 * propósito: exige campo nuevo en la app de Meta y la encuesta cuesta una llamada.
 */
'use strict';

const Models = require('../models/conection');
const catalogo = require('../../intelligence/core/plantillas');
const numeros = require('../../intelligence/channels/whatsapp/numeros');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };

/**
 * Versión de la Graph API para la gestión de plantillas.
 *
 * Separada de la de mensajería (`WHATSAPP_API_VERSION`) por lo mismo que la de Embedded Signup:
 * subir de versión aquí no debe arrastrar al camino por el que salen los mensajes de todos los
 * días.
 */
const VERSION_API = process.env.META_PLANTILLAS_API_VERSION || 'v23.0';
const BASE = process.env.META_GRAPH_URL || 'https://graph.facebook.com';
const TIMEOUT_MS = 20000;

function fallo(mensaje, { code, statusCode = 422, detalle = null }) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    e.detalle = detalle;
    return e;
}

async function llamar(url, { metodo = 'GET', cuerpo = null, token, fetchImpl = globalThis.fetch }) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
    let respuesta;
    try {
        respuesta = await fetchImpl(url, {
            method: metodo,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
            signal: control.signal,
        });
    } catch (error) {
        throw fallo(`No se pudo llamar a la Graph API: ${error.message}`, {
            code: 'META_RED',
            statusCode: 503,
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
 * El negocio con el que EscalApp se prueba a sí misma: el que atiende el número de la plataforma
 * (`WHATSAPP_NEGOCIO_ID`). Hoy es «Restaurante pregonchos», y el piloto de las promociones sale
 * por ahí.
 */
function esNegocioDeLaPlataforma(idNegocio) {
    const propio = Number(process.env.WHATSAPP_NEGOCIO_ID || 0);
    return propio > 0 && Number(idNegocio) === propio;
}

/**
 * El canal del inquilino, comprobado para crear plantillas.
 *
 * Falla cerrado y **con el motivo**, porque los tres casos se arreglan de formas distintas y el
 * dueño tiene que poder saber cuál le toca.
 */
function canalDe(idNegocio) {
    const origen = numeros.origenDeNegocio(idNegocio);
    if (!origen) {
        throw fallo('Este negocio no tiene un número de WhatsApp conectado.', {
            code: 'PROMOS_SIN_CANAL',
        });
    }
    if (origen !== 'embedded_signup') {
        // ⚠️ **La única excepción, y el motivo por el que existe.** Se niega un canal de alta
        // manual porque cuelga de NUESTRA WABA: Meta nos facturaría a nosotros los envíos de un
        // inquilino y su mala calificación sería la de todos los demás. Para el negocio con el que
        // EscalApp se prueba a sí misma ese argumento se da la vuelta — la factura y la
        // calificación son nuestras, y somos nosotros los que decidimos arriesgarlas—. Sin esto el
        // piloto es imposible: el único negocio al que se le encendió la función vería para
        // siempre «conecta tu propio número», y la primera campaña real —la que valida el camino
        // entero antes de vendérselo a nadie— no se podría mandar nunca.
        if (esNegocioDeLaPlataforma(idNegocio)) {
            const token = process.env.WHATSAPP_TOKEN || null;
            const wabaId = process.env.WHATSAPP_WABA_ID || null;
            if (!token || !wabaId) {
                throw fallo(
                    'Faltan WHATSAPP_TOKEN o WHATSAPP_WABA_ID en el servidor: sin ellos no se '
                    + 'pueden crear las plantillas en la cuenta de EscalApp.',
                    { code: 'PROMOS_CANAL_INCOMPLETO' },
                );
            }
            return { token, wabaId, deLaPlataforma: true };
        }
        throw fallo(
            'Este número está conectado a la cuenta de WhatsApp de EscalApp. Para mandar '
            + 'promociones el negocio tiene que conectar su propio número.',
            { code: 'PROMOS_CANAL_NO_PROPIO' },
        );
    }
    const token = numeros.tokenDeNegocio(idNegocio);
    const wabaId = numeros.wabaDeNegocio(idNegocio);
    if (!token || !wabaId) {
        throw fallo('Falta el token o la cuenta de WhatsApp del negocio. Hay que reconectar el número.', {
            code: 'PROMOS_CANAL_INCOMPLETO',
        });
    }
    return { token, wabaId, deLaPlataforma: false };
}

/**
 * Traduce una plantilla del catálogo a lo que espera Meta al crearla.
 *
 * ## El `example` no es opcional
 *
 * Meta rechaza una plantilla con huecos que no venga con un ejemplo de cada uno: es lo que lee la
 * persona que la revisa. Así que los ejemplos se escriben aquí, y se escriben **plausibles** — un
 * «texto de prueba» en el hueco de la oferta es una invitación al rechazo.
 */
function cuerpoParaMeta(definicion, { ejemploHandle = null } = {}) {
    const componentes = [];

    if (definicion.encabezado === 'IMAGE') {
        if (!ejemploHandle) {
            throw fallo(
                `La plantilla "${definicion.nombre}" lleva imagen y Meta exige una de ejemplo. `
                + 'Hay que subir una imagen antes de crearla.',
                { code: 'PROMOS_PLANTILLA_SIN_EJEMPLO' },
            );
        }
        componentes.push({
            type: 'HEADER',
            format: 'IMAGE',
            example: { header_handle: [ejemploHandle] },
        });
    }

    componentes.push({
        type: 'BODY',
        text: definicion.texto,
        ...(definicion.parametros?.length
            ? {
                  example: {
                      // En el orden del catálogo, que es el del contrato con Meta.
                      body_text: [[
                          'Ana',
                          'Zona Burger',
                          '2 hamburguesas por $20.000 hasta el domingo',
                      ].slice(0, definicion.parametros.length)],
                  },
              }
            : {}),
    });

    if (definicion.pie) componentes.push({ type: 'FOOTER', text: definicion.pie });

    if (definicion.botones?.length) {
        componentes.push({
            type: 'BUTTONS',
            buttons: definicion.botones.map((b) => ({ type: b.tipo, text: b.texto })),
        });
    }

    return {
        name: definicion.nombre,
        language: definicion.idioma,
        category: definicion.categoria,
        components: componentes,
    };
}

/**
 * Sube una imagen de ejemplo y devuelve su `handle`.
 *
 * Es la API de subidas reanudables de Meta, en dos pasos: se abre una sesión declarando tamaño y
 * tipo, y se manda el binario contra esa sesión. Lo que devuelve (`h`) es lo único que acepta
 * `example.header_handle`.
 *
 * ⚠️ **Usa el token de la app, no el del inquilino.** Las subidas cuelgan de la aplicación de
 * Meta (`WHATSAPP_APP_ID`), no de la WABA. Sin esas variables, esto falla con un motivo claro en
 * vez de un 400 de Meta.
 */
async function subirEjemplo({
    buffer,
    tipoMime = 'image/jpeg',
    appId = process.env.WHATSAPP_APP_ID,
    appSecret = process.env.WHATSAPP_APP_SECRET,
    fetchImpl = globalThis.fetch,
} = {}) {
    if (!appId || !appSecret) {
        throw fallo(
            'Faltan WHATSAPP_APP_ID / WHATSAPP_APP_SECRET: sin ellas no se puede subir la imagen '
            + 'de ejemplo que Meta pide para aprobar la plantilla.',
            { code: 'PROMOS_APP_SIN_CREDENCIAL', statusCode: 500 },
        );
    }
    if (!buffer?.length) {
        throw fallo('La imagen de ejemplo está vacía.', { code: 'PROMOS_EJEMPLO_VACIO' });
    }

    const tokenApp = `${appId}|${appSecret}`;

    const sesion = await llamar(
        `${BASE}/${VERSION_API}/${appId}/uploads`
        + `?file_length=${buffer.length}&file_type=${encodeURIComponent(tipoMime)}`,
        { metodo: 'POST', token: tokenApp, fetchImpl },
    );
    if (!sesion.ok || !sesion.datos?.id) {
        throw fallo(`Meta no abrió la subida: ${sesion.datos?.error?.message || sesion.status}`, {
            code: 'PROMOS_SUBIDA_RECHAZADA',
            detalle: sesion.datos?.error ?? null,
        });
    }

    // El segundo paso no es JSON: va el binario crudo con `file_offset: 0`.
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), TIMEOUT_MS * 2);
    let respuesta;
    try {
        respuesta = await fetchImpl(`${BASE}/${VERSION_API}/${sesion.datos.id}`, {
            method: 'POST',
            headers: {
                Authorization: `OAuth ${tokenApp}`,
                file_offset: '0',
                'Content-Type': tipoMime,
            },
            body: buffer,
            signal: control.signal,
        });
    } catch (error) {
        throw fallo(`No se pudo subir la imagen: ${error.message}`, {
            code: 'META_RED',
            statusCode: 503,
        });
    } finally {
        clearTimeout(reloj);
    }

    const texto = await respuesta.text();
    let datos = null;
    try {
        datos = texto ? JSON.parse(texto) : null;
    } catch {
        datos = null;
    }
    if (!respuesta.ok || !datos?.h) {
        throw fallo(`Meta no aceptó la imagen: ${datos?.error?.message || respuesta.status}`, {
            code: 'PROMOS_SUBIDA_RECHAZADA',
            detalle: datos?.error ?? null,
        });
    }
    return datos.h;
}

/** Lo que tenemos guardado de las plantillas de un negocio. */
async function estadoDe({ idNegocio, transaction = null } = {}) {
    const filas = await sequelize.query(
        `SELECT nombre, idioma, estado_meta, id_meta, motivo_rechazo, ejemplo_handle, revisado_en
           FROM platform.plantilla_promocion
          WHERE id_negocio = :idNegocio;`,
        { replacements: { idNegocio: Number(idNegocio) }, ...SELECT, transaction }
    );
    const porNombre = new Map(filas.map((f) => [f.nombre, f]));

    return catalogo.deMarketing().map((d) => {
        const fila = porNombre.get(d.nombre);
        return {
            nombre: d.nombre,
            idioma: d.idioma,
            necesita_imagen: d.encabezado === 'IMAGE',
            estado: fila?.estado_meta ?? 'NO_CREADA',
            motivo_rechazo: fila?.motivo_rechazo ?? null,
            revisado_en: fila?.revisado_en ?? null,
            /** Lo único que decide si se puede enviar con ella. */
            usable: fila?.estado_meta === 'APPROVED',
        };
    });
}

/** ¿Hay alguna plantilla aprobada? Es la pregunta que hace la compuerta de elegibilidad. */
async function hayAlgunaAprobada({ idNegocio, transaction = null } = {}) {
    const estados = await estadoDe({ idNegocio, transaction });
    return estados.some((e) => e.usable);
}

async function guardar({ idNegocio, definicion, estado, idMeta = null, motivo = null, handle = null }) {
    await sequelize.query(
        `INSERT INTO platform.plantilla_promocion
             (id_negocio, nombre, idioma, estado_meta, id_meta, motivo_rechazo, ejemplo_handle, revisado_en)
         VALUES (:idNegocio, :nombre, :idioma, :estado, :idMeta, :motivo, :handle, now())
         ON CONFLICT (id_negocio, nombre, idioma) DO UPDATE
            SET estado_meta    = EXCLUDED.estado_meta,
                id_meta        = COALESCE(EXCLUDED.id_meta, plantilla_promocion.id_meta),
                motivo_rechazo = EXCLUDED.motivo_rechazo,
                ejemplo_handle = COALESCE(EXCLUDED.ejemplo_handle, plantilla_promocion.ejemplo_handle),
                revisado_en    = now();`,
        {
            replacements: {
                idNegocio: Number(idNegocio),
                nombre: definicion.nombre,
                idioma: definicion.idioma,
                estado,
                idMeta,
                motivo,
                handle,
            },
        }
    );
}

/**
 * Crea en la WABA del inquilino las plantillas de marketing que le falten.
 *
 * Idempotente de dos formas, y las dos hacen falta: no pide las que ya están guardadas como
 * aprobadas o pendientes, y si Meta contesta que **ya existe** (código 2388023 / «already
 * exists»), eso se trata como un éxito y se pasa a preguntar su estado. Lo contrario —tratarlo
 * como error— dejaría a un negocio sin poder enviar por una plantilla que sí tiene.
 *
 * @param {Object} opciones
 * @param {Buffer} [opciones.imagenEjemplo] — para la plantilla con imagen. Sin ella, esa se omite
 *        con su motivo y la de texto se crea igual: así el negocio nunca se queda sin camino.
 */
async function asegurar({ idNegocio, imagenEjemplo = null, fetchImpl = globalThis.fetch } = {}) {
    await numeros.asegurarCargado();
    const { token, wabaId } = canalDe(idNegocio);

    const guardadas = await estadoDe({ idNegocio });
    const porNombre = new Map(guardadas.map((g) => [g.nombre, g]));
    const resultado = [];

    for (const definicion of catalogo.deMarketing()) {
        const previa = porNombre.get(definicion.nombre);
        // Ya aprobada o esperando a Meta: no se vuelve a pedir. Una rechazada sí se reintenta,
        // porque el texto del catálogo puede haber cambiado desde el rechazo.
        if (previa && ['APPROVED', 'PENDIENTE'].includes(previa.estado)) {
            resultado.push({ nombre: definicion.nombre, estado: previa.estado, accion: 'ya_estaba' });
            continue;
        }

        let handle = null;
        if (definicion.encabezado === 'IMAGE') {
            if (imagenEjemplo) {
                try {
                    handle = await subirEjemplo({ buffer: imagenEjemplo, fetchImpl });
                } catch (error) {
                    resultado.push({
                        nombre: definicion.nombre,
                        estado: 'NO_CREADA',
                        accion: 'omitida',
                        motivo: error.message,
                    });
                    continue;
                }
            } else {
                resultado.push({
                    nombre: definicion.nombre,
                    estado: 'NO_CREADA',
                    accion: 'omitida',
                    motivo: 'Hace falta una imagen de ejemplo para que Meta la revise.',
                });
                continue;
            }
        }

        const r = await llamar(`${BASE}/${VERSION_API}/${wabaId}/message_templates`, {
            metodo: 'POST',
            token,
            cuerpo: cuerpoParaMeta(definicion, { ejemploHandle: handle }),
            fetchImpl,
        });

        const yaExistia =
            !r.ok
            && (r.datos?.error?.error_subcode === 2388023
                || /already exists/i.test(r.datos?.error?.message || ''));

        if (!r.ok && !yaExistia) {
            await guardar({
                idNegocio,
                definicion,
                estado: 'REJECTED',
                motivo: r.datos?.error?.message || `Meta respondió ${r.status}`,
                handle,
            });
            resultado.push({
                nombre: definicion.nombre,
                estado: 'REJECTED',
                accion: 'rechazada',
                motivo: r.datos?.error?.message || null,
            });
            continue;
        }

        await guardar({
            idNegocio,
            definicion,
            // Lo que contesta Meta al crear suele ser `PENDING`; lo normalizamos a nuestro
            // 'PENDIENTE' hasta que `sincronizar` traiga el estado de verdad.
            estado: r.datos?.status === 'APPROVED' ? 'APPROVED' : 'PENDIENTE',
            idMeta: r.datos?.id ?? null,
            motivo: null,
            handle,
        });
        resultado.push({
            nombre: definicion.nombre,
            estado: r.datos?.status === 'APPROVED' ? 'APPROVED' : 'PENDIENTE',
            accion: yaExistia ? 'ya_existia_en_meta' : 'creada',
        });
    }

    // Con alguna recién creada conviene preguntar ya: Meta aprueba estas en segundos a veces, y
    // así el dueño no tiene que volver más tarde a ver si puede enviar.
    if (resultado.some((r) => r.accion === 'creada' || r.accion === 'ya_existia_en_meta')) {
        await sincronizar({ idNegocio, fetchImpl }).catch(() => null);
    }

    return { plantillas: await estadoDe({ idNegocio }), detalle: resultado };
}

/**
 * Pregunta a Meta en qué estado están y lo guarda.
 *
 * Se consulta por nombre y se cruza por nombre + idioma, que es como Meta identifica una plantilla
 * (y la lección de `#132001`: un `es` contra un `es_CO` no es un detalle de traducción).
 */
async function sincronizar({ idNegocio, fetchImpl = globalThis.fetch } = {}) {
    await numeros.asegurarCargado();
    const { token, wabaId } = canalDe(idNegocio);

    const nombres = catalogo.deMarketing().map((d) => d.nombre);
    const r = await llamar(
        `${BASE}/${VERSION_API}/${wabaId}/message_templates`
        + `?fields=name,language,status,category,id,rejected_reason&limit=100`,
        { token, fetchImpl },
    );
    if (!r.ok) {
        throw fallo(`Meta no devolvió las plantillas: ${r.datos?.error?.message || r.status}`, {
            code: 'PROMOS_PLANTILLAS_NO_LEIDAS',
            statusCode: 502,
        });
    }

    const deMeta = (r.datos?.data || []).filter((p) => nombres.includes(p.name));

    for (const definicion of catalogo.deMarketing()) {
        const suya = deMeta.find(
            (p) => p.name === definicion.nombre && p.language === definicion.idioma
        );
        if (!suya) continue;
        await guardar({
            idNegocio,
            definicion,
            estado: ['APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL'].includes(suya.status)
                ? suya.status
                : 'PENDIENTE',
            idMeta: suya.id ?? null,
            motivo: suya.rejected_reason && suya.rejected_reason !== 'NONE' ? suya.rejected_reason : null,
        });
    }

    return estadoDe({ idNegocio });
}

module.exports = {
    VERSION_API,
    canalDe,
    esNegocioDeLaPlataforma,
    cuerpoParaMeta,
    subirEjemplo,
    estadoDe,
    hayAlgunaAprobada,
    asegurar,
    sincronizar,
};
