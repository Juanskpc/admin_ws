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
 * ## Lo que añadió F8-B
 *
 * Las reglas del canal, que no son del canal en el sentido técnico sino de negocio: la **ventana
 * de 24 horas** (`ventana.js`), las **plantillas** para poder escribir fuera de ella, y el
 * `wamid` guardado al enviar para que un acuse posterior se pueda atar a nuestra fila.
 *
 * ## Lo que sigue sin hacer, y está decidido
 *
 * No lee multimedia: una foto entra marcada y el bot repregunta. Leer un comprobante de pago con
 * visión encaja con el cobro adelantado que ya existe en `reserva`, pero exige descargar el medio
 * de Meta y un modelo con visión — dos cosas que no se pueden verificar sin cuenta.
 */
'use strict';
const motor = require('../../engine/motor');
const configReal = require('./config');
const apiReal = require('./api');
const ventanaReal = require('./ventana');
const repositorio = require('../../engine/repositorio');
const plantillas = require('../../core/plantillas');
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
    const salida = { mensajes: [], estados: [], ecos: [], avisos: [], ajenos: 0, sinRemitente: [] };

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
                // ⚠️ Quién habla: el teléfono si lo hay, y si no, el BSUID.
                //
                // El 2026-08-26 un webhook llegó con un mensaje **sin `from`** y el núcleo lo
                // rechazó —«el mensaje canónico necesita saber quién habla»—. Del otro lado
                // había una persona real que había escrito «Buenas tardes» y no recibió nada.
                //
                // La causa no era una rareza: es el cambio de identidad de WhatsApp. Desde
                // marzo de 2026 Meta manda un **Business-Scoped User ID** (`CO.1112947…`) en
                // `messages[].from_user_id` y `contacts[].user_id`, y desde junio, con los
                // nombres de usuario, **quien escribe puede no tener teléfono en el webhook**:
                // ni `from` ni `wa_id`. No es un caso de borde — es el estado normal de un
                // cliente nuevo que llega por su nombre de usuario.
                //
                // El orden importa. El teléfono va primero **a propósito**: es lo que identifica
                // a la persona en el resto de la plataforma (`persona_negocio`), lo que prueba
                // la pertenencia de una cita o un pedido, y lo que ya tienen las conversaciones
                // abiertas. Con el BSUID delante, un cliente conocido estrenaría conversación y
                // perdería su historia.
                const deQuien =
                    mensaje.from ||
                    valor.contacts?.[0]?.wa_id ||
                    mensaje.from_user_id ||
                    valor.contacts?.[0]?.user_id ||
                    null;

                if (!deQuien) {
                    salida.sinRemitente.push({
                        tipo: mensaje.type ?? null,
                        // La FORMA, nunca el contenido: esto acaba en un log, y lo que escribió
                        // una persona no tiene por qué acabar ahí.
                        claves: Object.keys(mensaje).sort(),
                        claves_del_cambio: Object.keys(valor).sort(),
                        wamid: mensaje.id ?? null,
                    });
                    continue;
                }

                salida.mensajes.push({
                    canal: NOMBRE,
                    idNegocio,
                    // El número de la persona es su identidad en este canal. Es también el que
                    // permitirá reconocerla como `persona` el día que reserva adopte identidad.
                    idExterno: deQuien,
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
 * Procesa lo que trae un webhook ya interpretado.
 *
 * ## Cada cosa por su cuenta, y ninguna puede tumbar a las demás
 *
 * Antes esto era una fila de bucles sin red: el primer `throw` abortaba el resto del webhook.
 * El 2026-08-26 pasó de verdad — un mensaje sin remitente hizo saltar la validación del núcleo y
 * la persona que había escrito «Buenas tardes» no recibió nada. Y si Meta hubiera agrupado dos
 * mensajes en la misma entrega, se habrían perdido los dos.
 *
 * Un webhook es un lote de cosas independientes: el mensaje de un cliente, el acuse de otro, un
 * aviso de la cuenta. Que una falle no dice nada de las demás. **Ya se contestó 200 a Meta**, así
 * que lo que se pierda aquí no se reintenta: es la última oportunidad de que algo llegue, y por
 * eso el aislamiento no es prolijidad, es lo que decide si un cliente recibe respuesta.
 */
async function recibirWebhook(cuerpo, { config = configReal } = {}) {
    const leido = interpretarWebhook(cuerpo, { config });
    const acuses = [];
    const fallos = [];

    /** Ejecuta una pieza del lote sin que su fallo alcance a las demás. */
    async function aparte(que, detalle, tarea) {
        try {
            return await tarea();
        } catch (error) {
            fallos.push({ que, detalle, error: error.code || error.message });
            console.error(`[whatsapp] ${que} no se pudo procesar (${detalle}): ${error.message}`);
            return null;
        }
    }

    // Un mensaje que llegó sin saber quién lo manda. Se anota su FORMA —nunca su contenido— para
    // poder arreglarlo: es lo único que faltaba el 26 para no tener que adivinar.
    for (const raro of leido.sinRemitente) {
        console.error(
            `[whatsapp] mensaje SIN REMITENTE, se aparta: ${JSON.stringify(raro)}. ` +
                'Ni `from` ni `contacts[].wa_id`. Alguien escribió y no se le puede contestar.'
        );
    }

    for (const mensaje of leido.mensajes) {
        const acuse = await aparte('un mensaje', mensaje.idExternoMensaje || 'sin wamid', () =>
            motor.recibir(mensaje)
        );
        if (acuse) acuses.push(acuse);
    }

    for (const eco of leido.ecos) {
        await aparte('un eco del negocio', eco.wamid || 'sin wamid', () => silenciarPorHumano(eco));
    }

    for (const aviso of leido.avisos) {
        await aparte('un aviso de la cuenta', aviso.evento || 'sin evento', () =>
            registrarAviso(aviso)
        );
    }

    for (const estado of leido.estados) {
        // Solo interesa `failed`, y desde F8-B se puede **atar a la fila**: el `wamid` se guarda
        // al entregar. `sent`, `delivered` y `read` no se guardan a propósito — son tres
        // escrituras por mensaje en una tabla particionada de alto volumen a cambio de un dato
        // que hoy no responde ninguna pregunta. El día que alguien tenga que responderla, se
        // añaden aquí.
        //
        // Que esto importe no es evidente: Meta acepta el envío con un 200 y avisa **después**
        // de que no llegó. Sin este bucle, un mensaje que nadie recibió se ve en el Ledger
        // exactamente igual que uno que sí.
        if (estado.estado !== 'failed') continue;

        await aparte('un acuse fallido', estado.wamid || 'sin wamid', async () => {
            // Sin `idNegocio` a propósito: el de `estado` es el del número por el que entró el
            // acuse, no el del mensaje. Ver el comentario de `marcarAcuseDelCanal`.
            const fila = await repositorio.marcarAcuseDelCanal({
                idExternoCanal: estado.wamid,
                estado: 'fallido',
                detalle: { estado: estado.estado, error: estado.error },
            });

            await auditar('entrega_fallida', estado.idNegocio, {
                wamid: estado.wamid,
                destinatario: estado.destinatario,
                error: estado.error,
                // Un acuse sin fila nuestra no es un error: puede ser de un mensaje que mandó el
                // dueño desde su móvil, o de uno más viejo que la ventana de particiones.
                id_mensaje: fila?.id_mensaje ?? null,
            });
        });
    }

    return {
        recibidos: leido.mensajes.length,
        ecos: leido.ecos.length,
        avisos: leido.avisos.length,
        estados: leido.estados.length,
        ajenos: leido.ajenos,
        sinRemitente: leido.sinRemitente.length,
        fallos,
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
function renderizar({ texto, opciones = [], plantilla = null }) {
    const cuerpo = String(texto ?? '').trim() || '…';
    const lista = (opciones || []).filter((o) => o && o.id != null);

    // Una plantilla manda sobre todo lo demás: es el único formato que Meta acepta con la
    // ventana de 24 h cerrada, y su texto no lo componemos aquí —lo compone Meta con el que
    // aprobó—. Lo que va en el cuerpo del envío son solo los huecos, en orden.
    if (plantilla) return renderizarPlantilla(plantilla);

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
 * Traduce una plantilla del catálogo a lo que espera la Cloud API.
 *
 * Los parámetros van **posicionales** (`{{1}}`, `{{2}}`…) y su orden lo fija el catálogo, no
 * quien programó el mensaje: por eso se leen de ahí y no de las claves del objeto, cuyo orden en
 * un JSON no es un contrato. Mandarlos en otro orden no da error — da un mensaje que dice que la
 * cita es «de las 3 de Ana» en vez de «de Ana a las 3».
 */
function renderizarPlantilla({ nombre, idioma, parametros = {} }) {
    const definicion = plantillas.obtener(nombre);
    if (!definicion) {
        // No es reintentable: una plantilla que no está en el catálogo no aparece por insistir.
        const e = new Error(`No existe la plantilla "${nombre}" en el catálogo.`);
        e.code = 'WHATSAPP_PLANTILLA_DESCONOCIDA';
        e.reintentable = false;
        throw e;
    }

    const valores = definicion.parametros.map((clave) => ({
        type: 'text',
        text: String(parametros[clave] ?? '').trim(),
    }));

    return {
        type: 'template',
        template: {
            name: definicion.nombre,
            language: { code: idioma || definicion.idioma },
            // Una plantilla sin huecos no lleva `components`: mandarlo vacío es un 400.
            ...(valores.length ? { components: [{ type: 'body', parameters: valores }] } : {}),
        },
    };
}

/**
 * Entrega, que aquí significa «Meta lo aceptó» — no que alguien lo haya leído.
 *
 * La llama el Channel Gateway. Si lanza, se reintenta, salvo que el error diga
 * `reintentable: false` — desde F8-B el gateway sí distingue.
 *
 * ## La comprobación que hace esto distinto de F8-A
 *
 * Un texto libre solo puede salir con la **ventana de 24 h abierta**. Comprobarlo aquí, y no
 * dejar que lo diga Meta con un 400, tiene dos razones que no son de estilo: el error de Meta
 * llega después de haber gastado la llamada y sin decir a qué conversación culpar, y sobre todo
 * **la ventana no se reabre esperando** — reintentarlo cinco veces es tirar cinco llamadas y
 * retrasar el *dead letter*. Por eso el fallo se declara no reintentable.
 *
 * Que esto salte casi nunca es lo esperado: una respuesta se produce porque alguien acaba de
 * escribir. Salta cuando el bot tarda más de un día en contestar —que es un fallo de otra
 * cosa— y cuando alguien intenta iniciar una conversación sin plantilla, que es el error que
 * esta comprobación existe para hacer visible.
 */
async function entregar({
    idConversacion,
    idExterno,
    mensaje,
    api = apiReal,
    config = configReal,
    ventana = ventanaReal,
}) {
    const payload = renderizar(mensaje);

    if (!mensaje.plantilla) {
        const estadoVentana = await ventana.estado(idConversacion);
        if (!estadoVentana.abierta) {
            const desde = estadoVentana.ultimoEntranteEn
                ? `el último mensaje del cliente fue ${estadoVentana.ultimoEntranteEn.toISOString()}`
                : 'el cliente nunca ha escrito';
            const e = new Error(
                `Ventana de 24 h cerrada (${desde}): fuera de ella solo salen plantillas.`
            );
            e.code = 'WHATSAPP_FUERA_DE_VENTANA';
            e.reintentable = false;
            throw e;
        }
    }

    const { wamid } = await api.enviarMensaje({ para: idExterno, payload, config });
    return { idExternoCanal: wamid };
}

/**
 * «Estoy en ello» — el `mostrarActividad` del `ChannelPort`, que WhatsApp sirve con su indicador
 * nativo de escritura.
 *
 * ## Por qué existe este método y no un mensaje de «dame un segundo»
 *
 * Medido en producción: un turno del Nivel 1 se resuelve en 58 ms y uno que sube al modelo tarda
 * 2 317 ms de media. Ese silencio de dos segundos es lo que el dueño llamó «va lento», y no se
 * arregla acelerando el modelo —el 95 % de esos milisegundos son el viaje de ida y vuelta al
 * proveedor, no trabajo nuestro—: se arregla dejando de ser silencio.
 *
 * La alternativa evidente era mandar un mensaje de texto («un momento, lo consulto»). Se
 * descartó por dos razones y ninguna es de estilo:
 *
 *   1. **Llegaría tarde.** Un mensaje sale por la cola del gateway, que se sondea cada segundo;
 *      el aviso aterrizaría a la vez que la respuesta que anunciaba.
 *   2. **Ensucia la conversación para siempre.** El indicador desaparece solo; un «un momento»
 *      se queda en el historial, y una conversación de veinte turnos acaba con diez.
 *
 * ## Es opcional en el puerto, y eso es la mitad del diseño
 *
 * ADR-017 avisa del riesgo de mínimo común denominador y lo mitiga con esta regla exacta: un
 * adaptador puede **aprovechar capacidades extra de su canal siempre que degrade con gracia**
 * donde no existan. El WebChat no declara este método y no le pasa nada; el núcleo no sabe qué
 * es un indicador de escritura, solo que el turno se está alargando.
 */
async function mostrarActividad({ idExternoMensaje, api = apiReal, config = configReal }) {
    return api.enviarIndicadorEscritura({ wamid: idExternoMensaje, config });
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
    /**
     * En WhatsApp el `id_externo` de una conversación es el `from` del webhook, y ese webhook
     * viene **firmado por Meta** (HMAC-SHA256 sobre el cuerpo crudo, ver `firma.js`). Nadie puede
     * afirmar ser otro número sin falsificar la firma, así que aquí el identificador del canal no
     * es una etiqueta: es una identidad **autenticada**.
     *
     * El motor lo usa para dejar en el Principal un `telefono_verificado`, que es lo que permite
     * comprobar que quien cancela una cita es quien la pidió. Lo declara el canal —y no lo deduce
     * el motor— porque el núcleo no debe saber qué canales existen (ADR-017).
     */
    idExternoEsIdentidad: true,
    entregar,
    mostrarActividad,
    recibirWebhook,
    interpretarWebhook,
    renderizar,
    renderizarPlantilla,
    textoDeMensaje,
    silenciarPorHumano,
    LIMITES,
};
