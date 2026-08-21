/**
 * Configuración del canal de WhatsApp — **una costura, no una tabla** (F8-A).
 *
 * ## Qué resuelve
 *
 * Un webhook de Meta no dice a qué negocio pertenece: dice a qué **número** (`phone_number_id`).
 * Alguien tiene que traducir número → `id_negocio`, y ese alguien es este archivo.
 *
 * ## Por qué de variables de entorno y no de una tabla
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
 * ⚠️ **Con esto no basta para producción multi-inquilino**, y está escrito a propósito en
 * `estado()`: un despliegue con dos negocios necesita la tabla y una decisión sobre los secretos.
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

/** ¿Está el canal utilizable? Se pregunta al arrancar, no en el primer webhook. */
function habilitado() {
    const c = leer();
    return Boolean(c.appSecret && c.verifyToken && c.phoneNumberId && c.token && c.idNegocio);
}

/**
 * Qué falta, en una frase que se pueda leer en un log de arranque.
 *
 * Se nombra la variable que falta y no «configuración incompleta»: un mensaje que obliga a abrir
 * el código para saber qué poner es un mensaje que no sirve a las tres de la mañana.
 */
function estado() {
    const c = leer();
    const faltan = [
        !c.appSecret && 'WHATSAPP_APP_SECRET',
        !c.verifyToken && 'WHATSAPP_VERIFY_TOKEN',
        !c.phoneNumberId && 'WHATSAPP_PHONE_NUMBER_ID',
        !c.token && 'WHATSAPP_TOKEN',
        !c.idNegocio && 'WHATSAPP_NEGOCIO_ID',
    ].filter(Boolean);

    if (faltan.length === 0) {
        return {
            habilitado: true,
            resumen:
                `número ${c.phoneNumberId} → negocio ${c.idNegocio} (${c.versionApi}). ` +
                'Un solo número: para el segundo hace falta una tabla y decidir dónde viven los secretos.',
        };
    }
    return { habilitado: false, resumen: `falta ${faltan.join(', ')}` };
}

/**
 * Traduce el número de Meta al negocio de EscalApp.
 *
 * **Devuelve `null` si no es nuestro número**, y el webhook lo trata como lo que es: tráfico que
 * no nos corresponde. No se adivina el negocio ni se cae en un valor por defecto — un webhook
 * mal enrutado escribiría en la conversación de otro inquilino, que es la fuga que F2 cerró.
 */
function resolverNegocio(phoneNumberId) {
    const c = leer();
    if (!phoneNumberId || !c.phoneNumberId) return null;
    return String(phoneNumberId) === String(c.phoneNumberId) ? c.idNegocio : null;
}

module.exports = { leer, habilitado, estado, resolverNegocio, VERSION_API };
