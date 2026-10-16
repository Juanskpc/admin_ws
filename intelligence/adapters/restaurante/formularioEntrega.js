/**
 * El formulario de entrega del restaurante (WhatsApp Flows, desde 2026-10-16).
 *
 * En vez de preguntar «¿domicilio o recoger?» y después barrio y dirección de a uno, el asistente
 * manda un botón «Completar datos» que abre un formulario dentro del chat: cómo lo recibe, y —solo
 * si es a domicilio— barrio, dirección e indicaciones, más la forma de pago. Diseño, prueba en el
 * celular y decisiones del dueño en `docs/whatsapp-flows.md`.
 *
 * ## Se enciende por negocio, y nace apagado
 *
 * `gener_negocio.formulario_entrega_flow_id`: el id del Flow **publicado en la WABA de ese
 * negocio** (cada WABA tiene los suyos). `NULL` = el negocio sigue exactamente como antes. Lo
 * crea, publica y guarda `scripts/formulario_entrega_whatsapp.js`. Solo se ofrece por WhatsApp.
 *
 * ## El barrio es texto, a propósito
 *
 * La gente no sabe a qué comuna pertenece su barrio (decisión del dueño, 2026-10-15), así que el
 * formulario no le pide elegir de una lista: lo escribe, y lo busca `elegirBarrio` con la misma
 * lógica del paso del barrio —varios con el mismo nombre se preguntan numerados en el chat—.
 *
 * ## El camino de texto sigue abierto
 *
 * El mensaje dice también qué escribir. Un formulario que no se abre (WhatsApp viejo, escritorio)
 * no puede dejar a nadie sin pedir.
 */
'use strict';

const Models = require('../../../app_core/models/conection');
const { ENCABEZADO_FORMULARIO } = require('../../core/mensajeCanonico');

const PANTALLA = 'DATOS_ENTREGA';
const ID_OPCION = 'formulario_entrega';
const ETIQUETA = 'Completar datos';

/** Los ids que vuelven en «Entrega: …». Cortos y sin tildes: viajan como valor del formulario. */
const ENTREGA = { DOMICILIO: 'domicilio', RECOGER: 'recoger', SERVIR: 'servir' };
const PAGOS = ['Efectivo', 'Nequi', 'Transferencia'];

/**
 * El Flow JSON que se publica. Los títulos de campo van a 20 caracteres como mucho y sin
 * «(opcional)»: WhatsApp lo añade solo y, más largos, el celular pinta un error (prueba real del
 * 2026-10-15). Las opciones de entrega y de pago llegan como datos al abrirlo, para que «Para
 * servir» solo salga en un negocio con mesas sin tener que publicar otro formulario.
 */
const FLOW_JSON = {
    version: '6.0',
    screens: [
        {
            id: PANTALLA,
            title: 'Datos de entrega',
            terminal: true,
            data: {
                entregas: {
                    type: 'array',
                    items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
                    __example__: [
                        { id: ENTREGA.DOMICILIO, title: 'A domicilio' },
                        { id: ENTREGA.RECOGER, title: 'Paso a recoger' },
                    ],
                },
                pagos: {
                    type: 'array',
                    items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
                    __example__: [{ id: 'Efectivo', title: 'Efectivo' }],
                },
            },
            layout: {
                type: 'SingleColumnLayout',
                children: [
                    {
                        type: 'RadioButtonsGroup',
                        name: 'entrega',
                        label: '¿Cómo lo recibes?',
                        required: true,
                        'data-source': '${data.entregas}',
                    },
                    {
                        type: 'If',
                        condition: `\${form.entrega} == '${ENTREGA.DOMICILIO}'`,
                        then: [
                            {
                                type: 'TextInput',
                                name: 'barrio',
                                label: 'Barrio',
                                'input-type': 'text',
                                required: true,
                                'helper-text': 'Escríbelo como lo conoces, nosotros lo ubicamos',
                            },
                            {
                                type: 'TextInput',
                                name: 'direccion',
                                label: 'Dirección',
                                'input-type': 'text',
                                required: true,
                            },
                            {
                                type: 'TextArea',
                                name: 'indicaciones',
                                label: 'Indicaciones',
                                required: false,
                                'helper-text': 'Ej.: casa esquinera, reja negra',
                            },
                        ],
                    },
                    {
                        type: 'RadioButtonsGroup',
                        name: 'pago',
                        label: '¿Cómo pagas?',
                        required: true,
                        'data-source': '${data.pagos}',
                    },
                    {
                        type: 'Footer',
                        label: 'Enviar',
                        'on-click-action': {
                            name: 'complete',
                            payload: {
                                entrega: '${form.entrega}',
                                barrio: '${form.barrio}',
                                direccion: '${form.direccion}',
                                indicaciones: '${form.indicaciones}',
                                pago: '${form.pago}',
                            },
                        },
                    },
                ],
            },
        },
    ],
};

