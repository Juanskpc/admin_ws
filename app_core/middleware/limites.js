/**
 * Límites de peticiones.
 *
 * ## Por qué se había apagado, y por qué la razón escrita no era la real
 *
 * Al migrar a Vultr (2026-08-12) se apagó el limitador con esta explicación en `app.js`:
 *
 * > «En el VPS único todo el tráfico entra por Caddy, y el conteo por IP se hacía sobre la IP
 * > del proxy: los 200 req/15min de producción se repartían entre TODOS los clientes a la vez.»
 *
 * Eso **no es lo que pasaba**. `app.set('trust proxy', 1)` se añadió en el mismo commit, Caddy
 * manda `X-Forwarded-For`, y los registros de `morgan` en producción muestran IPs de clientes
 * de verdad (191.95.163.11, 190.130.106.233…), nunca 127.0.0.1. El conteo por IP funcionaba.
 *
 * Lo que de verdad rompía era el **número**. Midiendo 24 h de registros, un restaurante en
 * hora punta llega a **477 peticiones en 10 minutos** desde una sola IP — unas 715 cada 15
 * minutos. El POS consulta inventario cada 60 s, el tiempo real refresca, y varios equipos del
 * local salen por el mismo NAT. Con un techo de 200/15min ese cliente vivía en 429. El
 * síntoma («se cae el login de clientes legítimos») era correcto; el diagnóstico, no. Y como
 * se apagó entero, quedó sin protección lo único que de verdad la necesita: el login.
 *
 * ## Dos límites, con propósitos distintos
 *
 * **1. El general** es una red para abuso declarado, no un control de caudal. 3.000 cada 15
 * minutos por IP: cuatro veces el pico medido, así que un cliente real no lo roza ni en el día
 * más movido, y un script que recorre la API se para en seco.
 *
 * **2. El de autenticación** es el que importa y puede ser estrecho porque el tráfico legítimo
 * es mínimo: nadie inicia sesión veinte veces en un cuarto de hora. Cubre login, OTP y
 * recuperación de contraseña. Sin él, y con cuentas cuya contraseña es la cédula
 * (`debe_cambiar_password` nunca se llegó a exigir), probar cédulas contra el login no tenía
 * ningún freno.
 *
 * ## Por qué NO se agrupa por usuario
 *
 * Sería mejor —un local con cinco equipos tras un NAT es hoy un solo cubo—, pero el limitador
 * corre **antes** de `verificarToken`, así que ahí no hay usuario resuelto todavía. Leer el
 * `id_usuario` del JWT sin validar la firma sería peor que no hacer nada: quien quisiera
 * saltarse el límite se inventaría un token por petición y tendría un cubo nuevo cada vez.
 * Con el techo puesto en 4x el pico, agrupar por IP no estorba a nadie.
 */
'use strict';

const rateLimit = require('express-rate-limit');

const VENTANA_MS = 15 * 60 * 1000;

/**
 * Rutas que NO se limitan: las entradas de las pasarelas y de Meta.
 *
 * Un webhook no es una persona con navegador. Reintenta en ráfaga cuando algo le falla —que es
 * justo cuando no se le puede responder 429—, y lo que se pierde al rechazarlo es la
 * confirmación de un pago o un mensaje de WhatsApp de un cliente. El webhook de cobranza ya va
 * montado antes del limitador en `app.js`; el de WhatsApp va después, por el cuerpo crudo, y
 * por eso tiene que salir aquí.
 *
 * Que estén fuera del límite no los deja a la intemperie: los dos verifican la firma HMAC del
 * remitente, que es una protección mucho más fuerte que contar peticiones.
 */
const SIN_LIMITE = [
    '/admin/cobranza/webhook',
    '/intelligence/whatsapp/webhook',
];

/**
 * La clave del cubo a partir de la IP, tolerante a IPv6.
 *
 * Una IPv6 completa identifica a un equipo, no a una conexión: a un cliente le sobran
 * direcciones del mismo prefijo y podría estrenar cubo con cada petición. Se agrupa por los
 * primeros cuatro grupos (/64), que es el bloque que se asigna de una pieza. En IPv4 la
 * dirección va tal cual.
 */
function claveIp(req) {
    const ip = req.ip || req.socket?.remoteAddress || 'desconocida';
    if (!ip.includes(':')) return ip;

    return ip.split(':').slice(0, 4).join(':');
}

