/**
 * El simulador: qué cuesta esta promoción y cuánto tiene que volver para que valga la pena.
 *
 * ## Por qué existe antes que el botón de enviar
 *
 * Porque una promoción es la primera función del producto en la que el negocio **gasta dinero
 * real** al usarla, y en dos sitios a la vez: lo que Meta le cobra a su tarjeta y lo que nos paga
 * a nosotros. El dueño tiene que poder ver las dos cifras y decidir **antes**, no enterarse después
 * — un cliente que descubre un cobro por la factura de Meta es un cliente que cree que le
 * escondimos algo (`asistente-economia.md` §3).
 *
 * ## Las tres cosas que devuelve, y por qué las tres
 *
 * 1. **Lo que le cobra Meta**, por país del destinatario, con la fecha del *rate card*. No lo
 *    cobramos nosotros y no podemos revenderlo: su WABA es suya (`embedded-signup.md` §9.1).
 * 2. **Lo que cuesta en EscalApp**: un precio fijo por mensaje entregado (`PRECIO_ENVIO_COP`,
 *    decidido el 2026-10-13). Por ahora solo se muestra: no hay compra ni descuento todavía (F3).
 * 3. **Cuántos pedidos tiene que traer para empatar.** Es lo único de aquí que el dueño de verdad
 *    quiere saber.
 *
 * ## ⚠️ El punto de equilibrio se calcula con MARGEN, no con venta
 *
 * Es la trampa de este cálculo y hay que decirla en voz alta. Con venta, 400 envíos a $50 son
 * $20.000 contra un pedido de $27.321: sale «con un solo pedido ya ganaste», y es **mentira** —de
 * ese pedido el restaurante se queda con unos $8.200. Con margen hacen falta ~4 pedidos, que es
 * alcanzable y verdad. Una promesa inflada en el simulador se descubre con la primera campaña, y
 * entonces el dueño no vuelve a creerle a ninguna cifra nuestra.
 *
 * El margen es un parámetro (`margenPorDefecto`) porque no lo sabemos: un restaurante de hamburguesas
 * y una barbería no se parecen en nada. 30 % es un punto de partida conservador para comida
 * preparada; la pantalla lo deja mover.
 */
'use strict';

const tarifas = require('./tarifas');
const cuota = require('../../intelligence/channels/whatsapp/cuota');

/**
 * Lo que cobra EscalApp por cada mensaje de promoción ENTREGADO, en pesos colombianos.
 *
 * Decidido por el dueño el 2026-10-13: **precio fijo por envío**, sin paquetes ni envíos incluidos
 * en el plan. Por ahora **solo se muestra** —no se descuenta ni se cobra— y se dice así en la
 * nota. Cambiar el precio es cambiar este número. Con otra moneda no se pinta (no hay tarifa
 * definida fuera de Colombia) en vez de convertir una cifra que nadie fijó.
 */
const PRECIO_ENVIO_COP = 30;

/** Margen bruto con el que se calcula el punto de equilibrio si nadie dice otro. */
const MARGEN_POR_DEFECTO = 0.3;

/**
 * Cuántos mensajes del asistente gasta una conversación que vuelve.
 *
 * Medido sobre el mes completo de Zona Burger (`whatsapp-costo-mensajes.md` §2): 9,1 salientes por
 * pedido conseguido, contando también las conversaciones que no acaban en pedido. Se usa para
 * avisar de lo que **no** se ve en el precio de la campaña: que una promoción que funciona devuelve
 * conversaciones, y esas conversaciones gastan del techo del plan.
 */
const MENSAJES_POR_CONVERSACION = 9.1;

/**
 * Qué parte de los destinatarios contesta. **No está medido todavía** y por eso no se usa para
 * prometer nada: solo para dimensionar el consumo del asistente en el aviso. Es el número que el
 * piloto de F2 tiene que sustituir por uno real.
 */
const TASA_RESPUESTA_SUPUESTA = 0.1;

/**
 * El costo de una campaña, dado el conjunto de destinatarios que devolvió
 * `segmentos.destinatariosParaEnvio`.
 *
 * @param {Object[]} destinatarios — con `telefono` y `valor_total`.
 * @param {Object} opciones
 * @param {number} [opciones.margen] — margen bruto del negocio (0..1).
 * @param {string} [opciones.moneda] — para el equivalente de referencia.
 * @param {Object} [opciones.cupo] — lo que devuelve `cuota.consumoDe`, si se tiene.
 */