/**
 * El id del Flow publicado de este negocio, o `null` (apagado). Falla cerrado: si la columna no
 * existe todavía o la base no contesta, el negocio sigue con los botones de siempre.
 */
async function flowIdDe(idNegocio) {
    try {
        const [fila] = await Models.sequelize.query(
            `SELECT formulario_entrega_flow_id AS flow_id
               FROM general.gener_negocio WHERE id_negocio = :id`,
            { replacements: { id: Number(idNegocio) }, type: Models.sequelize.QueryTypes.SELECT }
        );
        const id = fila?.flow_id ? String(fila.flow_id).trim() : '';
        return id || null;
    } catch {
        return null;
    }
}

/** La opción canónica que abre el formulario (ver `mensajeCanonico.normalizarSalida`). */
function opcion({ flowId, idConversacion = null, conMesas = false }) {
    return {
        id: ID_OPCION,
        etiqueta: ETIQUETA,
        formulario: {
            flow_id: String(flowId),
            pantalla: PANTALLA,
            token: `entrega:${idConversacion ?? 'sin-conversacion'}`,
            datos: {
                entregas: [
                    { id: ENTREGA.DOMICILIO, title: 'A domicilio' },
                    { id: ENTREGA.RECOGER, title: 'Paso a recoger' },
                    ...(conMesas ? [{ id: ENTREGA.SERVIR, title: 'Para servir aquí' }] : []),
                ],
                pagos: PAGOS.map((p) => ({ id: p, title: p })),
            },
        },
    };
}

/** La pregunta del paso de entrega, con el formulario. Las palabras siguen valiendo. */
function pregunta({ flowId, idConversacion, conMesas }) {
    return {
        texto:
            '¿Cómo lo recibes? 🛵 Toca *Completar datos* y déjame ahí tus datos de entrega.\n\n' +
            `Si prefieres, escríbeme *domicilio* o *recoger*${conMesas ? ' o *para servir*' : ''}.`,
        opciones: [opcion({ flowId, idConversacion, conMesas })],
    };
}

function sinTildes(texto) {
    return String(texto || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim();
}

/**
 * Lee un formulario respondido (el texto que escribe el canal) o devuelve `null` si el mensaje no
 * es uno. Las claves se devuelven sin tildes y en minúscula: `entrega`, `barrio`, `direccion`,
 * `indicaciones`, `pago`.
 */
function leer(texto) {
    const lineas = String(texto || '').split('\n');
    if (lineas[0]?.trim() !== ENCABEZADO_FORMULARIO) return null;
    const campos = {};
    for (const linea of lineas.slice(1)) {
        const i = linea.indexOf(':');
        if (i <= 0) continue;
        const clave = sinTildes(linea.slice(0, i)).replace(/\s+/g, '_');
        const valor = linea.slice(i + 1).trim();
        if (valor) campos[clave] = valor;
    }
    return campos;
}

module.exports = {
    PANTALLA,
    ID_OPCION,
    ETIQUETA,
    ENTREGA,
    PAGOS,
    FLOW_JSON,
    flowIdDe,
    opcion,
    pregunta,
    leer,
};
