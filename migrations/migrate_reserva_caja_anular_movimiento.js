/**
 * Anular movimientos de caja en vez de borrarlos (vertical `reserva`).
 *
 * Hasta ahora `caja_eliminar` hacía un `DELETE` de verdad: el movimiento desaparecía de
 * `reserva_movimiento_caja` y con él la trazabilidad de qué pasó en ese turno — solo quedaba el
 * evento de auditoría, que nadie mira desde la pantalla de caja. Este cambio añade un estado de
 * anulación a la fila: el movimiento se queda en la tabla (se sigue viendo en «Movimientos del
 * turno», tachado), pero deja de sumar en `getTotales`, `getDesglosePorMetodo` y
 * `getResumenPorProfesional`.
 *
 * Añade a `reserva.reserva_movimiento_caja`:
 *   - `anulado`          BOOLEAN — si el movimiento se anuló
 *   - `fecha_anulado`    TIMESTAMP — cuándo
 *   - `id_usuario_anulo` INTEGER  — quién
 *
 * Idempotente: `IF NOT EXISTS` / consulta a `information_schema` antes de cada `ALTER`, una sola
 * transacción.
 *
 *   npm run migrate:reserva-caja-anular
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

async function columnaExiste(tabla, columna, t) {
    const [filas] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'reserva' AND table_name = :tabla AND column_name = :columna;
    `, { replacements: { tabla, columna }, transaction: t });
    return filas.length > 0;
}

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: anular movimientos de caja (reserva) ===\n');

        if (!await columnaExiste('reserva_movimiento_caja', 'anulado', t)) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_movimiento_caja
                ADD COLUMN anulado BOOLEAN NOT NULL DEFAULT false;
            `, { transaction: t });
            console.log('   + reserva_movimiento_caja.anulado');
        }

        if (!await columnaExiste('reserva_movimiento_caja', 'fecha_anulado', t)) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_movimiento_caja
                ADD COLUMN fecha_anulado TIMESTAMP;
            `, { transaction: t });
            console.log('   + reserva_movimiento_caja.fecha_anulado');
        }

        if (!await columnaExiste('reserva_movimiento_caja', 'id_usuario_anulo', t)) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_movimiento_caja
                ADD COLUMN id_usuario_anulo INTEGER REFERENCES general.gener_usuario(id_usuario);
            `, { transaction: t });
            console.log('   + reserva_movimiento_caja.id_usuario_anulo');
        }

        console.log('\nOK\n');
        await t.commit();

        const cols = await sequelize.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'reserva' AND table_name = 'reserva_movimiento_caja'
              AND column_name IN ('anulado', 'fecha_anulado', 'id_usuario_anulo')
            ORDER BY column_name;
        `, { type: sequelize.QueryTypes.SELECT });

        console.log('=== Resultado ===');
        cols.forEach(c => console.log(`   Columna: reserva_movimiento_caja.${c.column_name}`));
        console.log('\nMigración completada.\n');
    } catch (err) {
        await t.rollback();
        console.error('\nERROR — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
