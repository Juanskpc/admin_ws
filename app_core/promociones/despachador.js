/**
 * El despachador: saca las promociones con ritmo (F2).
 *
 * ## Ritmo, no ráfaga — y las tres razones
 *
 * 1. **El tier de mensajería de Meta.** Lo que manda no son los 80 mensajes/segundo que aguanta la
 *    Cloud API, es a cuánta **gente nueva** deja escribirle en 24 h: sin verificación de empresa
 *    son **250**. Una campaña de 400 se manda en dos días, y eso no es un fallo: es el límite. Lo
 *    que sería un fallo es intentarlo entero, que Meta rechace la mitad y que el dueño crea que
 *    salió.
 * 2. **La cocina.** 400 mensajes de golpe pueden traer cien pedidos en una hora a un negocio que
 *    no avisó a nadie.
 * 3. **La calidad del número.** Los bloqueos se ven en minutos; mandando despacio hay tiempo de
 *    frenar antes de perder el número.
 *
 * ## Una transacción por destinatario, y el lock dentro
 *
 * Igual que `intelligence/recordatorios`: se reclama **dentro** de la transacción que hace el
 * trabajo. La tentación es pedir el lote entero en una transacción corta y luego procesarlo — eso
 * confirma, suelta los locks, y el `SKIP LOCKED` deja de proteger de nada. *Un lock que no dura
 * tanto como el trabajo que protege no es un lock.*
 *
 * ## Lo que vuelve a comprobar en el último momento
 *
 * La baja. Entre que el dueño aprieta «enviar» y sale el mensaje número 400 pueden pasar horas, y
 * en esas horas alguien puede haberse dado de baja. Un filtro aplicado solo al armar la campaña es
 * un mensaje que sale **después** de la baja, y eso es exactamente lo que no se puede permitir.
 *
 * ## Qué NO hace
 *
 * No habla con la Cloud API. Materializa el mensaje en `intelligence.mensaje` y lo manda el
 * entregador de siempre, que ya sabe de números por inquilino, reintentos y acuses. Ver la
 * cabecera de `campanas.js`.
 */
'use strict';

const Models = require('../models/conection');
const audiencia = require('./audiencia');
const campanas = require('./campanas');
const elegibilidad = require('./elegibilidad');
const habilitado = require('./habilitado');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };

const CONFIG = {
    /** Cada cuánto mira si hay algo que mandar. */
    intervaloMs: Number(process.env.PROMOS_POLL_MS) || 15000,
    /** Cuántos mensajes como máximo por pase y por campaña. */
    lote: Number(process.env.PROMOS_LOTE) || 20,
    /** Cada cuánto se vuelve a preguntar a Meta por la calidad del número. */
    calidadCadaMs: Number(process.env.PROMOS_CALIDAD_MS) || 15 * 60 * 1000,
};

/** id_campana → epoch de la última comprobación de calidad. */
const calidadRevisadaEn = new Map();
let temporizador = null;
let drenando = false;

/** ¿Estamos dentro de la franja en la que se puede mandar? Hora de pared de Bogotá. */
function dentroDeHorario(ahora = new Date()) {
    const hora = ahora.getHours();
    return hora >= elegibilidad.HORA_MIN && hora < elegibilidad.HORA_MAX;
}

/**
 * Cuántos mensajes de promoción ha sacado este negocio en las últimas 24 h.
 *
 * Es lo que se compara contra el tier. Se cuenta sobre `campana_destinatario.encolado_en` y no
 * sobre `intelligence.mensaje`, porque lo que Meta limita es **a cuánta gente** se le escribe, y
 * aquí una persona es una fila.
 */
