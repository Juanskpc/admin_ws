/**
 * Lo que Meta cobra por un mensaje de marketing, por país del destinatario.
 *
 * ## ⚠️ Esto es un DATO CON FECHA, no una constante
 *
 * Meta cambia su *rate card* **solo** el 1 de enero, abril, julio u octubre, y avisa con un mes.
 * O sea: esta tabla caduca de forma previsible, y el día que caduque el simulador tiene que
 * **decir de cuándo es su precio** en vez de mentir con seguridad. Por eso cada entrada lleva
 * `vigencia` y el simulador la devuelve siempre hacia la pantalla.
 *
 * El día que haya que actualizarla: `business.whatsapp.com/products/platform-pricing#rates`, o el
 * CSV por moneda que publica Meta. Hay que mirar **el de la moneda de facturación del inquilino**
 * (COP es moneda de facturación desde el 2026-04-01), no el de dólares convertido.
 *
 * ## Lo que NO está aquí, y es a propósito
 *
 * **Solo Colombia tiene tarifa.** Es la única verificada: US$0,0125 de marketing sale del *rate
 * card* que leyó el dueño el 2026-10-05 para utility (US$0,0008) y de tres tablas de terceros
 * independientes que coinciden en las dos cifras. Para Chile —donde ya hay un inquilino— **no se
 * encontró cifra publicada**, y poner una inventada sería peor que no tener ninguna: el dueño le
 * prometería un costo a su cliente y la factura de Meta diría otra cosa.
 *
 * Así que un país sin tarifa **no se estima**: el simulador lo cuenta aparte y lo dice. Es la misma
 * decisión que `identidad.normalizarTelefono` («devuelve null en vez de adivinar»), por la misma
 * razón.
 *
 * ## Por qué el marketing cuesta 15 veces más, y qué significa
 *
 * Un mensaje de servicio (el del asistente, dentro de la ventana de 24 h) cuesta US$0,0008 y los
 * primeros 1.000 del mes son gratis. Uno de marketing cuesta US$0,0125, **se cobra desde el
 * primero** y no toca esa asignación. La consecuencia de producto: una promoción de 400 envíos
 * cuesta lo mismo que 6.250 mensajes del asistente. No es un detalle de facturación, es la razón
 * de que exista un simulador antes del botón de enviar.
 */
'use strict';

/** De cuándo son estos precios. Se enseña en pantalla junto al total. */
const VIGENCIA = '2026-07-01';

/** La moneda en la que Meta publica el *rate card* que se copió aquí. */
const MONEDA = 'USD';

/**
 * Indicativo de país → precio por mensaje entregado, en USD.
 *
 * `null` significa **no lo sabemos**, no «gratis».
 */
const POR_PAIS = {
    57: {
        pais: 'Colombia',
        marketing: 0.0125,
        servicio: 0.0008,
        // De dónde sale cada número, para que el día que alguien dude no tenga que repetir la
        // investigación: utility del rate card leído por el dueño (2026-10-05) y marketing de
        // SleekFlow / WHAutomate / Zernio / Flowcall, que coinciden en los dos.
        confirmada: true,
    },
    56: {
        pais: 'Chile',
        marketing: null,
        servicio: null,
        confirmada: false,
    },
};

/** Países a los que Meta **no entrega** plantillas de marketing. */
const SIN_ENTREGA_MARKETING = {
    1: 'Estados Unidos y Canadá (Meta no entrega plantillas de marketing a números +1 de EE. UU.)',
};

/**
 * El indicativo de un teléfono E.164.
 *
 * Los indicativos tienen 1, 2 o 3 dígitos y no hay forma de saber cuál con solo mirar: se prueba
 * del más largo al más corto contra lo que conocemos, y si nada casa se devuelve el primer dígito
 * —que es suficiente para agrupar «lo desconocido» sin pretender saber de dónde es—.
 */
function indicativoDe(telefonoE164) {
    const digitos = String(telefonoE164 || '').replace(/\D/g, '');
    if (!digitos) return null;
    for (const largo of [3, 2, 1]) {
        const posible = digitos.slice(0, largo);
        if (POR_PAIS[posible] || SIN_ENTREGA_MARKETING[posible]) return posible;
    }
    return digitos.slice(0, 2);
}

/** La tarifa de un teléfono, o una entrada «desconocida» que el simulador sabe contar aparte. */
function tarifaDe(telefonoE164) {
    const indicativo = indicativoDe(telefonoE164);
    if (!indicativo) return { indicativo: null, pais: null, marketing: null, confirmada: false };

    const noEntrega = SIN_ENTREGA_MARKETING[indicativo];
    if (noEntrega) {
        return {
            indicativo,
            pais: noEntrega,
            marketing: null,
            confirmada: true,
            sin_entrega: true,
        };
    }

    const fila = POR_PAIS[indicativo];
    return {
        indicativo,
        pais: fila?.pais ?? `Indicativo +${indicativo}`,
        marketing: fila?.marketing ?? null,
        confirmada: Boolean(fila?.confirmada),
        sin_entrega: false,
    };
}

/**
 * Tipo de cambio **de referencia**, solo para que el dueño vea un orden de magnitud en pesos.
 *
 * ⚠️ No es la tasa con la que Meta le va a cobrar, y la pantalla tiene que decirlo. Entre la
 * medición del 2026-10-05 (~4.125 COP/USD) y la del 10-08 (3.682) hay un 12 % de diferencia: en
 * una campaña de 400 envíos son $7.000 de distancia. **Para presupuestar, la cifra honesta es la de
 * dólares**; los pesos son para que no haya que abrir la calculadora.
 */
const FX_REFERENCIA = {
    fecha: '2026-10-12',
    COP: 3900,
};

/** USD → la moneda del inquilino, con la tasa de referencia. `null` si no la tenemos. */
function aMonedaLocal(usd, moneda = 'COP') {
    const tasa = FX_REFERENCIA[moneda];
    if (!tasa || usd == null) return null;
    return Math.round(usd * tasa);
}

module.exports = {
    VIGENCIA,
    MONEDA,
    POR_PAIS,
    SIN_ENTREGA_MARKETING,
    FX_REFERENCIA,
    indicativoDe,
    tarifaDe,
    aMonedaLocal,
};
