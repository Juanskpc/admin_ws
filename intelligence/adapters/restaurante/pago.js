/**
 * Pagar y «cancelar» en el asistente de restaurante.
 *
 * ## «Cancelar» en Colombia es pagar
 *
 * «¿Cuánto le cancelo?», «cancelo por Nequi», «le cancelo al domiciliario»: casi siempre es PAGAR,
 * y hasta el 2026-10-03 el modelo lo leía a veces como anular el pedido. Ahora cualquier mensaje
 * con «cancel…» (sin «anul…») se contesta con una pregunta de dos botones —anular o pagar— y lo que
 * el cliente toque decide. Nada se anula por una palabra ambigua.
 *
 * ## Cómo se paga depende del pedido
 *
 *  - A domicilio: transferencia o efectivo, al llegar el domiciliario.
 *  - Para llevar o en mesa: transferencia a la llave BreB / Nequi del local.
 *
 * El texto de cada caso lo escribe el negocio (`gener_negocio.pago_texto_domicilio` y
 * `pago_texto_local`); aquí no hay números ni cuentas. Sin texto configurado el asistente no
 * inventa nada y sigue como antes (el modelo con `consultar_info_negocio`).
 */
'use strict';

const Models = require('../../../app_core/models/conection');
const { normalizar, ultimaLinea } = require('../../engine/texto');

/** Ids de los botones. Llegan como el texto del mensaje (ver `canal whatsapp#textoDeMensaje`). */
const OPCION_PAGO = { ANULAR: 'anular_pedido', PAGAR: 'pagar_pedido' };

const PREGUNTA_ANULAR_O_PAGAR = '¿Deseas anular el pedido o pagar?';

const MAX_PALABRAS = 12;

