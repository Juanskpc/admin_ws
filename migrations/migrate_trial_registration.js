/**
 * Migración: Soporte para registro de prueba (Trial Registration)
 *
 * Cambios:
 * 1. general.gener_usuario        → columna debe_cambiar_password
 * 2. general.gener_codigo_verificacion → columnas nombre_completo, num_identificacion_reg, tipo_negocio
 *
 * Idempotente. Ejecutar con: npm run migrate:trial-registration
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: trial-registration\n');

        await sequelize.query(`
            ALTER TABLE general.gener_usuario
            ADD COLUMN IF NOT EXISTS debe_cambiar_password BOOLEAN NOT NULL DEFAULT FALSE;
        `, { transaction: t });
        console.log('   ✓ Columna debe_cambiar_password en general.gener_usuario');

        await sequelize.query(`
            ALTER TABLE general.gener_codigo_verificacion
            ADD COLUMN IF NOT EXISTS nombre_completo       VARCHAR(255),
            ADD COLUMN IF NOT EXISTS num_identificacion_reg VARCHAR(50),
            ADD COLUMN IF NOT EXISTS tipo_negocio          VARCHAR(50);
        `, { transaction: t });
        console.log('   ✓ Columnas nombre_completo / num_identificacion_reg / tipo_negocio en general.gener_codigo_verificacion');

        await t.commit();
        console.log('\n✓ Migración trial-registration completada exitosamente.');
    } catch (err) {
        await t.rollback();
        console.error('\n✗ Error en migración:', err.message);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