function calcular(destinatarios = [], { margen = MARGEN_POR_DEFECTO, moneda = 'COP', cupo = null } = {}) {
    const porPais = new Map();
    let enviables = 0;
    let costoUsd = 0;
    let sinTarifa = 0;
    let sinEntrega = 0;

    for (const d of destinatarios) {
        const t = tarifas.tarifaDe(d.telefono);
        const clave = t.indicativo ?? 'desconocido';
        if (!porPais.has(clave)) {
            porPais.set(clave, {
                indicativo: t.indicativo,
                pais: t.pais,
                destinatarios: 0,
                precio_unitario_usd: t.marketing,
                costo_usd: 0,
                confirmada: t.confirmada,
                sin_entrega: Boolean(t.sin_entrega),
            });
        }
        const fila = porPais.get(clave);
        fila.destinatarios += 1;

        if (t.sin_entrega) {
            sinEntrega += 1;
            continue;
        }
        if (t.marketing == null) {
            sinTarifa += 1;
            enviables += 1;
            continue;
        }
        enviables += 1;
        fila.costo_usd = Number((fila.costo_usd + t.marketing).toFixed(6));
        costoUsd = Number((costoUsd + t.marketing).toFixed(6));
    }

    // El ticket medio de ESTOS destinatarios, no del negocio entero: si la campaña va a los
    // dormidos, lo que importa es lo que gastaban ellos.
    const conGasto = destinatarios.filter((d) => Number(d.valor_total) > 0);
    const ticketMedio = conGasto.length
        ? Math.round(conGasto.reduce((s, d) => s + Number(d.valor_total), 0) / conGasto.length)
        : 0;

    const costoLocal = tarifas.aMonedaLocal(costoUsd, moneda);
    const margenUsado = Number.isFinite(margen) && margen > 0 && margen <= 1 ? margen : MARGEN_POR_DEFECTO;
    const margenPorPedido = Math.round(ticketMedio * margenUsado);

    const precioEscalapp = moneda === 'COP' ? enviables * PRECIO_ENVIO_COP : null;

    // El punto de equilibrio cuenta lo de Meta y lo nuestro: es lo que el dueño va a pagar en
    // total. Sin precio nuestro en su moneda, solo lo de Meta, y se dice en `base`.
    const costoTotal = costoLocal != null ? costoLocal + (precioEscalapp ?? 0) : null;
    const pedidosParaEmpatar =
        margenPorPedido > 0 && costoTotal != null ? Math.ceil(costoTotal / margenPorPedido) : null;

    const conversacionesEsperadas = Math.round(enviables * TASA_RESPUESTA_SUPUESTA);
    const mensajesAsistente = Math.round(conversacionesEsperadas * MENSAJES_POR_CONVERSACION);

    return {
        destinatarios: destinatarios.length,
        /** A cuántos se les mandaría de verdad. */
        enviables,
        /** Estos no reciben nada: Meta no entrega marketing a su país. */
        sin_entrega: sinEntrega,
        /** Estos sí reciben, pero no sabemos a qué precio. */
        sin_tarifa_confirmada: sinTarifa,

        meta: {
            costo_usd: Number(costoUsd.toFixed(4)),
            costo_estimado_local: costoLocal,
            moneda,
            por_pais: [...porPais.values()].sort((a, b) => b.destinatarios - a.destinatarios),
            vigencia_tarifa: tarifas.VIGENCIA,
            fx_referencia: tarifas.FX_REFERENCIA,
            /** Quién lo cobra. La pantalla lo dice con estas palabras, no con otras. */
            lo_cobra: 'Meta, a la tarjeta de la cuenta de WhatsApp del negocio',
        },

        escalapp: {
            /** 1 crédito = 1 mensaje entregado. Lo fallido se devuelve (F2). */
            creditos: enviables,
            /** Lo que costaría: `creditos × PRECIO_ENVIO_COP`. `null` fuera de Colombia. */
            precio_local: precioEscalapp,
            precio_unitario_local: moneda === 'COP' ? PRECIO_ENVIO_COP : null,
            /** Todavía no se descuenta ni se cobra: la pantalla lo dice. */
            se_cobra: false,
            nota: 'Solo se cuenta lo que se entrega. Por ahora no se te cobra.',
        },

        retorno: {
            ticket_medio: ticketMedio,
            margen_usado: margenUsado,
            margen_por_pedido: margenPorPedido,
            /** Lo único que el dueño quiere saber. `null` si estos clientes nunca gastaron nada. */
            pedidos_para_empatar: pedidosParaEmpatar,
            base: precioEscalapp != null
                ? 'el costo de Meta más el de EscalApp'
                : 'solo el costo de Meta (no hay precio de EscalApp en esta moneda)',
        },

        /**
         * El costo que no se ve en el precio: las respuestas.
         *
         * Una promoción que funciona devuelve conversaciones, y cada una gasta ~9,1 mensajes del
         * asistente del techo contratado. Si el techo no da, el freno degrada el asistente **justo
         * cuando están llegando los pedidos** — que es el fallo más vergonzoso que puede tener esta
         * función.
         */
        asistente: {
            conversaciones_esperadas: conversacionesEsperadas,
            mensajes_estimados: mensajesAsistente,
            tasa_respuesta_supuesta: TASA_RESPUESTA_SUPUESTA,
            medida: false,
            cupo: cupo
                ? {
                      usados: cupo.servicio,
                      techo: cupo.asignacion,
                      restantes: cupo.restantes,
                      alcanza: cupo.restantes >= mensajesAsistente,
                  }
                : null,
        },
    };
}

/**
 * Lo mismo, pero mirando además cuánto cupo del asistente le queda al negocio.
 *
 * Se consulta aquí y no en el controlador porque el aviso del cupo es parte de la respuesta del
 * simulador, no un adorno de la pantalla: sin él, el dueño aprueba una campaña que va a frenar su
 * propio asistente. Si la consulta falla, se devuelve el cálculo **sin** el cupo en vez de romper
 * la simulación: saber el costo sigue valiendo.
 */
async function calcularConCupo(destinatarios, opciones = {}) {
    let cupo = null;
    try {
        cupo = await cuota.consumoDe(opciones.idNegocio);
    } catch (error) {
        console.warn('[promociones] no se pudo leer el cupo del asistente:', error.message);
    }
    return calcular(destinatarios, { ...opciones, cupo });
}

module.exports = {
    MARGEN_POR_DEFECTO,
    PRECIO_ENVIO_COP,
    MENSAJES_POR_CONVERSACION,
    TASA_RESPUESTA_SUPUESTA,
    calcular,
    calcularConCupo,
};
