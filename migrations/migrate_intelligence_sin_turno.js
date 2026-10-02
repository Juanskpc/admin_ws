/**
 * Migración: mensajes entrantes que el asistente NO debe contestar nunca.
 *
 *  - intelligence.mensaje.sin_turno_motivo   varchar(30) NULL
 *
 * NULL = el motor lo atiende como siempre. Con valor, el mensaje queda guardado (la Bandeja lo
 * muestra) pero no es «pendiente»: ningún turno lo recoge, ni al volver la conversación al
 * asistente ni al reiniciar el proceso. Valores:
 *
 *   · `handoff_humano` (o el estado que tuviera: `bloqueada`, …) — llegó mientras una persona
 *     atendía. Esa persona lo vio y lo contestó desde su teléfono o la Bandeja.
 *   · `humano` — llegó antes de que una persona interviniera en la conversación.
 *   · `antiguo` — Meta lo entregó con mucho retraso (lo de la cola de la app al conectar un
 *     número por coexistencia).
 *
 * ## Por qué (producción, 2026-10-01, Zona Burger)
 *
 * Los mensajes que llegaban con la conversación en `handoff_humano` se quedaban con
 * `id_turno IS NULL` —«pendientes»— para siempre. Cuando la conversación volvía al asistente (el
 * plazo de reactivación, o el reinicio de las 20:50, que reencoló 11 conversaciones) el bot
 * contestaba de golpe mensajes de hasta una hora antes que el negocio ya había atendido a mano.
 * Y al conectar el número, ~110 mensajes viejos de la app (stickers, fotos) recibieron respuesta
 * del bot; 45 rebotaron con 131047 (más de 24 h).
 *
 * ## Backfill
 *
 * Los entrantes sin turno de conversaciones que HOY no son procesables se marcan con el estado de
 * su conversación, y los que son anteriores a la última intervención humana, con `humano`. Es
 * justo lo que habría hecho el código nuevo si hubiera estado desplegado.
 *
 * Idempotente. Registrada como `npm run migrate:intelligence-sin-turno`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        const SELECT = { type: Models.sequelize.QueryTypes.SELECT, transaction: t };
        const hayTabla = await Models.sequelize.query(
            `SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'intelligence' AND table_name = 'mensaje';`,
            SELECT
        );
        if (hayTabla.length === 0) {
            console.log('El esquema intelligence no está migrado en este entorno: nada que hacer.');
            await t.commit();
            return;
        }

        console.log('1. intelligence.mensaje.sin_turno_motivo ...');
        const [existe] = await Models.sequelize.query(
            `SELECT 1 AS hay FROM information_schema.columns
              WHERE table_schema = 'intelligence' AND table_name = 'mensaje'
                AND column_name = 'sin_turno_motivo';`,
            SELECT
        );
        if (!existe) {
            // Nullable y sin DEFAULT: en una tabla particionada es un cambio de catálogo, no
            // reescribe ninguna partición.
            await Models.sequelize.query(
                `ALTER TABLE intelligence.mensaje ADD COLUMN sin_turno_motivo varchar(30);`,
                { transaction: t }
            );
            console.log('   añadida.');
        } else {
            console.log('   ya existía.');
        }

        console.log('2. backfill de pendientes que nadie debe contestar ...');
        const [, enEstado] = await Models.sequelize.query(
            `UPDATE intelligence.mensaje m
                SET sin_turno_motivo = c.estado
               FROM intelligence.conversacion c
              WHERE c.id_conversacion = m.id_conversacion
                AND m.direccion = 'entrante' AND m.id_turno IS NULL AND m.sin_turno_motivo IS NULL
                AND m.creado_en > now() - interval '30 days'
                AND c.estado NOT IN ('activa', 'dormida');`,
            { transaction: t }
        );
        const [, previos] = await Models.sequelize.query(
            `UPDATE intelligence.mensaje m
                SET sin_turno_motivo = 'humano'
               FROM intelligence.conversacion c
              WHERE c.id_conversacion = m.id_conversacion
                AND m.direccion = 'entrante' AND m.id_turno IS NULL AND m.sin_turno_motivo IS NULL
                AND m.creado_en > now() - interval '30 days'
                AND c.humano_ultimo_en IS NOT NULL AND m.creado_en <= c.humano_ultimo_en;`,
            { transaction: t }
        );
        console.log(`   ${enEstado?.rowCount ?? 0} en conversaciones no procesables, ` +
            `${previos?.rowCount ?? 0} anteriores a una intervención humana.`);

        await t.commit();
        console.log('✓ Migración sin_turno_motivo completada.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló la migración (revertida):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
}

migrate();
