/**
 * Cortacircuito de bucles: el asistente no le contesta sin fin a quien no es una persona.
 *
 * ## El caso
 *
 * 2026-10-06, negocio 10: un número de empresa (una promoción de un operador) le escribió al
 * WhatsApp de un cliente. El asistente le ofreció agendar; el bot del otro lado contestó cada
 * mensaje nuestro con uno que el canal no sabe leer (`[unsupported]`), y el flujo de citas
 * repitió «Elige uno de los servicios de la lista, por favor.» **929 veces en 11 horas**. Se
 * comió los mensajes gratis del mes del cliente y nadie se enteró hasta mirar la factura.
 *
 * Ningún flujo tenía por qué saberlo: cada uno contestó bien SU turno. Lo que faltaba es alguien
 * que mire la conversación entera, y por eso esto vive en el motor —el único sitio por donde sale
 * toda respuesta, de cualquier vertical y de cualquier nivel— y no en cada flujo.
 *
 * ## Las reglas
 *
 * Todas miran lo ya escrito en `intelligence.mensaje`, no memoria del proceso: sobreviven a un
 * reinicio, que es justo cuando un bucle seguiría vivo.
 *
 *  1. **Repetición** — los últimos N mensajes del asistente dicen lo mismo que va a decir ahora.
 *     Ya lo dijo N veces: decirlo otra no ayuda a nadie. *Se calla* (este turno no responde).
 *  2. **Ilegibles** — el turno solo trae mensajes que no se pueden leer y ya van N en la ventana.
 *     *Se calla*.
 *  3. **Ritmo** — demasiadas respuestas del asistente en una hora, o en un día. Ninguna persona
 *     conversa así. *Se le pasa a una persona* y el asistente no vuelve solo.
 *
 * Callarse no cambia el estado: si quien escribe era una persona insistiendo, en cuanto diga
 * otra cosa —o el asistente tenga otra cosa que decir— la conversación sigue. Pasar a una
 * persona sí lo cambia, y borra `humano_ultimo_en` para que la reactivación por plazo
 * (ADR-023, Enmienda 2) no le devuelva el hilo al asistente: la regla de esa enmienda ya es que
 * sin intervención humana el asistente no vuelve solo, y un bucle no es una intervención.
 *
 * Ante cualquier fallo al consultar, no corta: un cortacircuito roto no puede dejar mudo al
 * asistente de todos los negocios.
 */
'use strict';

const { sequelize } = require('../../app_core/models/conection');

const entero = (valor, defecto) => {
    const n = Number(valor);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defecto;
};

/** 0 en cualquiera apaga esa regla. */
const CONFIG = {
    /** Cuántas veces seguidas puede decir lo mismo antes de callarse. */
    repetidas: entero(process.env.CORTACIRCUITO_REPETIDAS, 3),
    /** Cuántos mensajes ilegibles se contestan antes de ignorarlos. */
    ilegibles: entero(process.env.CORTACIRCUITO_ILEGIBLES, 3),
    /** La ventana de las dos reglas anteriores. */
    ventanaHoras: entero(process.env.CORTACIRCUITO_VENTANA_HORAS, 6),
    /** Respuestas del asistente a una misma conversación: por hora y por día. */
    maxPorHora: entero(process.env.CORTACIRCUITO_MAX_HORA, 40),
    maxPorDia: entero(process.env.CORTACIRCUITO_MAX_DIA, 120),
};

const REGLA = {
    REPETICION: 'repeticion',
    ILEGIBLES: 'ilegibles',
    RITMO_HORA: 'ritmo_hora',
    RITMO_DIA: 'ritmo_dia',
};

const ILEGIBLE = /^\[unsupported\]$/i;

