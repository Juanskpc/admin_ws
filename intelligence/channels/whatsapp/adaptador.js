/**
 * Adaptador del canal WhatsApp (F8-A · ADR-016, ADR-017) — el segundo `ChannelPort`.
 *
 * Es el único sitio de todo Intelligence que sabe qué es un `wamid`, un `phone_number_id` o un
 * botón interactivo. El motor sigue viendo Mensaje Canónico y no se toca ni una línea — que es
 * exactamente lo que ADR-017 prometía y lo que este archivo pone a prueba.
 *
 * ## Lo que este canal trae y el WebChat no tenía
 *
 * ADR-016 eligió el WebChat primero para poder hacerlo **peor** que la realidad a propósito. Aquí
 * llega la realidad, con las cuatro cosas que el simulador imitaba y ahora son de verdad:
 *
 *   - **Autenticación de verdad**: la firma HMAC del cuerpo crudo (`firma.js`). Sin ella este
 *     endpoint es público y cualquiera escribe en nombre de un cliente real.
 *   - **Reentregas de verdad**: Meta reintenta si no contestamos en 10 s. La ingesta ya responde
 *     sin la respuesta del bot desde F5-C, así que ese plazo se cumple por diseño; la
 *     deduplicación por `wamid` es lo que evita procesar dos veces el reintento.
 *   - **Un canal que sabe menos que el nuestro**: 3 botones de 20 caracteres, o una lista de 10
 *     filas. El núcleo ofrece hasta 8 opciones y no sabe nada de eso: degradar es trabajo de aquí.
 *   - **Un humano al otro lado del mismo número**: con la coexistencia, el dueño contesta desde su
 *     móvil y Meta nos lo cuenta por `smb_message_echoes`. Eso **no** es un mensaje del cliente, y
 *     confundirlo era el agujero que §6.13 dejó anotado para esta fase.
 *
 * ## Lo que NO hace, y está decidido
 *
 * No implementa la ventana de 24 horas ni las plantillas, ni multimedia, ni recordatorios
 * proactivos: eso es F8-B, y lo dice el master-plan. Aquí está el canal; allí las reglas de
 * negocio del canal. Se parten porque esta mitad **se puede verificar sin Meta** y la otra no.
 */
'use strict';
const motor = require('../../engine/motor');
const configReal = require('./config');
const apiReal = require('./api');
const repositorio = require('../../engine/repositorio');
const Audit = require('../../../app_core/helpers/auditHelper');

const NOMBRE = 'whatsapp';
const MODULO_AUDITORIA = 'canal_whatsapp';

/** Límites del canal, de la documentación de Meta. Cambiarlos es cambiar lo que Meta acepta. */
const LIMITES = {
    /** Botones de respuesta rápida: 3, y el título 20 caracteres. */
    botones: 3,
    tituloBoton: 20,
    /** Lista: hasta 10 filas, título de fila 24 caracteres, descripción 72. */
    filasLista: 10,
    tituloFila: 24,
    descripcionFila: 72,
    /** Cuerpo de un mensaje interactivo. El texto suelto admite 4096. */
    cuerpo: 1024,
    texto: 4096,
};

/** Tipos que sabemos leer hoy. El resto entra marcado, no se ignora en silencio. */
const TIPOS_CON_TEXTO = new Set(['text', 'interactive', 'button']);