async function encoladosUltimas24h({ idNegocio, transaction = null } = {}) {
    const [fila] = await sequelize.query(
        `SELECT COUNT(*)::int AS n
           FROM platform.campana_destinatario cd
           JOIN platform.campana c ON c.id_campana = cd.id_campana
          WHERE c.id_negocio = :idNegocio
            AND cd.estado = 'ENCOLADO'
            AND cd.encolado_en > now() - interval '24 hours';`,
        { replacements: { idNegocio: Number(idNegocio) }, ...SELECT, transaction }
    );
    return Number(fila?.n || 0);
}

/** Las campañas que toca mover ahora. */
async function campanasEnCurso() {
    return sequelize.query(
        `SELECT id_campana, id_negocio, plantilla, parametros, imagen_url, destinatarios, estado
           FROM platform.campana
          WHERE estado = 'ENVIANDO'
             OR (estado = 'PROGRAMADA' AND programada_para IS NOT NULL
                 AND programada_para <= CURRENT_TIMESTAMP)
          ORDER BY enviando_desde NULLS FIRST
          LIMIT 20;`,
        SELECT
    );
}

async function marcarEstado(idCampana, estado, { motivo = null, terminada = false } = {}) {
    await sequelize.query(
        `UPDATE platform.campana
            SET estado = :estado,
                motivo_corte = :motivo,
                enviando_desde = COALESCE(enviando_desde, CASE WHEN :estado = 'ENVIANDO' THEN now() END),
                terminada_en = CASE WHEN :terminada THEN now() ELSE terminada_en END,
                actualizado_en = now()
          WHERE id_campana = :idCampana;`,
        { replacements: { idCampana, estado, motivo, terminada } }
    );
}

/**
 * Frena la campaña si la calidad del número cayó a rojo mientras se mandaba.
 *
 * Se pregunta como mucho cada `calidadCadaMs` porque es una llamada a Meta por campaña: hacerlo en
 * cada pase convertiría el freno en el gasto. Devuelve `true` si se pausó.
 */
async function pausarSiCalidadCayo({ idCampana, idNegocio }) {
    const ultima = calidadRevisadaEn.get(idCampana) ?? 0;
    if (Date.now() - ultima < CONFIG.calidadCadaMs) return false;
    calidadRevisadaEn.set(idCampana, Date.now());

    const estado = await elegibilidad.estadoDelNumero({ idNegocio });
    // Si no se pudo leer, NO se pausa: dejar a medias una campaña por un fallo de red sería peor
    // que seguir — y la calidad se volverá a mirar en el siguiente pase.
    if (!estado.leido) return false;

    if (elegibilidad.CALIDAD_QUE_BLOQUEA.has(String(estado.calidad).toUpperCase())) {
        await marcarEstado(idCampana, 'PAUSADA', {
            motivo: 'La calificación del número cayó a rojo durante el envío.',
        });
        console.warn(
            `[promociones] campaña ${idCampana} pausada: calidad ${estado.calidad} del número del `
            + `negocio ${idNegocio}.`
        );
        return true;
    }
    return false;
}

/**
 * Un pase sobre una campaña. Devuelve cuántos encoló y por qué paró.
 */
