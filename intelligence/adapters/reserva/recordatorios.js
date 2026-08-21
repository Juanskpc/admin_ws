/**
 * Recordatorios de `reserva` — lo único de esta fase que sabe qué es una cita.
 *
 * `intelligence/recordatorios/` sabe programar, esperar y entregar; **no sabe leer una cita**, y no
 * puede aprender: el acoplamiento con el esquema de una vertical vive en su adaptador y en ningún
 * otro sitio ([ADR-005](../../../docs/adr/ADR-005-independencia-verticales.md),
 * [ADR-009](../../../docs/adr/ADR-009-capability-adapter.md)). Este archivo es esa frontera, y es
 * también lo que F9 va a mirar: añadir recordatorios de `restaurante` debe ser escribir el hermano
 * de este archivo, sin tocar una línea del núcleo.
 *
 * Hace dos cosas, y la segunda es la interesante:
 *
 *   1. **Consumir `cita.creada.v1`** y programar el recordatorio. Es el primer consumidor del
 *      outbox de F1, que hasta hoy transportaba eventos que nadie escuchaba a propósito.
 *   2. **Releer la cita al vencer** (`revisar`). El recordatorio no se fía de lo que sabía al
 *      programarse: pregunta si la cita sigue viva, a qué hora es *ahora* y cómo se llama quien la
 *      pidió. Por eso no hace falta escuchar cancelaciones ni reagendas —ni el `UPDATE` a mano que
 *      alguien haga desde el panel—, y por eso el sistema es correcto aunque un evento se pierda.
 */
'use strict';
const Models = require('../../../app_core/models/conection');
const recordatorios = require('../../recordatorios');
const contextoNegocio = require('../../core/contextoNegocio');
const { normalizarE164Colombia } = require('../../../app_core/helpers/telefono');
const { numeroDeEntorno } = require('../../engine/cola');

const PREFIJO = 'cita';
const PLANTILLA = 'recordatorio_cita';
const EVENTO = 'cita.creada.v1';

const CONFIG = {
    /** Cuánto antes se avisa. Un día es lo que deja margen para reagendar sin perder el hueco. */
    horasAntes: numeroDeEntorno('RECORDATORIO_CITA_HORAS_ANTES', 24),
};

/** Los estados en los que todavía tiene sentido recordarle a alguien que venga. */
const ESTADOS_VIVOS = new Set(['pendiente', 'confirmada']);

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * «el viernes 22 de agosto a las 10:00».
 *
 * En hora de pared de Bogotá y sin pasar por UTC: `fecha_hora_inicio` es un `timestamp without
 * time zone` que la sesión de Postgres interpreta como Bogotá, y componer la frase con
 * `toISOString()` la correría cinco horas — de noche, además, cambiaría el día. Es la trampa que
 * este repositorio ya pagó dos veces.
 */
