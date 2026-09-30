/**
 * Cobro como «Servicio» o «Asesoría» (2026-09-29).
 *
 * Al completar una cita, el profesional puede marcarla como ASESORÍA: no mueve dinero, pero
 * queda en el historial de la caja como un movimiento de tipo ASESORIA por 0.
 *
 *  - `reserva_cita.tipo_cobro` VARCHAR(10) NOT NULL DEFAULT 'SERVICIO' ('SERVICIO' | 'ASESORIA').
 *  - `reserva_movimiento_caja`: el CHECK de `tipo` admite 'ASESORIA' y el de `monto` admite 0
 *    solo para ella. Los CHECK originales no tienen nombre fijo (los generó Postgres), así que se
 *    buscan en `pg_constraint` por su definición y se reemplazan por unos con nombre.
 *
 * Idempotente. Correr ANTES de desplegar el backend.
 *
 *   npm run migrate:reserva-asesoria
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: cobro como servicio o asesoría ===\n');

        const [[col]] = await sequelize.query(`
            SELECT 1 AS si FROM information_schema.columns
             WHERE table_schema = 'reserva' AND table_name = 'reserva_cita' AND column_name = 'tipo_cobro';
        `, { transaction: t });
        if (!col) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_cita
                  ADD COLUMN tipo_cobro VARCHAR(10) NOT NULL DEFAULT 'SERVICIO'
                  CONSTRAINT chk_cita_tipo_cobro CHECK (tipo_cobro IN ('SERVICIO', 'ASESORIA'));
            `, { transaction: t });
            console.log('· reserva_cita.tipo_cobro creada (SERVICIO por defecto).');
        } else {
            console.log('· reserva_cita.tipo_cobro ya existe.');
        }

        // CHECK viejos de la tabla de movimientos, por su definición.
        const [viejos] = await sequelize.query(`
            SELECT conname, pg_get_constraintdef(oid) AS def
              FROM pg_constraint
             WHERE conrelid = 'reserva.reserva_movimiento_caja'::regclass AND contype = 'c'
               AND conname NOT IN ('chk_mov_caja_tipo', 'chk_mov_caja_monto');
        `, { transaction: t });
        for (const { conname, def } of viejos) {
            if (/\btipo\b/.test(def) || /\bmonto\b/.test(def)) {
                await sequelize.query(
                    `ALTER TABLE reserva.reserva_movimiento_caja DROP CONSTRAINT "${conname}";`,
                    { transaction: t },
                );
                console.log(`· Quitado ${conname}: ${def}`);
            }
        }

        const [nuevos] = await sequelize.query(`
            SELECT conname FROM pg_constraint
             WHERE conrelid = 'reserva.reserva_movimiento_caja'::regclass
               AND conname IN ('chk_mov_caja_tipo', 'chk_mov_caja_monto');
        `, { transaction: t });
        const tiene = new Set(nuevos.map((n) => n.conname));
        if (!tiene.has('chk_mov_caja_tipo')) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_movimiento_caja
                  ADD CONSTRAINT chk_mov_caja_tipo CHECK (tipo IN ('INGRESO', 'EGRESO', 'ASESORIA'));
            `, { transaction: t });
            console.log('· chk_mov_caja_tipo: INGRESO | EGRESO | ASESORIA.');
        }
        if (!tiene.has('chk_mov_caja_monto')) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_movimiento_caja
                  ADD CONSTRAINT chk_mov_caja_monto CHECK (monto > 0 OR (tipo = 'ASESORIA' AND monto = 0));
            `, { transaction: t });
            console.log('· chk_mov_caja_monto: > 0, o 0 solo en ASESORIA.');
        }

        await t.commit();
        console.log('\nListo.\n');
    } catch (err) {
        await t.rollback();
        console.error('\nError, se revirtió todo:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