async function drenarCampana(campana, { ahora = new Date() } = {}) {
    const resumen = { encolados: 0, omitidos: 0, corte: null };

    // La lista blanca, otra vez y aquí. Apagarle la función a un negocio tiene que parar lo que
    // ya está saliendo, no solo esconderle la pantalla: entre que se crea una campaña y sale el
    // último mensaje pueden pasar días, y es exactamente en esos días cuando se decide apagarla.
    if (!(await habilitado.estaHabilitado(campana.id_negocio))) {
        await marcarEstado(campana.id_campana, 'PAUSADA', {
            motivo: 'Las promociones masivas dejaron de estar habilitadas para este negocio.',
        });
        resumen.corte = 'no_habilitado';
        return resumen;
    }

    if (campana.estado === 'PROGRAMADA') await marcarEstado(campana.id_campana, 'ENVIANDO');

    if (await pausarSiCalidadCayo(campana)) {
        resumen.corte = 'calidad_roja';
        return resumen;
    }

    // El presupuesto de las próximas 24 h: lo que deja el tier menos lo ya gastado.
    const estadoNumero = await elegibilidad.estadoDelNumero({ idNegocio: campana.id_negocio });
    const tier = estadoNumero.leido
        ? (estadoNumero.tier ?? elegibilidad.TIER_SIN_VERIFICAR)
        : elegibilidad.TIER_SIN_VERIFICAR;
    const gastados = await encoladosUltimas24h({ idNegocio: campana.id_negocio });
    const presupuesto = Number.isFinite(tier) ? Math.max(0, tier - gastados) : Infinity;

    if (presupuesto <= 0) {
        resumen.corte = 'tier_agotado';
        return resumen;
    }

    const tope = Math.min(CONFIG.lote, presupuesto);

    for (let i = 0; i < tope; i++) {
        const t = await sequelize.transaction();
        try {
            const [destinatario] = await sequelize.query(
                `SELECT id_campana_destinatario, id_persona_negocio, telefono_e164
                   FROM platform.campana_destinatario
                  WHERE id_campana = :idCampana AND estado = 'PENDIENTE'
                  ORDER BY creado_en
                  LIMIT 1
                    FOR UPDATE SKIP LOCKED;`,
                { replacements: { idCampana: campana.id_campana }, ...SELECT, transaction: t }
            );

            if (!destinatario) {
                await t.rollback();
                resumen.corte = resumen.corte ?? 'sin_pendientes';
                break;
            }

            // La última comprobación, y la que más importa: ¿sigue queriendo recibir?
            const contactable = await audiencia.esContactable({
                idNegocio: campana.id_negocio,
                idPersonaNegocio: destinatario.id_persona_negocio,
                transaction: t,
            });

            if (!contactable) {
                await sequelize.query(
                    `UPDATE platform.campana_destinatario
                        SET estado = 'OMITIDO', motivo_omision = 'se_dio_de_baja'
                      WHERE id_campana_destinatario = :id;`,
                    { replacements: { id: destinatario.id_campana_destinatario }, transaction: t }
                );
                resumen.omitidos++;
                await t.commit();
                continue;
            }

            const { bloqueada, idMensaje } = await campanas.materializar(
                {
                    idNegocio: campana.id_negocio,
                    telefono: destinatario.telefono_e164,
                    plantilla: campana.plantilla,
                    parametros: campana.parametros,
                    imagenUrl: campana.imagen_url,
                },
                { transaction: t }
            );

            if (bloqueada) {
                await sequelize.query(
                    `UPDATE platform.campana_destinatario
                        SET estado = 'OMITIDO', motivo_omision = 'bloqueo_whatsapp'
                      WHERE id_campana_destinatario = :id;`,
                    { replacements: { id: destinatario.id_campana_destinatario }, transaction: t }
                );
                resumen.omitidos++;
                await t.commit();
                continue;
            }

            await sequelize.query(
                `UPDATE platform.campana_destinatario
                    SET estado = 'ENCOLADO',
                        id_mensaje = :idMensaje,
                        encolado_en = now(),
                        credito_cobrado = true
                  WHERE id_campana_destinatario = :id;`,
                {
                    replacements: { id: destinatario.id_campana_destinatario, idMensaje },
                    transaction: t,
                }
            );
            resumen.encolados++;
            await t.commit();
        } catch (error) {
            await t.rollback().catch(() => null);
            // Un destinatario que falla no puede llevarse la campaña por delante: se registra y
            // se sigue. Si el fallo es de los que afectan a todos (la plantilla no existe en la
            // WABA), lo verá el informe con todos los mensajes en `fallido` y su código.
            console.error(
                `[promociones] error encolando en la campaña ${campana.id_campana}:`,
                error.message
            );
            resumen.corte = 'error';
            break;
        }
    }

    // ¿Terminó? Solo cuando no queda ni un pendiente.
    const [quedan] = await sequelize.query(
        `SELECT COUNT(*)::int AS n FROM platform.campana_destinatario
          WHERE id_campana = :idCampana AND estado = 'PENDIENTE';`,
        { replacements: { idCampana: campana.id_campana }, ...SELECT }
    );
    if (Number(quedan?.n || 0) === 0) {
        await marcarEstado(campana.id_campana, 'ENVIADA', { terminada: true });
        calidadRevisadaEn.delete(campana.id_campana);
        resumen.corte = 'terminada';
    }

    return resumen;
}

