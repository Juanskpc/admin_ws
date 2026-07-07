/**
 * Migración: soporte de imágenes en la carta.
 *  - Agrega columna imagen_url a restaurante.carta_categoria.
 *  - Garantiza imagen_url en restaurante.carta_producto (defensivo para BD antiguas).
 *
 * La imagen es OPCIONAL: convive con el ícono existente y solo se muestra
 * por encima de él cuando está presente.
 *
 * Idempotente. npm run migrate:restaurante-imagenes
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function agregarColumnaImagen(t, tabla) {
    const [existing] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'restaurante' AND table_name = :tabla
          AND column_name = 'imagen_url';
    `, { transaction: t, replacements: { tabla } });

    if (existing.length === 0) {
        await sequelize.query(`
            ALTER TABLE restaurante.${tabla}
            ADD COLUMN imagen_url VARCHAR(500);
        `, { transaction: t });
        console.log(`   Columna imagen_url creada en ${tabla}.`);
    } else {
        console.log(`   ${tabla}.imagen_url ya existe, omitiendo.`);
    }
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - Imágenes de carta\n');

        console.log('1. carta_categoria...');
        await agregarColumnaImagen(t, 'carta_categoria');

        console.log('\n2. carta_producto...');
        await agregarColumnaImagen(t, 'carta_producto');

        await t.commit();
        console.log('\n✓ Migración de imágenes de carta completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