function recortar(valor, max) {
    const t = String(valor ?? '');
    return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

// ── Entrada: WhatsApp → Mensaje Canónico ────────────────────────────────────────────────

/**
 * Qué escribió la persona, sea como sea que lo haya escrito.
 *
 * Un toque en un botón llega como `interactive.button_reply.id`, y **el id es lo que devolvemos
 * como texto**. No es un atajo: es lo que hace que el canal encaje con un núcleo que no sabe qué
 * es un botón. La FSM resuelve la respuesta contra la lista que ofreció —el id del servicio, la
 * hora, `si`/`no`— así que un botón de WhatsApp y un chip del WebChat llegan idénticos al motor.
 */
function textoDeMensaje(mensaje) {
    switch (mensaje.type) {
        case 'text':
            return mensaje.text?.body ?? '';
        case 'interactive': {
            const i = mensaje.interactive || {};
            return i.button_reply?.id ?? i.list_reply?.id ?? '';
        }
        case 'button':
            // Respuesta rápida de una plantilla: el payload es lo que se configuró al aprobarla.
            return mensaje.button?.payload ?? mensaje.button?.text ?? '';
        default:
            // Una foto, un audio, una ubicación. Se marca el tipo y **no se inventa contenido**:
            // el cliente no escribió nada, y poner palabras en su boca acabaría en el Ledger como
            // si las hubiera dicho. Con esto el bot repregunta, que es honesto. Leer imágenes de
            // verdad (un comprobante de pago) es F8-B.
            return `[${mensaje.type}]`;
    }
}

/**
 * Traduce un webhook completo. **Función pura**: no toca la base ni la red.
 *
 * Está separada de `recibirWebhook` para poder probarla con cargas reales de Meta sin levantar
 * nada. Es la mitad del canal que se puede verificar de verdad antes de tener número.
 *
 * @returns {{mensajes: Array, estados: Array, ecos: Array, avisos: Array, ajenos: number}}
 */
function interpretarWebhook(cuerpo, { config = configReal } = {}) {
    const salida = { mensajes: [], estados: [], ecos: [], avisos: [], ajenos: 0 };

    for (const entrada of cuerpo?.entry || []) {
        for (const cambio of entrada.changes || []) {
            const valor = cambio.value || {};
            const phoneNumberId = valor.metadata?.phone_number_id;
            const idNegocio = config.resolverNegocio(phoneNumberId);

            // Un webhook de un número que no es nuestro no se procesa ni se adivina a quién es.
            // Atribuirlo «al negocio por defecto» sería escribir en la conversación de otro
            // inquilino: exactamente la fuga que F2 cerró.
            if (!idNegocio) {
                salida.ajenos += 1;
                continue;
            }

            // ── Mensajes del cliente ────────────────────────────────────────────────────
            for (const mensaje of valor.messages || []) {
                salida.mensajes.push({
                    canal: NOMBRE,
                    idNegocio,
                    // El número de la persona es su identidad en este canal. Es también el que
                    // permitirá reconocerla como `persona` el día que reserva adopte identidad.
                    idExterno: mensaje.from,
                    texto: textoDeMensaje(mensaje),
                    // El `wamid` es lo que hace deduplicable un reintento de Meta.
                    idExternoMensaje: mensaje.id || null,
                    enviadoEn: mensaje.timestamp ? new Date(Number(mensaje.timestamp) * 1000) : null,
                    crudo: { tipo: mensaje.type, soportado: TIPOS_CON_TEXTO.has(mensaje.type) },
                });
            }

            // ── Acuses de nuestros propios envíos ───────────────────────────────────────
            for (const estado of valor.statuses || []) {
                salida.estados.push({
                    idNegocio,
                    wamid: estado.id,
                    estado: estado.status,
                    destinatario: estado.recipient_id,
                    error: estado.errors?.[0] || null,
                });
            }

            // ── El dueño contestó desde su móvil (coexistencia) ─────────────────────────
            // `smb_message_echoes` es lo que Meta manda cuando el número, ya conectado a la Cloud
            // API, envía algo desde la app de WhatsApp Business. Tratarlo como un mensaje del
            // cliente sería meterle al motor las palabras del negocio como si fueran del cliente.
            for (const eco of valor.message_echoes || []) {
                salida.ecos.push({
                    idNegocio,
                    // En un eco, `to` es el cliente: es la conversación que hay que silenciar.
                    idExterno: eco.to,
                    wamid: eco.id,
                    tipo: eco.type,
                });
            }

            // ── Avisos de la cuenta ─────────────────────────────────────────────────────
            // Aquí llega el corte de los ~14 días sin abrir la app (`PRIMARY_INACTIVITY`),
            // confirmado en la documentación de Meta. Es la diferencia entre enterarse por el
            // webhook y enterarse porque un cliente se queja de que nadie le contesta.
            const aviso = valor.account_update || valor;
            if (aviso?.event) {
                salida.avisos.push({
                    idNegocio,
                    evento: aviso.event,
                    motivo: aviso.disconnection_info?.reason ?? null,
                    iniciadoPor: aviso.disconnection_info?.initiated_by ?? null,
                    numero: aviso.phone_number ?? null,
                });
            }
        }
    }

    return salida;
}

/**
 * Procesa un webhook ya verificado: mete los mensajes por la misma puerta que el WebChat.
 *
 * Devuelve rápido y sin la respuesta del bot (ADR-016) — que aquí no es una preferencia de
 * diseño: Meta corta a los 10 segundos y reintenta.
 */
async function recibirWebhook(cuerpo, { config = configReal } = {}) {
    const leido = interpretarWebhook(cuerpo, { config });
    const acuses = [];

    for (const mensaje of leido.mensajes) {
        acuses.push(await motor.recibir(mensaje));
    }

    for (const eco of leido.ecos) {
        await silenciarPorHumano(eco);
    }

    for (const aviso of leido.avisos) {
        await registrarAviso(aviso);
    }

    for (const estado of leido.estados) {
        // Correlacionar un acuse con nuestro mensaje exige guardar el `wamid` al enviar, y eso es
        // una columna en una tabla particionada: F8-B. Hasta entonces, los fallos se auditan —son
        // los únicos que piden acción— y el resto es ruido que no se guarda.
        if (estado.estado === 'failed') {
            await auditar('entrega_fallida', estado.idNegocio, {
                wamid: estado.wamid,
                destinatario: estado.destinatario,
                error: estado.error,
            });
        }
    }

    return {
        recibidos: leido.mensajes.length,
        ecos: leido.ecos.length,
        avisos: leido.avisos.length,
        estados: leido.estados.length,
        ajenos: leido.ajenos,
        acuses,
    };
}

/**
 * El dueño contestó: el bot se calla.
 *
 * Reutiliza el estado `handoff_humano`, que ya significa exactamente esto —«hay una persona
 * atendiendo, no hables encima»— y que el motor ya trata como no procesable desde F5-B. No hace
 * falta un estado nuevo ni una migración: la decisión de §6.13 («el bot no vuelve») se cumple sola.
 */
async function silenciarPorHumano({ idNegocio, idExterno, wamid }) {
    const conversacion = await repositorio.buscarConversacion({
        idNegocio,
        canal: NOMBRE,
        idExterno,
    });
    if (!conversacion) return { silenciada: false, motivo: 'sin_conversacion' };
    if (conversacion.estado === 'handoff_humano') return { silenciada: true, motivo: 'ya_estaba' };

    await repositorio.cambiarEstadoConversacion(conversacion.id_conversacion, 'handoff_humano');
    await auditar('humano_tomo_la_conversacion', idNegocio, {
        id_conversacion: conversacion.id_conversacion,
        wamid,
    });
    return { silenciada: true, motivo: 'eco_del_negocio' };
}

/**
 * Deja constancia de un aviso de cuenta. El de los 14 días es el que hay que ver a tiempo.
 *
 * Se audita y se grita por consola: un negocio cuyo número se desconectó **parece** funcionando
 * —el backend arranca, la app va— y lo único que ocurre es que nadie recibe respuesta.
 */
async function registrarAviso({ idNegocio, evento, motivo, iniciadoPor, numero }) {
    const critico = evento === 'PARTNER_REMOVED';
    if (critico) {
        console.error(
            `[whatsapp] ⚠️  El número ${numero || '(sin número)'} del negocio ${idNegocio} se ` +
                `DESCONECTÓ de la Cloud API (${motivo || 'sin motivo'}, iniciado por ` +
                `${iniciadoPor || 'desconocido'}). El asistente deja de recibir mensajes. ` +
                'Si el motivo es PRIMARY_INACTIVITY, el dueño tiene que abrir la app de WhatsApp ' +
                'Business (Meta corta a los ~14 días sin abrirla) y volver a conectar.'
        );
    }
    await auditar(critico ? 'cuenta_desconectada' : 'aviso_de_cuenta', idNegocio, {
        evento,
        motivo,
        iniciado_por: iniciadoPor,
        numero,
    });
}

// ── Salida: Mensaje Canónico → WhatsApp ─────────────────────────────────────────────────

/**
 * Renderiza texto + opciones al formato de Meta. **Función pura**, y la parte más «canal» de todo.
 *
 * Las tres formas y por qué se elige cada una:
 *
 *   - **Sin opciones** → texto. `preview_url: false` porque un enlace en la respuesta de un bot no
 *     debe abrir una tarjeta con una imagen que nadie revisó.
 *   - **1–3 opciones sin detalle** → botones. Es la mejor forma del canal: un toque, sin escribir.
 *   - **Con `detalle`** → lista, aunque quepan en botones: el detalle es el precio o la duración,
 *     y un botón no tiene dónde ponerlo.
 *   - **4–10 opciones** → lista. Cabe más y sigue siendo un toque.
 *   - **Más de 10** → texto enumerado. Es la degradación con gracia de ADR-017: el canal no puede,
 *     así que se pierde el botón pero **no la elección** — el cliente escribe el número y la FSM
 *     lo resuelve igual, porque su menú siempre se compara contra la lista que ofreció.
 *
 * Los recortes de 20 y 24 caracteres son de Meta, no nuestros: un título más largo hace que la
 * API rechace el mensaje entero, así que recortar es lo que evita que un servicio con nombre largo
 * deje al cliente sin respuesta.
 */
function renderizar({ texto, opciones = [] }) {
    const cuerpo = String(texto ?? '').trim() || '…';
    const lista = (opciones || []).filter((o) => o && o.id != null);

    if (lista.length === 0) {
        return { type: 'text', text: { preview_url: false, body: recortar(cuerpo, LIMITES.texto) } };
    }

    // Un `detalle` (el precio, la duración) manda a lista aunque quepan en botones: un botón no
    // tiene dónde ponerlo y su título se recorta a 20 caracteres, que es exactamente donde moría
    // «Corte de cabello (30 min) — $35.000». Se pierde el toque directo del botón y se gana el
    // dato por el que el cliente escribió. Es la elección que ADR-017 deja al adaptador.
    const conDetalle = lista.some((o) => o.detalle);

    if (lista.length <= LIMITES.botones && !conDetalle) {
        return {
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: recortar(cuerpo, LIMITES.cuerpo) },
                action: {
                    buttons: lista.map((o) => ({
                        type: 'reply',
                        reply: { id: String(o.id), title: recortar(o.etiqueta ?? o.id, LIMITES.tituloBoton) },
                    })),
                },
            },
        };
    }

    if (lista.length <= LIMITES.filasLista) {
        return {
            type: 'interactive',
            interactive: {
                type: 'list',
                body: { text: recortar(cuerpo, LIMITES.cuerpo) },
                action: {
                    button: 'Ver opciones',
                    sections: [
                        {
                            title: 'Opciones',
                            rows: lista.map((o) => ({
                                id: String(o.id),
                                title: recortar(o.etiqueta ?? o.id, LIMITES.tituloFila),
                                ...(o.detalle
                                    ? { description: recortar(o.detalle, LIMITES.descripcionFila) }
                                    : {}),
                            })),
                        },
                    ],
                },
            },
        };
    }

    const enumeradas = lista
        .map((o) => `• ${o.etiqueta ?? o.id}${o.detalle ? ` — ${o.detalle}` : ''}`)
        .join('\n');
    return {
        type: 'text',
        text: { preview_url: false, body: recortar(`${cuerpo}\n\n${enumeradas}`, LIMITES.texto) },
    };
}

/**
 * Entrega, que aquí significa «Meta lo aceptó» — no que alguien lo haya leído.
 *
 * La llama el Channel Gateway. Si lanza, se reintenta: por eso los errores de red y los 429 de
 * `api.js` suben, y los de argumento también (el gateway todavía no distingue; ver su nota sobre
 * el backoff, que es lo primero que hará falta cuando esto empiece a recibir 429 de verdad).
 */
async function entregar({ idExterno, mensaje, api = apiReal, config = configReal }) {
    const payload = renderizar(mensaje);
    await api.enviarMensaje({ para: idExterno, payload, config });
}

async function auditar(accion, idNegocio, detalle) {
    try {
        await Audit.registrarEvento({
            modulo: MODULO_AUDITORIA,
            accion,
            resultado: 'ok',
            idUsuario: null,
            idNegocio,
            detalle,
        });
    } catch (error) {
        console.error(`[whatsapp] no se pudo auditar "${accion}": ${error.message}`);
    }
}

module.exports = {
    nombre: NOMBRE,
    NOMBRE,
    entregar,
    recibirWebhook,
    interpretarWebhook,
    renderizar,
    textoDeMensaje,
    silenciarPorHumano,
    LIMITES,
};