/**
 * Devuelve los créditos de lo que Meta no entregó.
 *
 * Es lo que hace que «1 crédito = 1 mensaje entregado» sea verdad y no una frase. Se mira contra
 * el Ledger, que es quien sabe si el mensaje salió: `estado_entrega = 'fallido'` es un mensaje que
 * dimos por bueno y que nadie recibió — el número no tiene WhatsApp, el cliente nos bloqueó, o
 * Meta aplicó su tope de marketing por usuario (`131049`), que no es culpa de nadie.
 *
 * Idempotente: solo toca las filas con el crédito cobrado y sin devolver.
 */
async function devolverCreditosFallidos({ limite = 200 } = {}) {
    const [, meta] = await sequelize.query(
        `UPDATE platform.campana_destinatario cd
            SET credito_cobrado = false,
                credito_devuelto_en = now()
          WHERE cd.id_campana_destinatario IN (
              SELECT c2.id_campana_destinatario
                FROM platform.campana_destinatario c2
                JOIN intelligence.mensaje m ON m.id_mensaje = c2.id_mensaje
               WHERE c2.credito_cobrado
                 AND c2.credito_devuelto_en IS NULL
                 AND m.estado_entrega = 'fallido'
               LIMIT :limite
          );`,
        { replacements: { limite } }
    );
    return meta?.rowCount ?? 0;
}

async function drenarUnaVez({ ahora = new Date() } = {}) {
    const resumen = { campanas: 0, encolados: 0, omitidos: 0, creditos_devueltos: 0 };

    // Lo primero, y se hace siempre: devolver lo que no se entregó no depende del horario.
    resumen.creditos_devueltos = await devolverCreditosFallidos();

    if (!dentroDeHorario(ahora)) return resumen;

    const enCurso = await campanasEnCurso();
    for (const campana of enCurso) {
        resumen.campanas++;
        const r = await drenarCampana(campana, { ahora });
        resumen.encolados += r.encolados;
        resumen.omitidos += r.omitidos;
    }
    return resumen;
}

async function tick() {
    if (drenando) return;
    drenando = true;
    try {
        const r = await drenarUnaVez();
        if (r.encolados || r.omitidos || r.creditos_devueltos) {
            console.log(
                `[promociones] ${r.encolados} encolados, ${r.omitidos} omitidos, `
                + `${r.creditos_devueltos} créditos devueltos.`
            );
        }
    } catch (error) {
        console.error('[promociones] error despachando:', error.message);
    } finally {
        drenando = false;
    }
}

function iniciar() {
    if (temporizador) return;
    temporizador = setInterval(tick, CONFIG.intervaloMs);
    temporizador.unref?.();
    console.log(
        `[promociones] Despachador iniciado — sondeo cada ${CONFIG.intervaloMs}ms, lote `
        + `${CONFIG.lote}, franja ${elegibilidad.HORA_MIN}:00–${elegibilidad.HORA_MAX}:00.`
    );
}

function detener() {
    if (temporizador) {
        clearInterval(temporizador);
        temporizador = null;
    }
}

module.exports = {
    CONFIG,
    dentroDeHorario,
    encoladosUltimas24h,
    drenarCampana,
    devolverCreditosFallidos,
    drenarUnaVez,
    tick,
    iniciar,
    detener,
};
