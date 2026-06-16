/**
 * Migración: branding de tipo de negocio
 *
 * Añade a general.gener_tipo_negocio:
 *   icono     VARCHAR(50)  → nombre del ícono (lucide) que representa el tipo
 *   color_hex VARCHAR(20)  → color de acento del tipo (ej. #8B5CF6)
 *
 * Idempotente. Ejecutar con: npm run migrate:tipo-negocio-branding
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: branding de tipo de negocio (icono, color_hex)\n');

        await sequelize.query(
            `ALTER TABLE general.gener_tipo_negocio
                ADD COLUMN IF NOT EXISTS icono VARCHAR(50);`,
            { transaction: t },
        );
        await sequelize.query(
            `ALTER TABLE general.gener_tipo_negocio
                ADD COLUMN IF NOT EXISTS color_hex VARCHAR(20);`,
            { transaction: t },
        );

        await t.commit();
        console.log('✓ Columnas icono y color_hex añadidas a gener_tipo_negocio.');
    } catch (err) {
        await t.rollback();
        console.error('\n✗ Error en migración:', err.message);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
