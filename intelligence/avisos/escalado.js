/**
 * El aviso de que una conversación se escaló — el único que sale de la conversación hacia el
 * negocio, y no hacia su cliente.
 *
 * ## El agujero que tapa
 *
 * Desde F7 el bot reconoce que no sabe, lo dice sin prometer lo que no puede cumplir y **se
 * calla** ([ADR-023](../../docs/adr/ADR-023-mutaciones-ia.md)). Desde 2026-08-29 el negocio tiene
 * dónde contestar: la Bandeja. Faltaba lo de en medio — **nadie avisaba**. La Bandeja se refresca
 * sola cada cinco segundos, lo que sirve exactamente a quien ya la está mirando; el cliente que
 * escribe un domingo por la noche se quedaba esperando con la conversación abierta y el dueño sin
 * enterarse.
 *
 * ## Cómo avisa, y por qué así
 *
 * Dos vías, y ninguna es WhatsApp todavía:
 *
 *   - **La campanita del admin**, que ya existe (`general.gener_notificacion`). Reutilizarla cuesta
 *     una fila y sale con contador, marcado de leída e historial. Un contador nuevo solo habría
 *     añadido una segunda verdad sobre lo mismo.
 *   - **Un correo**, que es lo único que interrumpe a alguien que no está dentro de la aplicación.
 *
 * Avisar al dueño por WhatsApp sería mejor canal —ahí vive— pero es un mensaje que inicia la
 * empresa, y eso exige plantilla aprobada por Meta. Cuando exista, es un tercer destino aquí y no
 * un rediseño: este archivo decide **cuándo** se avisa; el cómo son tres líneas.
 *
 * ## Las dos reglas que evitan que el aviso sea peor que el silencio
 *
 * 1. **Se relee antes de avisar.** El evento es delgado (ADR-013, regla 2): trae el identificador,
 *    no el estado. Si en los segundos que tarda el relay el negocio ya respondió desde la Bandeja
 *    —lo que marca la conversación como atendida— el aviso no sale. Avisar de algo ya hecho enseña
 *    a ignorar los avisos.
 * 2. **Como mucho uno cada cuarto de hora, y dice cuántas hay.** Cinco clientes escalando a la vez
 *    son cinco correos que se leen como spam y una campanita ilegible. Se avisa una vez, y el aviso
 *    cuenta **cuántas conversaciones están esperando**, releído en ese momento.
 *
 * La segunda regla es además lo que hace idempotente a este consumidor, que el outbox exige porque
 * entrega **al menos una vez** ([ADR-012](../../docs/adr/ADR-012-outbox.md)): una reentrega llega
 * segundos después de la primera, dentro de la ventana, y no produce un segundo aviso.
 *
 * ## Lo que NO viaja en el aviso
 *
 * Ni el texto del cliente ni su teléfono. El aviso dice que hay alguien esperando y dónde mirarlo;
 * el contenido se lee en la Bandeja, que es donde el acceso está acotado al negocio dueño de la
 * conversación (ADR-024 y Ley 1581: un correo se reenvía, una bandeja no).
 */
'use strict';
const Models = require('../../app_core/models/conection');
const notificacionDao = require('../../app_core/dao/notificacionDao');
const { numeroDeEntorno } = require('../engine/cola');

const EVENTO = 'conversacion.escalada.v1';
const TIPO_NOTIFICACION = 'CONVERSACION_ESCALADA';
const ESTADO_HANDOFF = 'handoff_humano';

const CONFIG = {
    /**
     * Cuánto tiene que pasar entre dos avisos del mismo negocio. Quince minutos es lo bastante
     * corto para que el primer cliente no espere de más y lo bastante largo para que una ráfaga
     * no llene el buzón de nadie.
     */
    minutosEntreAvisos: numeroDeEntorno('AVISO_ESCALADO_MINUTOS', 15),
    /** Apagar el correo sin apagar la campanita. Útil en desarrollo y con un SMTP caído. */
    correo: process.env.AVISO_ESCALADO_CORREO !== 'false',
};

