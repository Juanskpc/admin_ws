/**
 * DAO del outbox transaccional (ADR-012).
 *
 * Es la única forma en que una vertical emite un evento de dominio. La vertical no conoce
 * a los consumidores, ni sabe si la IA existe: escribe en `platform` y se olvida.
 *
 * El contrato de los eventos (nombres, payloads, versiones) lo gobierna ADR-013 y vive en
 * `docs/architecture/domain-events.md`.
 */
const db = require('../models/conection');

const sequelize = db.sequelize;

/** Espejo de chk_outbox_tipo. Se valida aquí para fallar con un mensaje útil, no con un 23514. */
const PATRON_TIPO = /^[a-z_]+\.[a-z_]+\.v[0-9]+$/;

/**
 * Escribe un evento en el outbox, dentro de la transacción de quien lo emite.
 *
 * **La transacción es obligatoria.** Emitir fuera de una transacción reintroduce exactamente
 * el problema que este patrón resuelve: el evento podría existir sin que la mutación de
 * dominio confirmara, o al revés. Un `emitir()` sin transacción es siempre un error de uso,
 * así que se rechaza en vez de "funcionar" mal.
 *
 * @param {Object} evento
 * @param {string} evento.tipo        — `<agregado>.<hecho_pasado>.v<n>` (ADR-013).
 * @param {number} evento.idNegocio   — scoping multi-inquilino; siempre presente.
 * @param {Object} [evento.payload]   — identificadores y el hecho. NO una copia del estado.
 * @param {Date}   [evento.ocurridoEn]— por defecto, ahora.
 * @param {Object} opciones
 * @param {Object} opciones.transaction
 * @returns {Promise<string>} id_evento
 */
async function emitir({ tipo, idNegocio, payload = {}, ocurridoEn = null }, { transaction } = {}) {
    if (!transaction) {
        throw new Error(
            'outboxDao.emitir requiere una transacción: la atomicidad entre el cambio de ' +
                'dominio y su evento es el propósito del patrón outbox (ADR-012).'
        );
    }
    if (!PATRON_TIPO.test(String(tipo || ''))) {
        throw new Error(
            `Tipo de evento inválido: "${tipo}". La convención (ADR-013) es ` +
                '<agregado>.<hecho_pasado>.v<n> en español y minúsculas, p. ej. "cita.creada.v1".'
        );
    }
    if (!Number.isInteger(idNegocio) || idNegocio <= 0) {
        throw new Error('outboxDao.emitir requiere un id_negocio entero válido.');
    }

    const [fila] = await sequelize.query(
        `
        INSERT INTO platform.outbox (tipo, id_negocio, payload, ocurrido_en)
        VALUES (:tipo, :idNegocio, CAST(:payload AS jsonb), COALESCE(CAST(:ocurridoEn AS timestamptz), now()))
        RETURNING id_evento;
        `,
        {
            replacements: {
                tipo,
                idNegocio,
                payload: JSON.stringify(payload ?? {}),
                ocurridoEn: ocurridoEn ? new Date(ocurridoEn).toISOString() : null,
            },
            type: sequelize.QueryTypes.SELECT,
            transaction,
        }
    );

    return fila.id_evento;
}

/**
 * Reclama un lote de eventos pendientes para entregarlos.
 *
 * `FOR UPDATE SKIP LOCKED` permite que varias instancias del relay compitan por la misma
 * tabla sin bloquearse ni entregar dos veces el mismo evento a la vez. Es lo que hace que
 * el relay pueda correr en más de un proceso el día que haga falta, sin cambiar nada.
 *
 * Debe llamarse dentro de una transacción, que es la que sostiene los locks.
 */
async function reclamarPendientes(limite, { transaction }) {
    const [filas] = await sequelize.query(
        `
        SELECT id_evento, tipo, id_negocio, ocurrido_en, payload, intentos
          FROM platform.outbox
         WHERE estado = 'pendiente'
           AND proximo_intento_en <= now()
         ORDER BY proximo_intento_en, id_evento
         LIMIT :limite
           FOR UPDATE SKIP LOCKED;
        `,
        { replacements: { limite }, transaction }
    );
    return filas;
}

async function marcarEntregado(idEvento, { transaction }) {
    await sequelize.query(
        `
        UPDATE platform.outbox
           SET estado = 'entregado', entregado_en = now(), ultimo_error = NULL
         WHERE id_evento = :idEvento;
        `,
        { replacements: { idEvento }, transaction }
    );
}

/**
 * Reprograma un evento que falló, o lo manda a dead letter si agotó los reintentos.
 * Backoff exponencial acotado: 2^intentos segundos, con techo.
 */
async function marcarFallo(idEvento, mensaje, { intentos, maxIntentos, backoffMaxSegundos, transaction }) {
    const agotado = intentos + 1 >= maxIntentos;
    const esperaSegundos = Math.min(2 ** (intentos + 1), backoffMaxSegundos);

    await sequelize.query(
        `
        UPDATE platform.outbox
           SET estado             = :estado,
               intentos           = intentos + 1,
               ultimo_error       = :mensaje,
               proximo_intento_en = now() + (:espera || ' seconds')::interval
         WHERE id_evento = :idEvento;
        `,
        {
            replacements: {
                idEvento,
                estado: agotado ? 'fallido' : 'pendiente',
                mensaje: String(mensaje ?? '').slice(0, 2000),
                espera: String(esperaSegundos),
            },
            transaction,
        }
    );

    return { agotado, esperaSegundos };
}

module.exports = { emitir, reclamarPendientes, marcarEntregado, marcarFallo };
