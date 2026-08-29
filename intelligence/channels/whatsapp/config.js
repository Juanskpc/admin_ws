/**
 * Configuración del canal de WhatsApp — **una costura, no una tabla** (F8-A).
 *
 * ## Qué resuelve
 *
 * Un webhook de Meta no dice a qué negocio pertenece: dice a qué **número** (`phone_number_id`).
 * Alguien tiene que traducir número → `id_negocio`, y ese alguien es este archivo.
 *
 * ## ✅ La tabla llegó el 2026-08-29 (F8-C)
 *
 * Lo que sigue debajo se escribió cuando había **un** cliente, y acertó en lo que importaba: que
 * el sitio donde se traduce número → negocio fuera **uno solo**. Por eso el cambio a
 * `platform.numero_canal` cupo en una función —`resolverNegocio()` ahora pregunta a
 * [`numeros.js`](./numeros.js)— y el adaptador no se enteró. Si el `phone_number_id` se hubiera
 * leído del entorno en tres sitios, esto habría sido una cirugía.
 *
 * Las variables de entorno **no desaparecen**: son el respaldo cuando la tabla está vacía, que es
 * lo que hace que el cambio no tenga corte y que un entorno de desarrollo pueda apuntar un número
 * sin migrar nada.
 *
 * Y la decisión que quedaba abierta —«dónde viven los secretos»— está tomada y escrita en
 * `numeros.js`: el token sigue global, porque cubre la WABA entera y no un número.
 *
 * ## Por qué era de variables de entorno y no de una tabla
 *
 * Es el mismo patrón que `core/contextoNegocio.js`, y por la misma razón. Hoy hay **un** cliente
 * real y **ningún** número conectado: una tabla `intelligence.canal_whatsapp` sería una migración
 * sobre una decisión que nadie ha tomado todavía —empezando por la más incómoda, dónde viven los
 * *access token* de cada inquilino, que son secretos y no configuración—. El test de simplicidad
 * del proyecto lo rechaza: no hay quien la use.
 *
 * Lo que sí hace falta hoy es que **el sitio donde eso se decide exista y sea uno solo**. Cuando
 * el segundo negocio conecte su número, cambia `resolverNegocio()` para leer de donde toque y el
 * adaptador no se entera. Si en vez de eso el `phone_number_id` se leyera del entorno en tres
 * sitios, la tabla llegaría con una cirugía.
 *
 * ⚠️ ~~**Con esto no basta para producción multi-inquilino**~~ — resuelto arriba. `estado()` ya
 * no dice «un solo número»: lista los que haya y de dónde salieron.
 *
 * ## Los cuatro valores, y qué pasa si falta uno
 *
 * | Variable | Para qué | Si falta |
 * |---|---|---|
 * | `WHATSAPP_APP_SECRET` | verificar la firma del webhook | **el canal no arranca**: sin firma, cualquiera escribe |
 * | `WHATSAPP_VERIFY_TOKEN` | el saludo `GET` de Meta al suscribir | no se puede suscribir el webhook |
 * | `WHATSAPP_PHONE_NUMBER_ID` | saber qué número es nuestro y por dónde enviar | no se puede enviar ni resolver el negocio |
 * | `WHATSAPP_TOKEN` | llamar a la Cloud API | se recibe pero no se contesta |
 *
 * El canal entero está **apagado si falta cualquiera de los cuatro**. Es deliberado: medio canal
 * configurado es un canal que recibe y no contesta, y eso desde fuera es un negocio que ignora a
 * sus clientes.
 */
'use strict';
const numeros = require('./numeros');

/** Versión de la Graph API. Se fija aquí porque un cambio de versión es un cambio de contrato. */
const VERSION_API = process.env.WHATSAPP_API_VERSION || 'v21.0';

function leer() {
    return {
        appSecret: process.env.WHATSAPP_APP_SECRET || null,
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || null,
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
        token: process.env.WHATSAPP_TOKEN || null,
        idNegocio: process.env.WHATSAPP_NEGOCIO_ID ? Number(process.env.WHATSAPP_NEGOCIO_ID) : null,
        versionApi: VERSION_API,
        baseUrl: process.env.WHATSAPP_API_URL || 'https://graph.facebook.com',
    };
}

/**
 * ¿Está el canal utilizable? Se pregunta al arrancar, no en el primer webhook.
 *
 * Desde F8-C el número ya no tiene por qué estar en el entorno: basta con que haya **alguno**
 * cargado, venga de `platform.numero_canal` o del `.env`.
 */
function habilitado() {
    const c = leer();
    const hayNumero = numeros.listar().numeros.length > 0;
    return Boolean(c.appSecret && c.verifyToken && c.token && hayNumero);
}

/**
 * Qué falta, en una frase que se pueda leer en un log de arranque.
 *
 * Se nombra la variable que falta y no «configuración incompleta»: un mensaje que obliga a abrir
 * el código para saber qué poner es un mensaje que no sirve a las tres de la mañana.
 */
function estado() {
    const c = leer();
    const registro = numeros.listar();

    // El número y el negocio pueden venir de la tabla, así que solo faltan de verdad cuando
    // tampoco hay ninguna fila cargada. Los otros tres siguen siendo del entorno.
    const faltan = [
        !c.appSecret && 'WHATSAPP_APP_SECRET',
        !c.verifyToken && 'WHATSAPP_VERIFY_TOKEN',
        !c.token && 'WHATSAPP_TOKEN',
        registro.numeros.length === 0 && 'algún número (platform.numero_canal o WHATSAPP_PHONE_NUMBER_ID)',
    ].filter(Boolean);

    if (faltan.length > 0) {
        return { habilitado: false, resumen: `falta ${faltan.join(', ')}` };
    }

    const lista = registro.numeros
        .map((n) => `${n.id_externo} → negocio ${n.id_negocio}`)
        .join(', ');

    return {
        habilitado: true,
        resumen:
            `${registro.numeros.length} número(s) desde ${registro.origen} ` +
            `(${c.versionApi}): ${lista}.`,
    };
}

/**
 * Traduce el número de Meta al negocio de EscalApp.
 *
 * Desde F8-C esto ya no compara contra la única variable de entorno: lo contesta
 * [`numeros.js`](./numeros.js), que lee `platform.numero_canal` y cae al `.env` si está vacía.
 * Sigue siendo **síncrona** para no volver asíncrona a `interpretarWebhook()`, que es una función
 * pura y se prueba sin base ni red.
 *
 * **Devuelve `null` si no es nuestro número**, y el webhook lo trata como lo que es: tráfico que
 * no nos corresponde. No se adivina el negocio ni se cae en un valor por defecto — un webhook
 * mal enrutado escribiría en la conversación de otro inquilino, que es la fuga que F2 cerró.
 */
function resolverNegocio(phoneNumberId) {
    return numeros.negocioDe(phoneNumberId);
}

/**
 * Desde qué número contesta este negocio (F8-C, punto 6).
 *
 * Devuelve `null` si no lo sabe, y quien envía **debe negarse**: mandar «por el número que haya»
 * es exactamente el fallo que este punto existe para evitar — el bot de un cliente contestando
 * desde el número de otro.
 */
function numeroDeNegocio(idNegocio) {
    return numeros.numeroDe(idNegocio);
}

module.exports = {
    leer,
    habilitado,
    estado,
    resolverNegocio,
    numeroDeNegocio,
    VERSION_API,
};