const SELECT = { type: Models.sequelize.QueryTypes.SELECT };

/** La conversación, releída. `null` si ya no existe. */
async function leerConversacion(idConversacion, idNegocio) {
    const [fila] = await Models.sequelize.query(
        `
        SELECT c.id_conversacion, c.id_negocio, c.canal, c.estado, c.atendida_en,
               n.nombre AS negocio, n.email_contacto
          FROM intelligence.conversacion c
          LEFT JOIN general.gener_negocio n ON n.id_negocio = c.id_negocio
         WHERE c.id_conversacion = :id AND c.id_negocio = :idNegocio;
        `,
        { replacements: { id: idConversacion, idNegocio }, ...SELECT }
    );
    return fila || null;
}

/**
 * Cuántas conversaciones del negocio están esperando a una persona.
 *
 * Es la misma definición que la columna «escalada» de la Bandeja —`handoff_humano` y sin atender—,
 * y tiene que seguir siéndolo: un aviso que cuenta distinto de lo que se ve al abrir la pantalla es
 * un aviso que nadie vuelve a creer.
 */
async function contarEsperando(idNegocio) {
    const [fila] = await Models.sequelize.query(
        `
        SELECT count(*)::int AS total
          FROM intelligence.conversacion
         WHERE id_negocio = :idNegocio AND estado = :handoff AND atendida_en IS NULL;
        `,
        { replacements: { idNegocio, handoff: ESTADO_HANDOFF }, ...SELECT }
    );
    return fila?.total ?? 0;
}

/** ¿Ya se avisó a este negocio hace poco? */
async function avisadoHacePoco(idNegocio) {
    const [fila] = await Models.sequelize.query(
        `
        SELECT 1 AS hay
          FROM general.gener_notificacion
         WHERE id_negocio = :idNegocio
           AND tipo = :tipo
           AND fecha_creacion > now() - (:minutos || ' minutes')::interval
         LIMIT 1;
        `,
        {
            replacements: {
                idNegocio,
                tipo: TIPO_NOTIFICACION,
                minutos: String(CONFIG.minutosEntreAvisos),
            },
            ...SELECT,
        }
    );
    return Boolean(fila);
}

/**
 * A quién se le escribe.
 *
 * El contacto del negocio primero, que es el que el propio negocio declaró. Los administradores
 * principales van detrás y no en su lugar: un negocio sin `email_contacto` —se puede crear desde el
 * panel sin ponerlo— se quedaría sin aviso por un campo opcional.
 *
 * Nadie más. El resto de usuarios de un negocio son cajeros y meseros, y esto no es su trabajo.
 */
async function destinatarios(idNegocio) {
    const filas = await Models.sequelize.query(
        `
        SELECT DISTINCT u.email
          FROM general.gener_negocio_usuario nu
          JOIN general.gener_usuario u ON u.id_usuario = nu.id_usuario
         WHERE nu.id_negocio = :idNegocio
           AND nu.estado = 'A' AND u.estado = 'A'
           AND u.es_admin_principal = true
           AND u.email IS NOT NULL;
        `,
        { replacements: { idNegocio }, ...SELECT }
    );
    return filas.map((f) => f.email).filter(Boolean);
}

function comoSeDice(esperando) {
    return esperando > 1
        ? `${esperando} conversaciones están esperando que alguien del negocio responda.`
        : 'Un cliente está esperando que alguien del negocio le responda.';
}

/**
 * El consumidor.
 *
 * Los motivos por los que no se avisa se **devuelven**, no se lanzan: no son fallos del relay, y
 * lanzarlos lo reintentaría cinco veces para acabar mandando a *dead letter* un evento que hizo
 * exactamente lo correcto (mismo criterio que el programador de recordatorios).
 */
