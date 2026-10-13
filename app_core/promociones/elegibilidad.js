/**
 * La compuerta: ¿puede este negocio mandar una promoción, y qué le falta? (F2, §6.8 del doc).
 *
 * ## Por qué es un servicio y no unos `if` en la pantalla
 *
 * Porque la pantalla y la API tienen que mirar **la misma** respuesta. Esconder un botón no cierra
 * una API —es la lección que ya dejó escrita `tiqueteras-y-fiado.md`—, y aquí lo que hay detrás del
 * botón gasta dinero del negocio y pone en juego la calificación de su número.
 *
 * ## Qué bloquea y qué solo avisa
 *
 * La distinción es la parte interesante. Bloquea lo que haría que el envío **salga mal o salga
 * caro para quien no debe**; avisa lo que el dueño tiene derecho a decidir:
 *
 * | | Bloquea | Por qué |
 * |---|---|---|
 * | Sin plan activo | sí | es una función del plan |
 * | Sin canal, o canal que no es suyo | **sí** | si sale por nuestra WABA, Meta nos factura a nosotros y su calidad es la nuestra |
 * | El canal ES el nuestro y el negocio ES el nuestro | no, avisa | el piloto de EscalApp sobre su propio número (`plantillasMeta.canalDe`) |
 * | Sin plantilla aprobada | sí | el envío fallaría con `#132001` y moriría en dead letter |
 * | Calidad del número en **rojo** | sí | una campaña ahí es cómo se pierde el número |
 * | Sin destinatarios | sí | no hay nada que mandar |
 * | **Sin la prueba al dueño entregada** | sí | ver abajo |
 * | Calidad desconocida | no, avisa | no se puede castigar a nadie por un dato que no pudimos leer |
 * | Más destinatarios que el tier de 24 h | no, avisa | se parte en varios días, no se cancela |
 * | Cupo del asistente justo | no, avisa | es su decisión, pero tiene que saberlo |
 * | Fuera del horario | no, avisa | se programa para mañana |
 *
 * ## ⚠️ La prueba al dueño es el centro de todo esto
 *
 * Antes de mandarle nada a 400 clientes se manda **un** mensaje real al número del dueño. Cuesta
 * ~$50 y comprueba de una vez las tres cosas que no se pueden consultar con fiabilidad:
 *
 *   1. que la cuenta de Meta del negocio **tiene método de pago** (si no, el envío falla con
 *      `131042` y no hay API que lo diga antes),
 *   2. que la plantilla existe en su WABA con ese nombre e idioma,
 *   3. y que el número puede mandar marketing.
 *
 * Y además le enseña al dueño exactamente lo que va a recibir su cliente. Ninguna campaña sale sin
 * que su prueba haya llegado.
 *
 * ## Falla abierto solo donde es seguro
 *
 * Si no se puede hablar con Meta, la calidad queda «desconocida» y **avisa**; si no se puede leer
 * el cupo del asistente, no se avisa de eso y se sigue. Lo que nunca falla abierto es el canal
 * propio ni la plantilla: ahí el error barato es no mandar.
 */
'use strict';

const Models = require('../models/conection');
const planHelper = require('../helpers/planHelper');
const plantillasMeta = require('./plantillasMeta');
const audiencia = require('./audiencia');
const numeros = require('../../intelligence/channels/whatsapp/numeros');
const cuota = require('../../intelligence/channels/whatsapp/cuota');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };

const BASE = process.env.META_GRAPH_URL || 'https://graph.facebook.com';
const TIMEOUT_MS = 12000;

/** Franja en la que se puede enviar, hora de pared de Bogotá. Una promo a las 11 p.m. es una denuncia. */
const HORA_MIN = 8;
const HORA_MAX = 21;

/** Tier de mensajería por defecto cuando Meta no lo dice: el de una empresa sin verificar. */
const TIER_SIN_VERIFICAR = 250;

/**
 * Cuánto de la calidad del número se tolera.
 *
 * `GREEN` y `YELLOW` pasan; `RED` no. El amarillo avisa pero no bloquea porque un número puede
 * amarillear por una racha de bloqueos ajena a las promociones, y dejar a un negocio sin su
 * herramienta por eso sería castigarlo dos veces.
 */