function comoSeDice(fecha) {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short',
        hour12: false,
    }).formatToParts(new Date(fecha));
    const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
    const diaSemana = DIAS[new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`).getUTCDay()];
    return `el ${diaSemana} ${Number(p.day)} de ${MESES[Number(p.month) - 1]} a las ${p.hour}:${p.minute}`;
}

/**
 * El número, como lo escribe el canal.
 *
 * **Sin el `+`, y eso no es cosmética.** El `id_externo` de una conversación de WhatsApp es el
 * `from` del webhook, que llega como `573001234567`. Guardar aquí `+573001234567` crearía una
 * **segunda** conversación para la misma persona —la clave única es `(negocio, canal, id_externo)`—
 * y el recordatorio saldría por un hilo distinto del que la persona tiene abierto.
 */
function comoLoEscribeElCanal(telefono) {
    const e164 = normalizarE164Colombia(telefono);
    return e164 ? e164.replace(/^\+/, '') : null;
}

function referenciaDe(codigoPublico) {
    return `${PREFIJO}:${codigoPublico}`;
}

/** Todo lo que hace falta de una cita, en una consulta. */
async function leerCita({ idCita = null, codigoPublico = null, idNegocio }, { transaction = null } = {}) {
    const [fila] = await Models.sequelize.query(
        `
        SELECT c.id_cita, c.codigo_publico, c.estado, c.fecha_hora_inicio,
               c.cliente_nombre, c.cliente_telefono,
               (SELECT string_agg(s.nombre, ' y ' ORDER BY s.nombre)
                  FROM reserva.reserva_cita_servicio cs
                  JOIN reserva.reserva_servicio s ON s.id_servicio = cs.id_servicio
                 WHERE cs.id_cita = c.id_cita) AS servicios
          FROM reserva.reserva_cita c
         WHERE c.id_negocio = :idNegocio
           AND (:idCita::int IS NULL OR c.id_cita = :idCita::int)
           AND (:codigoPublico::uuid IS NULL OR c.codigo_publico = :codigoPublico::uuid);
        `,
        {
            replacements: { idCita, codigoPublico, idNegocio },
            transaction,
            type: Models.sequelize.QueryTypes.SELECT,
        }
    );
    return fila || null;
}

function cuandoAvisar(inicio) {
    return new Date(new Date(inicio).getTime() - CONFIG.horasAntes * 3600 * 1000);
}

// ── 1. El consumidor del outbox ─────────────────────────────────────────────────────────────

/**
 * Programa el recordatorio de una cita recién creada.
 *
 * Los motivos por los que **no** se programa se devuelven, no se lanzan: un evento que no produce
 * recordatorio no es un fallo del relay, y hacerlo fallar lo reintentaría cinco veces y lo acabaría
 * mandando a *dead letter* por hacer exactamente lo correcto.
 */
async function alCrearseUnaCita(evento, { transaction = null } = {}) {
    const idCita = evento?.payload?.id_cita;
    if (!idCita) return { programado: false, motivo: 'el evento no trae id_cita' };

    const cita = await leerCita({ idCita, idNegocio: evento.id_negocio }, { transaction });
    if (!cita) return { programado: false, motivo: 'la cita ya no existe' };

    const idExterno = comoLoEscribeElCanal(cita.cliente_telefono);
    // Sin teléfono no hay a quién escribirle. Pasa siempre que la cita la crea el negocio desde el
    // panel sin pedirlo, y es un caso normal, no un error.
    if (!idExterno) return { programado: false, motivo: 'la cita no tiene teléfono' };

    const enviarEn = cuandoAvisar(cita.fecha_hora_inicio);
    // Una cita para dentro de dos horas ya nace con el recordatorio pasado. No se programa: sería
    // programar algo para el pasado y que el drenaje lo cancele en el primer pase.
    if (enviarEn <= new Date()) {
        return { programado: false, motivo: 'la cita es antes de la antelación del recordatorio' };
    }

    const negocio = await contextoNegocio.obtener(evento.id_negocio);

    await recordatorios.programar(
        {
            idNegocio: evento.id_negocio,
            canal: recordatorios.CONFIG.canal,
            idExterno,
            referencia: referenciaDe(cita.codigo_publico),
            plantilla: PLANTILLA,
            parametros: {
                cliente: cita.cliente_nombre,
                negocio: negocio.tratamiento,
                servicio: cita.servicios || 'tu cita',
                cuando: comoSeDice(cita.fecha_hora_inicio),
            },
            enviarEn,
        },
        { transaction }
    );

    return { programado: true, enviarEn };
}

// ── 2. El revisor ───────────────────────────────────────────────────────────────────────────

/**
 * Relee la cita en el momento de enviar. Es lo que hace que no haga falta escuchar cancelaciones.
 *
 * Devuelve `enviarEn` recalculado desde la hora **de ahora** de la cita: si se movió, el
 * recordatorio se mueve con ella en vez de salir avisando de una hora que ya no es.
 */
async function revisar({ referencia, idNegocio }, { transaction = null } = {}) {
    const codigo = String(referencia).slice(PREFIJO.length + 1);
    const cita = await leerCita({ codigoPublico: codigo, idNegocio }, { transaction });

    if (!cita) return { vigente: false, motivo: 'la cita ya no existe' };
    if (!ESTADOS_VIVOS.has(cita.estado)) {
        return { vigente: false, motivo: `la cita está "${cita.estado}"` };
    }
    if (new Date(cita.fecha_hora_inicio) <= new Date()) {
        return { vigente: false, motivo: 'la cita ya pasó' };
    }

    const negocio = await contextoNegocio.obtener(idNegocio);

    return {
        vigente: true,
        enviarEn: cuandoAvisar(cita.fecha_hora_inicio),
        parametros: {
            cliente: cita.cliente_nombre,
            negocio: negocio.tratamiento,
            servicio: cita.servicios || 'tu cita',
            cuando: comoSeDice(cita.fecha_hora_inicio),
        },
    };
}

/**
 * Se engancha a los dos sitios donde hace falta: el relay del outbox y el drenaje.
 *
 * Lo llama la composición (`intelligence/index.js`), no el núcleo — es la misma regla que la lista
 * de adaptadores y la de canales.
 */
function registrar({ relay }) {
    recordatorios.registrarRevisor(PREFIJO, revisar);
    // El patrón va como lista y no como cadena: `leInteresa` admite `RegExp` o array, y una
    // cadena suelta acabaría llamando a `patron.test` sobre un `String`.
    relay.registrarConsumidor('recordatorios-reserva', {
        patron: [EVENTO],
        manejar: alCrearseUnaCita,
    });
}

module.exports = {
    CONFIG,
    EVENTO,
    PLANTILLA,
    PREFIJO,
    registrar,
    alCrearseUnaCita,
    revisar,
    referenciaDe,
    comoSeDice,
    comoLoEscribeElCanal,
};