async function alEscalarse(evento) {
    const idConversacion = evento?.payload?.id_conversacion;
    if (!idConversacion) return { avisado: false, motivo: 'el evento no trae id_conversacion' };

    const conversacion = await leerConversacion(idConversacion, evento.id_negocio);
    if (!conversacion) return { avisado: false, motivo: 'la conversación ya no existe' };
    // Releer es lo que evita avisar de algo ya resuelto: entre el escalado y este momento pasan
    // segundos, y en esos segundos el negocio puede haber contestado desde la Bandeja.
    if (conversacion.estado !== ESTADO_HANDOFF) {
        return { avisado: false, motivo: `la conversación está "${conversacion.estado}"` };
    }
    if (conversacion.atendida_en) return { avisado: false, motivo: 'ya la atendieron' };

    if (await avisadoHacePoco(evento.id_negocio)) {
        return { avisado: false, motivo: 'ya se avisó hace menos de la ventana' };
    }

    const esperando = await contarEsperando(evento.id_negocio);
    const mensaje =
        `${comoSeDice(esperando)} El asistente ya le dijo que le contesta una persona, así que la ` +
        'promesa está hecha. Ábrela en Conversaciones.';

    // La campanita va ANTES que el correo, y no al revés. Es la que deja la marca por la que este
    // consumidor es idempotente: si el correo falla después, la reentrega del evento encuentra la
    // fila y no vuelve a avisar. Al revés se mandaría un correo por cada reintento.
    await notificacionDao.crearNotificacion({
        id_negocio: evento.id_negocio,
        tipo: TIPO_NOTIFICACION,
        titulo: esperando > 1 ? 'Conversaciones esperando respuesta' : 'Una conversación te espera',
        mensaje,
    });

    const correos = CONFIG.correo ? await enviarCorreos(conversacion, esperando) : 0;
    return { avisado: true, esperando, correos };
}

/**
 * Manda el correo, y **no deja que su fallo tumbe el aviso**.
 *
 * Un SMTP caído no puede convertir un escalado en un error del relay: la campanita ya está puesta
 * —que es el aviso que no depende de terceros— y reintentar el evento solo repetiría la parte que
 * salió bien. Se registra en consola, que es donde se mira cuando alguien dice «no me llegó».
 */
async function enviarCorreos(conversacion, esperando) {
    const destinos = new Set();
    if (conversacion.email_contacto) destinos.add(conversacion.email_contacto);
    for (const email of await destinatarios(conversacion.id_negocio)) destinos.add(email);

    if (destinos.size === 0) {
        console.warn(
            `[aviso-escalado] El negocio ${conversacion.id_negocio} no tiene a quién escribirle ` +
                '(sin email_contacto y sin administrador principal). Queda solo la campanita.'
        );
        return 0;
    }

    // Se importa aquí y no arriba a propósito: el transporte de correo vive en el módulo de admin
    // y **no** es un requisito de Intelligence. Cargarlo solo cuando de verdad hay que escribir
    // mantiene el arranque libre de esa dependencia, y el servicio ya degrada solo sin `MAIL_USER`.
    const mailService = require('../../app_admin_api/services/mailService');

    let enviados = 0;
    for (const email of destinos) {
        try {
            await mailService.sendConversacionEscaladaEmail(email, {
                nombreNegocio: conversacion.negocio || 'tu negocio',
                esperando,
            });
            enviados++;
        } catch (error) {
            console.error(`[aviso-escalado] No se pudo avisar a ${email}: ${error.message}`);
        }
    }
    return enviados;
}

/**
 * Se engancha al relay del outbox. Lo llama la composición (`intelligence/index.js`), nunca el
 * núcleo — misma regla que los adaptadores de vertical y los canales.
 */
function registrar({ relay }) {
    relay.registrarConsumidor('aviso-escalado', { patron: [EVENTO], manejar: alEscalarse });
}

module.exports = {
    CONFIG,
    EVENTO,
    TIPO_NOTIFICACION,
    registrar,
    alEscalarse,
    contarEsperando,
    destinatarios,
    comoSeDice,
};