const CALIDAD_QUE_BLOQUEA = new Set(['RED']);

function motivo(code, mensaje, { bloquea = true, dato = null } = {}) {
    return { code, mensaje, bloquea, dato };
}

/**
 * Lee de Meta lo que hay que saber del número: calidad y cuánta gente nueva deja alcanzar en 24 h.
 *
 * Pide los campos de uno en uno conceptualmente —en una sola llamada, pero tolerando que Meta no
 * reconozca alguno— por lo mismo que hace `embeddedSignupApi.listarNumeros`: un campo que una
 * versión de la Graph API no sirve tumba la llamada entera y deja sin diagnóstico lo demás.
 */
async function estadoDelNumero({ idNegocio, fetchImpl = globalThis.fetch } = {}) {
    const phoneNumberId = numeros.numeroDe(idNegocio);
    // El negocio de alta manual no tiene token propio porque cuelga de la WABA de EscalApp, y por
    // ahí sale ya todo lo que manda hoy (`api.js` cae al token global). Si no se cayera también
    // aquí, el único negocio con las promociones encendidas tendría la calidad de su número
    // «desconocida» para siempre, que es precisamente el dato por el que se pausa una campaña.
    const token = numeros.tokenDeNegocio(idNegocio)
        || (plantillasMeta.esNegocioDeLaPlataforma(idNegocio) ? process.env.WHATSAPP_TOKEN : null);
    if (!phoneNumberId || !token) return { leido: false };

    const campos = 'quality_rating,messaging_limit_tier,throughput,display_phone_number';
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
    try {
        const r = await fetchImpl(
            `${BASE}/${plantillasMeta.VERSION_API}/${phoneNumberId}?fields=${campos}`,
            { headers: { Authorization: `Bearer ${token}` }, signal: control.signal }
        );
        const datos = await r.json().catch(() => null);
        if (!r.ok) return { leido: false, error: datos?.error?.message || `HTTP ${r.status}` };

        // `messaging_limit_tier` llega como 'TIER_1K', 'TIER_10K', 'TIER_UNLIMITED'…
        const tierTexto = String(datos?.messaging_limit_tier || '');
        const tier = /UNLIMITED/i.test(tierTexto)
            ? Infinity
            : Number((tierTexto.match(/(\d+)K/i)?.[1] ?? 0)) * 1000 || null;

        return {
            leido: true,
            calidad: datos?.quality_rating ?? null,
            tier,
            tier_texto: tierTexto || null,
            numero: datos?.display_phone_number ?? null,
        };
    } catch (error) {
        return { leido: false, error: error.message };
    } finally {
        clearTimeout(reloj);
    }
}

/** El número del dueño al que se manda la prueba: el del propio canal del negocio. */
function numeroDelDueno(idNegocio) {
    const n = numeros.listar().numeros.find((x) => Number(x.id_negocio) === Number(idNegocio));
    return n?.numero_e164 ?? null;
}

/** ¿La prueba de esta campaña llegó? Se lee del Ledger, no de una columna nuestra. */
async function pruebaEntregada({ idCampana, transaction = null } = {}) {
    if (!idCampana) return { hecha: false };
    const [fila] = await sequelize.query(
        `SELECT c.prueba_en, m.estado_entrega, m.crudo->'acuse'->>'code' AS codigo_error
           FROM platform.campana c
           LEFT JOIN intelligence.mensaje m ON m.id_mensaje = c.id_mensaje_prueba
          WHERE c.id_campana = :idCampana
          LIMIT 1;`,
        { replacements: { idCampana }, ...SELECT, transaction }
    );
    if (!fila?.prueba_en) return { hecha: false };
    return {
        hecha: true,
        estado: fila.estado_entrega,
        // 'sent', 'delivered' y 'read' valen: Meta la aceptó y salió. 'pendiente' es que todavía
        // no ha salido, y 'fallido' es la información más valiosa de toda esta compuerta.
        entregada: ['entregado', 'sent', 'delivered', 'read'].includes(String(fila.estado_entrega)),
        codigo_error: fila.codigo_error ?? null,
    };
}

