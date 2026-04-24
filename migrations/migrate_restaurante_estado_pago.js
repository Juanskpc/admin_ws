/**
 * Migración: estado_pago en pedid_orden.
 *  - Agrega columna estado_pago (pendiente_pago | pagado).
 *  - Backfill: órdenes CERRADAS → pagado.
 *
 * Idempotente. npm run migrate:restaurante-estado-pago
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - Estado de pago\n');

        // 1. Columna estado_pago
        console.log('1. Agregando columna estado_pago a pedid_orden...');
        const [existing] = await sequelize.query(`
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'restaurante' AND table_name = 'pedid_orden'
              AND column_name = 'estado_pago';
        `, { transaction: t });

        if (existing.length === 0) {
            await sequelize.query(`
                ALTER TABLE restaurante.pedid_orden
                ADD COLUMN estado_pago VARCHAR(20) NOT NULL DEFAULT 'pendiente_pago'
                CHECK (estado_pago IN ('pendiente_pago', 'pagado'));
            `, { transaction: t });
            console.log('   Columna creada.\n');
        } else {
            console.log('   Ya existe, omitiendo.\n');
        }

        // 2. Backfill: órdenes cerradas = pagado
        console.log('2. Backfill: órdenes CERRADAS → pagado...');
        const [result] = await sequelize.query(`
            UPDATE restaurante.pedid_orden
               SET estado_pago = 'pagado'
             WHERE estado = 'CERRADA' AND estado_pago = 'pendiente_pago';
        `, { transaction: t });
        console.log(`   OK (${result.rowCount ?? 0} filas actualizadas)\n`);

        await t.commit();
        console.log('✓ Migración estado_pago completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
