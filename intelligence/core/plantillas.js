/**
 * Catálogo de plantillas (F8-B) — los mensajes que el negocio puede iniciar.
 *
 * ## Qué es una plantilla y por qué existe esta pieza
 *
 * Hasta F8-A todo lo que el asistente decía era una **respuesta**: alguien escribía y el bot
 * contestaba. Un recordatorio no es eso — lo empieza el negocio, muchas horas después de la última
 * frase del cliente. WhatsApp solo deja hacerlo con una plantilla **registrada y aprobada por Meta**,
 * palabra por palabra, antes de poder enviarla ni una vez (ver `ventana.js`).
 *
 * El master-plan lo puso como advertencia y no como detalle: «un recordatorio de cita **es** una
 * plantilla — hay que diseñarlo así desde el principio, no descubrirlo después». Descubrirlo después
 * significa tener el recordatorio construido, probado y entregándose por WebChat, y enterarse el día
 * de conectar el número de que en WhatsApp no sale ninguno hasta que Meta apruebe un texto que nadie
 * escribió todavía.
 *
 * ## Por qué el catálogo es código, y por qué vive en `core/` y no en el canal
 *
 * Es código por el mismo motivo que el catálogo de capacidades (F4-A): el texto aprobado y sus
 * parámetros son parte del programa, no configuración de un inquilino. Lo que sí puede variar por
 * negocio —si manda recordatorios, con cuánta antelación— es dato, y vive en otro sitio.
 *
 * Y vive en el núcleo porque una plantilla, en abstracto, es «un mensaje con huecos» y eso lo
 * entiende cualquier canal. El WebChat no tiene plantillas de Meta y no las necesita: le llega el
 * texto ya compuesto, que es lo que ADR-017 llama renderizar según el canal. Si el catálogo viviera
 * dentro de `channels/whatsapp/`, el núcleo tendría que importar de un canal para programar un
 * recordatorio — la flecha al revés.
 *
 * ## El contrato con Meta, que es lo que hace esto delicado
 *
 * `nombre` e `idioma` tienen que existir **idénticos** en el gestor de plantillas de Meta, y el
 * `texto` de aquí tiene que ser el mismo que se aprobó allí, con `{{1}}`, `{{2}}`… en el orden de
 * `parametros`. Cambiar aquí una coma sin volver a pasar por Meta no rompe nada visible: el envío
 * sale igual, con el texto **aprobado**, y lo que se lea en el Ledger dejará de ser lo que recibió el
 * cliente. Por eso el orden de `parametros` es parte del contrato y no se reordena.
 */
'use strict';

/**
 * Compone el texto con los parámetros. Un hueco sin valor se queda vacío y **no** se inventa:
 * mandar «tu cita de undefined» es peor que mandar una frase corta.
 */
function componer(plantilla, parametros = {}) {
    return plantilla.parametros
        .reduce(
            (texto, clave, indice) =>
                texto.replaceAll(`{{${indice + 1}}}`, String(parametros[clave] ?? '').trim()),
            plantilla.texto
        )
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

const CATALOGO = {
    /**
     * El recordatorio de una cita. Es la razón por la que existe todo esto.
     *
     * Categoría en Meta: **UTILITY** — es una transacción que el cliente pidió, no marketing. La
     * categoría decide el precio y también si Meta la aprueba: el mismo texto presentado como
     * MARKETING cuesta más y se rechaza más.
     *
     * No lleva botones. Una plantilla con botones de respuesta rápida se aprueba igual, pero la
     * respuesta del cliente abre la ventana de 24 h y entra por el webhook como un mensaje más —
     * o sea, el bot tendría que saber contestar «confirmo» y «cancelo» fuera de toda tarea. Eso es
     * una conversación, no un recordatorio, y se decide cuando haya con qué probarlo.
     */
    recordatorio_cita: {
        nombre: 'recordatorio_cita',
        idioma: 'es',
        categoria: 'UTILITY',
        parametros: ['cliente', 'negocio', 'servicio', 'cuando'],
        texto:
            'Hola {{1}}, te escribimos de {{2}}. Te recordamos tu cita de {{3}} {{4}}. ' +
            'Si no puedes venir, respóndenos a este mensaje y la movemos.',
    },
};

/** La plantilla, o `null` si no está en el catálogo. Nunca lanza: quien decide es el que envía. */
function obtener(nombre) {
    return CATALOGO[nombre] || null;
}

/**
 * El texto que se guarda en `mensaje.contenido`.
 *
 * Se guarda compuesto —y no solo el nombre y los parámetros— porque es lo que un humano lee en la
 * Consola para saber qué recibió el cliente, y porque es lo que un canal sin plantillas entrega tal
 * cual. La versión estructurada viaja aparte, en `mensaje.plantilla`, para el canal que la necesita.
 */
function renderizarTexto(nombre, parametros = {}) {
    const plantilla = obtener(nombre);
    if (!plantilla) throw new Error(`No existe la plantilla "${nombre}" en el catálogo.`);
    return componer(plantilla, parametros);
}

module.exports = { CATALOGO, obtener, renderizarTexto, componer };