/**
 * La respuesta completa.
 *
 * @param {Object} opciones
 * @param {string} [opciones.idCampana] — para comprobar su prueba. Sin ella se evalúa todo lo
 *        demás, que es lo que necesita la pantalla antes de que exista la campaña.
 * @param {number} [opciones.destinatarios] — cuántos se piensa mandar, para el aviso del tier.
 * @returns {Promise<{puede: boolean, motivos: Object[], avisos: Object[], numero: Object}>}
 */
async function verificar({
    idNegocio,
    idCampana = null,
    destinatarios = null,
    ahora = new Date(),
    fetchImpl = globalThis.fetch,
} = {}) {
    const motivos = [];
    const avisos = [];

    // ── 1. El plan ──────────────────────────────────────────────────────────────────────
    const conPlan = await planHelper.tienePlanActivo(idNegocio).catch(() => false);
    if (!conPlan) {
        motivos.push(motivo('PROMOS_SIN_PLAN', 'El negocio no tiene un plan activo.'));
    }

    // ── 2. El canal, y que sea SUYO ─────────────────────────────────────────────────────
    await numeros.asegurarCargado();
    let canal = null;
    try {
        canal = plantillasMeta.canalDe(idNegocio);
    } catch (error) {
        motivos.push(motivo(error.code, error.message));
    }
    if (canal?.deLaPlataforma) {
        // No bloquea —es la excepción deliberada de `plantillasMeta.canalDe`— pero se dice en voz
        // alta: lo que salga de aquí lo paga EscalApp y gasta la calificación del número que
        // comparten todos los inquilinos de alta manual.
        avisos.push(
            motivo(
                'PROMOS_CANAL_DE_ESCALAPP',
                'Esta promoción sale por el número de WhatsApp de EscalApp: el costo de Meta lo '
                + 'paga EscalApp y la calificación que se gasta es la de ese número.',
                { bloquea: false },
            )
        );
    }

    // ── 3. La plantilla ─────────────────────────────────────────────────────────────────
    let plantillas = [];
    if (canal) {
        plantillas = await plantillasMeta.estadoDe({ idNegocio }).catch(() => []);
        if (!plantillas.some((p) => p.usable)) {
            const rechazada = plantillas.find((p) => p.estado === 'REJECTED');
            motivos.push(
                motivo(
                    'PROMOS_SIN_PLANTILLA',
                    rechazada
                        ? `Meta rechazó la plantilla: ${rechazada.motivo_rechazo || 'sin motivo'}.`
                        : 'Todavía no hay una plantilla aprobada por Meta para este negocio.',
                    { dato: plantillas },
                )
            );
        }
    }

    // ── 4. La calidad del número y el tier ──────────────────────────────────────────────
    const numero = canal ? await estadoDelNumero({ idNegocio, fetchImpl }) : { leido: false };
    if (numero.leido) {
        if (CALIDAD_QUE_BLOQUEA.has(String(numero.calidad).toUpperCase())) {
            motivos.push(
                motivo(
                    'PROMOS_CALIDAD_ROJA',
                    'La calificación del número está en rojo. Una promoción ahora puede costarle '
                    + 'el número al negocio: hay que esperar a que suba.',
                    { dato: numero.calidad },
                )
            );
        } else if (String(numero.calidad).toUpperCase() === 'YELLOW') {
            avisos.push(
                motivo(
                    'PROMOS_CALIDAD_AMARILLA',
                    'La calificación del número está en amarillo. Conviene mandar a poca gente y '
                    + 'mirar cómo responde.',
                    { bloquea: false, dato: numero.calidad },
                )
            );
        }

        const tier = numero.tier ?? TIER_SIN_VERIFICAR;
        if (destinatarios && Number.isFinite(tier) && destinatarios > tier) {
            avisos.push(
                motivo(
                    'PROMOS_TIER_INSUFICIENTE',
                    `WhatsApp deja alcanzar ${tier.toLocaleString('es-CO')} personas nuevas cada `
                    + `24 horas, y la campaña tiene ${destinatarios.toLocaleString('es-CO')}. Se `
                    + 'manda en varios días, empezando por los primeros.',
                    { bloquea: false, dato: { tier, destinatarios } },
                )
            );
        }
    } else if (canal) {
        avisos.push(
            motivo(
                'PROMOS_NUMERO_NO_LEIDO',
                'No se pudo consultar el estado del número en Meta. El envío se puede intentar, '
                + 'pero sin saber cómo está su calificación.',
                { bloquea: false, dato: numero.error ?? null },
            )
        );
    }

    // ── 5. Los destinatarios ────────────────────────────────────────────────────────────
    const resumen = await audiencia.resumenDeAudiencia({ idNegocio }).catch(() => null);
    if (resumen && resumen.contactables === 0) {
        motivos.push(
            motivo(
                'PROMOS_SIN_CONTACTABLES',
                'No hay ningún cliente al que escribirle: o no tienen teléfono, o pidieron no '
                + 'recibir promociones.',
            )
        );
    }

    // ── 6. La prueba al dueño ───────────────────────────────────────────────────────────
    const prueba = await pruebaEntregada({ idCampana });
    if (idCampana) {
        if (!prueba.hecha) {
            motivos.push(
                motivo(
                    'PROMOS_SIN_PRUEBA',
                    'Antes de enviar hay que mandar la prueba al WhatsApp del negocio y ver que '
                    + 'llega.',
                )
            );
        } else if (!prueba.entregada) {
            motivos.push(
                motivo(
                    'PROMOS_PRUEBA_FALLIDA',
                    prueba.codigo_error === '131042'
                        ? 'La prueba no llegó porque la cuenta de WhatsApp del negocio no tiene un '
                          + 'método de pago. Hay que añadirlo en Meta antes de enviar.'
                        : `La prueba no llegó (${prueba.estado}${prueba.codigo_error ? ', código ' + prueba.codigo_error : ''}). `
                          + 'Hay que resolverlo antes de mandarle nada a los clientes.',
                    { dato: prueba },
                )
            );
        }
    }

    // ── 7. El cupo del asistente, que no bloquea pero hay que decirlo ───────────────────
    try {
        const cupo = await cuota.consumoDe(idNegocio);
        if (cupo && destinatarios) {
            // ~9,1 mensajes por conversación que vuelve, con un 10 % de respuesta supuesto.
            const estimado = Math.round(destinatarios * 0.1 * 9.1);
            if (estimado > cupo.restantes) {
                avisos.push(
                    motivo(
                        'PROMOS_CUPO_JUSTO',
                        `Si contestan, el asistente gastaría unos ${estimado.toLocaleString('es-CO')} `
                        + `mensajes y le quedan ${cupo.restantes.toLocaleString('es-CO')}. Puede `
                        + 'quedarse corto justo cuando lleguen los pedidos.',
                        { bloquea: false, dato: { estimado, restantes: cupo.restantes } },
                    )
                );
            }
        }
    } catch {
        // Sin cupo legible no se avisa de nada: el aviso es una mejora, no un requisito.
    }

    // ── 8. El horario ───────────────────────────────────────────────────────────────────
    const hora = ahora.getHours();
    if (hora < HORA_MIN || hora >= HORA_MAX) {
        avisos.push(
            motivo(
                'PROMOS_FUERA_DE_HORARIO',
                `Son las ${String(hora).padStart(2, '0')}:00. Las promociones salen entre las `
                + `${HORA_MIN}:00 y las ${HORA_MAX}:00; si se envía ahora, se empieza a mandar a `
                + 'primera hora.',
                { bloquea: false },
            )
        );
    }

    return {
        puede: motivos.length === 0,
        motivos,
        avisos,
        numero: {
            telefono: numeroDelDueno(idNegocio),
            calidad: numero.calidad ?? null,
            tier: numero.tier === Infinity ? null : (numero.tier ?? null),
            tier_texto: numero.tier_texto ?? null,
            ilimitado: numero.tier === Infinity,
        },
        plantillas,
        prueba,
        horario: { min: HORA_MIN, max: HORA_MAX, dentro: hora >= HORA_MIN && hora < HORA_MAX },
    };
}

module.exports = {
    HORA_MIN,
    HORA_MAX,
    TIER_SIN_VERIFICAR,
    CALIDAD_QUE_BLOQUEA,
    estadoDelNumero,
    numeroDelDueno,
    pruebaEntregada,
    verificar,
};