const respuesta429 = {
    success: false,
    message: 'Demasiadas peticiones, intente más tarde',
};

/** La red ancha: solo salta con abuso evidente. */
function limitadorGeneral({ max } = {}) {
    return rateLimit({
        windowMs: VENTANA_MS,
        max: max ?? Number(process.env.RATE_LIMIT_MAX || 3000),
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: claveIp,
        skip: (req) => SIN_LIMITE.some((ruta) => req.path.startsWith(ruta)),
        message: respuesta429,
    });
}

/** La identificación que se intenta en esta petición, para la clave del cubo por cuenta. */
function claveIntento(req) {
    return String(
        req.body?.num_identificacion ?? req.body?.email ?? req.body?.usuario ?? ''
    ).trim().toLowerCase().slice(0, 60);
}

const mensajeIntentos = {
    success: false,
    message: 'Demasiados intentos. Espera unos minutos antes de volver a probar.',
};

/**
 * El estrecho, para las rutas donde se prueban credenciales o se pide un código.
 *
 * Devuelve **dos middlewares**, no uno, y ahí está todo el asunto. Express acepta un array, así
 * que las rutas no notan la diferencia.
 *
 * ## Por qué dos y no uno
 *
 * La primera versión usaba una sola clave, `IP + identificación`, con el argumento de que
 * agrupar solo por IP castiga a un local tras un NAT. El razonamiento era correcto y la
 * conclusión no: metiendo la identificación en la clave, **quien prueba cédulas estrena cubo
 * con cada una** y el límite deja de existir. Es el agujero clásico de los limitadores de
 * login, estaba descrito en este mismo comentario, y aun así quedó construido así. Lo
 * encontraron las pruebas (`__tests__/authz/limites.test.js`), no una relectura.
 *
 * Con dos cubos cada uno hace un trabajo distinto y ninguno tiene que ceder:
 *
 *   - **Por IP** (30): corta a quien recorre un listado de cédulas desde un sitio. Treinta
 *     fallos en quince minutos desde una misma IP no es un cajero torpe, es un script.
 *   - **Por IP + cuenta** (10): corta a quien se centra en una cuenta concreta, y deja margen
 *     para que varias personas del mismo local se equivoquen sin estorbarse.
 *
 * ## `contarAciertos`: dos tipos de ruta que no se protegen igual
 *
 * **`false` (por defecto) — donde se prueban credenciales.** Login, verificar OTP, restablecer
 * contraseña. Se cuentan los **fallos**, así que entrar y salir diez veces en una tarde no
 * acerca a nadie al límite.
 *
 * **`true` — donde el acierto es la acción costosa.** `forgot-password` y
 * `registro/enviar-codigo` **mandan un correo cuando salen bien**, y devuelven 200. Contando
 * solo fallos, pedir mil códigos sería gratis: mil respuestas 200, cero cuenta. Lo que se agota
 * ahí no es CPU — es la cuota de envío de la cuenta de correo (~500 al día). Se cuenta todo, el
 * techo es más bajo, y basta el cubo por IP: cambiar de correo en cada intento es precisamente
 * el abuso que se quiere frenar.
 */
function limitadorAutenticacion({ max, contarAciertos = false } = {}) {
    const comun = {
        windowMs: VENTANA_MS,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: !contarAciertos,
        message: mensajeIntentos,
    };

    if (contarAciertos) {
        return [
            rateLimit({
                ...comun,
                max: max ?? Number(process.env.RATE_LIMIT_CODIGO_MAX || 5),
                keyGenerator: claveIp,
            }),
        ];
    }

    const porCuenta = max ?? Number(process.env.RATE_LIMIT_AUTH_MAX || 10);
    // El de la IP es el techo duro de la ventana; el de la cuenta, el que protege a una persona
    // concreta. Se deja al menos el triple para que un local con varios equipos quepa.
    const porIp = Number(process.env.RATE_LIMIT_AUTH_IP_MAX || Math.max(30, porCuenta * 3));

    return [
        rateLimit({ ...comun, max: porIp, keyGenerator: claveIp }),
        rateLimit({
            ...comun,
            max: porCuenta,
            keyGenerator: (req) => `${claveIp(req)}|${claveIntento(req)}`,
        }),
    ];
}

module.exports = {
    limitadorGeneral,
    limitadorAutenticacion,
    claveIp,
    claveIntento,
    SIN_LIMITE,
    VENTANA_MS,
};
