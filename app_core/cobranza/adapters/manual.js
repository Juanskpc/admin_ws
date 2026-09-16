/**
 * Adaptador `manual` — el cliente transfiere y un administrador confirma.
 *
 * ## Por qué esto es un adaptador y no un `if`
 *
 * Es tentador tratar el cobro manual como «el caso en que no hay pasarela» y resolverlo con un
 * condicional en el servicio. El problema es que ese condicional no se queda quieto: aparece al
 * crear la factura, al cobrarla, al reintentar, al mostrar el estado y al decidir si el cron la
 * toca. Cinco sitios que hay que acordarse de tocar cada vez.
 *
 * Cumpliendo la misma interfaz que dLocal y Wompi, el servicio no sabe que existe.
 *
 * ## Y no es un modo transitorio
 *
 * Hoy es el único que funciona, pero además va a sobrevivir a las otras dos: un cliente persona
 * jurídica **retiene en la fuente**, así que cobrarle el 100% por pasarela le crea un saldo a
 * favor que nadie pidió (`docs/obligaciones-escalapp.md` §3). Para esos clientes, transferencia
 * y factura es la respuesta correcta, no la provisional.
 */
'use strict';

function error(mensaje, code, statusCode = 400) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

const codigo = 'manual';

/**
 * No hay nada que tokenizar: nadie guarda una transferencia bancaria como medio de pago.
 * Se lanza en vez de devolver null para que un error de programación salga a la cara en
 * desarrollo y no se convierta en una suscripción a medio configurar en producción.
 */
async function tokenizarMetodo() {
    throw error(
        'El cobro por transferencia no guarda un medio de pago.',
        'PASARELA_SIN_TOKENIZACION',
        409
    );
}

/**
 * «Cobrar» aquí es dejar la factura esperando a un humano. Devuelve `pendiente`, que es la
 * verdad: el dinero no ha entrado y nadie ha prometido que entre.
 */
async function cobrar({ referencia }) {
    return {
        estado: 'pendiente',
        idExterno: null,
        codigoRespuesta: 'MANUAL',
        mensaje: 'Factura pendiente de transferencia. Un administrador debe confirmarla.',
        payload: { referencia, modo: 'manual' },
    };
}

/** No hay nada que consultar: el estado lo fija el administrador que confirma. */
async function consultarTransaccion() {
    return {
        estado: 'pendiente',
        idExterno: null,
        codigoRespuesta: 'MANUAL',
        mensaje: 'El estado de un cobro manual lo fija un administrador.',
        payload: null,
    };
}

/** No hay webhooks. Que devuelva firma inválida evita que un POST perdido active un plan. */
async function verificarFirmaWebhook() {
    return { valida: false, idEvento: null, tipo: null, payload: null };
}

module.exports = {
    codigo,
    soportaRecurrente: false,
    tokenizarMetodo,
    cobrar,
    consultarTransaccion,
    verificarFirmaWebhook,
};
