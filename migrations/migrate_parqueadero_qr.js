/**
 * Migración: columna qr_token para parqueadero (flujo QR móvil).
 * Idempotente: usa ALTER TABLE ADD COLUMN IF NOT EXISTS.
 *
 * Ejecutar con: node migrations/migrate_parqueadero_qr.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración QR Parqueadero\n');

        console.log('1. Agregando columna qr_token a parqueadero.parq_vehiculo...');
        await sequelize.query(`
            ALTER TABLE parqueadero.parq_vehiculo
            ADD COLUMN IF NOT EXISTS qr_token VARCHAR(64) UNIQUE;
        `, { transaction: t });
        console.log('   OK\n');

        console.log('2. Creando índice para búsqueda por qr_token...');
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_vehiculo_qr_token
            ON parqueadero.parq_vehiculo(qr_token);
        `, { transaction: t });
        console.log('   OK\n');

        await t.commit();
        console.log('✓ Migración QR Parqueadero completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        console.error(error);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