/** Para comparar dos mensajes: sin mayúsculas ni espacios de más. */
function igualar(texto) {
    return String(texto ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function textoDe(respuesta) {
    return typeof respuesta === 'string' ? respuesta : respuesta?.texto;
}

/**
 * La decisión, sobre datos ya leídos. Pura: es lo que se prueba.
 *
 * @param {object} p
 * @param {string[]} p.respuestas          lo que el asistente va a decir en este turno
 * @param {string[]} p.entrantesDelTurno   lo que escribió el cliente en este turno
 * @param {string[]} p.ultimasDelAsistente sus últimos mensajes en la ventana, del más nuevo al más viejo
 * @param {number}   p.ilegiblesEnVentana  entrantes ilegibles en la ventana, contando los de este turno
 * @param {number}   p.enLaHora            respuestas del asistente en la última hora
 * @param {number}   p.enElDia             respuestas del asistente en las últimas 24 h
 * @returns {{ regla: string, pasar_a_persona: boolean, [k: string]: any } | null}
 */
function decidir(
    { respuestas = [], entrantesDelTurno = [], ultimasDelAsistente = [], ilegiblesEnVentana = 0, enLaHora = 0, enElDia = 0 },
    config = CONFIG
) {
    if (respuestas.length === 0) return null;

    // El ritmo va primero: es la única regla que saca al asistente de la conversación, y la que
    // tiene que ganar si las otras dos no bastaron para parar el bucle.
    if (config.maxPorHora > 0 && enLaHora >= config.maxPorHora) {
        return { regla: REGLA.RITMO_HORA, pasar_a_persona: true, respuestas_en_la_hora: enLaHora };
    }
    if (config.maxPorDia > 0 && enElDia >= config.maxPorDia) {
        return { regla: REGLA.RITMO_DIA, pasar_a_persona: true, respuestas_en_el_dia: enElDia };
    }

    if (config.repetidas > 0 && ultimasDelAsistente.length >= config.repetidas) {
        const ahora = igualar(textoDe(respuestas[0]));
        const mismas = ultimasDelAsistente.slice(0, config.repetidas).every((t) => igualar(t) === ahora);
        if (ahora && mismas) {
            return { regla: REGLA.REPETICION, pasar_a_persona: false, veces: config.repetidas };
        }
    }

    const soloIlegibles =
        entrantesDelTurno.length > 0 && entrantesDelTurno.every((t) => ILEGIBLE.test(String(t ?? '').trim()));
    if (config.ilegibles > 0 && soloIlegibles && ilegiblesEnVentana > config.ilegibles) {
        return { regla: REGLA.ILEGIBLES, pasar_a_persona: false, ilegibles: ilegiblesEnVentana };
    }

    return null;
}

/**
 * Lee lo que hace falta de la conversación y decide. Devuelve `null` si el turno sigue normal.
 */
async function evaluar({ conversacion, mensajes = [], respuestas = [], transaction }, config = CONFIG) {
    if (!respuestas || respuestas.length === 0) return null;
    try {
        // Del asistente son los salientes con turno; los que escribe una persona del negocio
        // (Bandeja, su celular) no llevan turno y no cuentan: una persona puede repetirse.
        const filas = await sequelize.query(
            `
            SELECT direccion, contenido, (id_turno IS NOT NULL) AS con_turno,
                   (creado_en >= now() - interval '1 hour') AS en_la_hora,
                   (creado_en >= now() - (:ventana * interval '1 hour')) AS en_ventana
              FROM intelligence.mensaje
             WHERE id_conversacion = :idConversacion
               AND creado_en >= now() - interval '24 hours'
             ORDER BY creado_en DESC
             LIMIT 600;
            `,
            {
                replacements: {
                    idConversacion: conversacion.id_conversacion,
                    ventana: Math.max(config.ventanaHoras, 1),
                },
                type: sequelize.QueryTypes.SELECT,
                transaction,
                logging: false,
            }
        );
        const delAsistente = filas.filter((f) => f.direccion === 'saliente' && f.con_turno);
        return decidir(
            {
                respuestas,
                entrantesDelTurno: mensajes.map((m) => m.contenido),
                ultimasDelAsistente: delAsistente.filter((f) => f.en_ventana).map((f) => f.contenido),
                ilegiblesEnVentana: filas.filter(
                    (f) => f.direccion === 'entrante' && f.en_ventana && ILEGIBLE.test(String(f.contenido ?? '').trim())
                ).length,
                enLaHora: delAsistente.filter((f) => f.en_la_hora).length,
                enElDia: delAsistente.length,
            },
            config
        );
    } catch (error) {
        console.warn(`[cortacircuito] no se pudo evaluar, el turno sigue: ${error.message}`);
        return null;
    }
}

/**
 * Tras pasar la conversación a una persona por un bucle: que la reactivación por plazo no la
 * devuelva al asistente, y que quede escrito por qué.
 */
async function asentarCorte({ conversacion, corte, transaction }) {
    await sequelize.query(
        `UPDATE intelligence.conversacion SET humano_ultimo_en = NULL WHERE id_conversacion = :idConversacion;`,
        { replacements: { idConversacion: conversacion.id_conversacion }, transaction }
    );
    await sequelize.query(
        `
        INSERT INTO auditoria.audit_evento (modulo, accion, resultado, id_negocio, detalle)
        VALUES ('intelligence', 'bucle_cortado', 'ok', :idNegocio, CAST(:detalle AS jsonb));
        `,
        {
            replacements: {
                idNegocio: conversacion.id_negocio,
                detalle: JSON.stringify({ id_conversacion: conversacion.id_conversacion, ...corte }),
            },
            transaction,
        }
    );
}

module.exports = { CONFIG, REGLA, decidir, evaluar, asentarCorte };