function limpiar(texto) {
    return normalizar(ultimaLinea(texto)).replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** El cliente tocó (o escribió) «Anular el pedido». */
function eligioAnular(texto) {
    const t = limpiar(texto);
    return t === OPCION_PAGO.ANULAR;
}

/** El cliente tocó (o escribió) «Pagar». */
function eligioPagar(texto) {
    const t = limpiar(texto);
    return t === OPCION_PAGO.PAGAR || /^(pagar|pago|quiero pagar|voy a pagar|pagar el pedido|a pagar)$/.test(t);
}

/**
 * ¿Dice «cancelar» (o «cancelo», «cancela», «cancelé»…) sin decir que quiere anular? Es ambiguo, así
 * que se pregunta. Si ya dice «anular / anúlalo» no es ambiguo: lo atiende el modelo con su
 * confirmación de siempre. Solo mensajes cortos: «si se demora mucho cancelo, pero quiero dos
 * salchipapas…» es un pedido, no esto.
 */
function esCancelarAmbiguo(texto) {
    const t = limpiar(texto);
    if (!t || t.split(' ').length > MAX_PALABRAS) return false;
    if (/\banul/.test(t)) return false;
    return /\bcancel(ar|arlo|arla|o|a|e|amos|ando|aria|ado)\b/.test(t);
}

/**
 * ¿Pregunta cómo se paga o pide el Nequi/la llave? Estricto a propósito: «Pago por Nequi» dentro de
 * un pedido NO es esta pregunta. Se reconocen las formas de preguntar, y una sola palabra suelta
 * («Nequi», «transferencia») solo vale con un pedido ya hecho (lo decide quien llama).
 */
const PREGUNTA_PAGO = [
    /\b(como|donde|a donde|por donde|con que|en que|a que) (pago|pagar|puedo pagar|se paga|pagamos|le pago|te pago|transfiero|puedo transferir|consigno)\b/,
    /\b(formas?|medios?|metodos?|opciones) de pago\b/,
    /\b(me )?(das|da|regalas|regala|pasas|pasa|compartes|comparte|envias|envia|mandas|manda|dices|dice) (el |la |tu |su )?(nequi|numero|llave|cuenta|bre ?b|daviplata)\b/,
    /\b(cual es|cual seria|cual) (el |la |tu |su )?(nequi|numero|llave|cuenta|bre ?b)\b/,
    /\b(a que|a cual) (numero|cuenta|nequi|llave)\b/,
    /\b(aceptan|reciben|manejan|tienen) (nequi|daviplata|transferencia|transferencias|efectivo|tarjeta|datafono|bre ?b)\b/,
    /\b(puedo|se puede|podria) (pagar|transferir|cancelar) (por|con|en) /,
];
const PALABRA_SUELTA_PAGO = /^(por )?(nequi|transferencia|trasferencia|transferencias|efectivo|bre ?b|llave|daviplata)( por favor| porfa)?$/;

function esPreguntaDePago(texto, { hayPedido = false } = {}) {
    const t = limpiar(texto);
    if (!t || t.split(' ').length > MAX_PALABRAS) return false;
    if (PREGUNTA_PAGO.some((p) => p.test(t))) return true;
    return hayPedido && PALABRA_SUELTA_PAGO.test(t);
}

/** Los textos de pago del negocio, o `null` en cada uno que no haya configurado. */
async function textosDePago(idNegocio) {
    try {
        const [fila] = await Models.sequelize.query(
            `SELECT pago_texto_domicilio AS domicilio, pago_texto_local AS local
               FROM general.gener_negocio WHERE id_negocio = :idNegocio;`,
            { replacements: { idNegocio }, type: Models.sequelize.QueryTypes.SELECT }
        );
        const limpio = (v) => String(v || '').trim() || null;
        return { domicilio: limpio(fila?.domicilio), local: limpio(fila?.local) };
    } catch (error) {
        console.warn(`[restaurante] no se pudo leer el texto de pago del negocio ${idNegocio}: ${error.message}`);
        return { domicilio: null, local: null };
    }
}

/**
 * Cómo pagar, para un tipo de pedido (`DOMICILIO`, `LLEVAR`, `MESA`) o sin saberlo. Devuelve `null`
 * si el negocio no configuró lo que hace falta: no se inventa un medio de pago.
 */
function frasePago(tipoPedido, textos) {
    const { domicilio, local } = textos || {};
    if (tipoPedido === 'DOMICILIO') return domicilio;
    if (tipoPedido === 'LLEVAR' || tipoPedido === 'MESA') return local;
    // Sin saber el tipo, las dos: es mejor que adivinar uno.
    if (domicilio && local) return `Depende de cómo sea tu pedido:\n\n🛵 *A domicilio:* ${domicilio}\n\n🏪 *Para llevar o en mesa:* ${local}`;
    return domicilio || local || null;
}

/**
 * El último pedido que el asistente tomó en esta conversación y que sigue vivo, o `null`. El
 * número sale del mensaje «El número es ORD-…» (no hay columna que ligue pedido y chat).
 */
async function ultimoPedidoVivo(conversacion, { horas = 12 } = {}) {
    try {
        const [mensaje] = await Models.sequelize.query(
            `SELECT contenido FROM intelligence.mensaje
              WHERE id_conversacion = :c AND direccion = 'saliente' AND contenido ~ 'ORD-[0-9]+'
                AND creado_en >= now() - (:horas * interval '1 hour')
              ORDER BY creado_en DESC LIMIT 1;`,
            { replacements: { c: conversacion.id_conversacion, horas }, type: Models.sequelize.QueryTypes.SELECT }
        );
        const numero = String(mensaje?.contenido || '').match(/ORD-[0-9]+/)?.[0];
        if (!numero) return null;
        const [orden] = await Models.sequelize.query(
            `SELECT numero_orden, tipo_pedido, estado FROM restaurante.pedid_orden
              WHERE id_negocio = :n AND numero_orden = :numero LIMIT 1;`,
            {
                replacements: { n: conversacion.id_negocio, numero },
                type: Models.sequelize.QueryTypes.SELECT,
            }
        );
        if (!orden || orden.estado === 'CERRADA' || orden.estado === 'CANCELADA') return null;
        return { numero_orden: orden.numero_orden, tipo_pedido: orden.tipo_pedido };
    } catch (error) {
        console.warn(`[restaurante] no se pudo buscar el último pedido de la conversación: ${error.message}`);
        return null;
    }
}

module.exports = {
    OPCION_PAGO,
    PREGUNTA_ANULAR_O_PAGAR,
    eligioAnular,
    eligioPagar,
    esCancelarAmbiguo,
    esPreguntaDePago,
    textosDePago,
    frasePago,
    ultimoPedidoVivo,
};
