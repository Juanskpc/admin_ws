/**
 * Migración: Agrega porcion y unidad_medida a carta_producto_ingred
 * Ejecutar con: node migrations/migrate_menu_porcion.js
 *
 * Cambios:
 * 1. Agrega columna porcion DECIMAL(10,3) DEFAULT 0 a restaurante.carta_producto_ingred
 * 2. Agrega columna unidad_medida VARCHAR(20) DEFAULT 'g' a restaurante.carta_producto_ingred
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('Iniciando migración: porcion y unidad_medida...\n');

        // 1. Agregar columna porcion
        console.log('1. Agregando columna porcion...');
        await sequelize.query(`
            ALTER TABLE restaurante.carta_producto_ingred
            ADD COLUMN IF NOT EXISTS porcion DECIMAL(10,3) DEFAULT 0;
        `, { transaction: t });
        console.log('   OK\n');

        // 2. Agregar columna unidad_medida
        console.log('2. Agregando columna unidad_medida...');
        await sequelize.query(`
            ALTER TABLE restaurante.carta_producto_ingred
            ADD COLUMN IF NOT EXISTS unidad_medida VARCHAR(20) DEFAULT 'g';
        `, { transaction: t });
        console.log('   OK\n');

        await t.commit();
        console.log('✅ Migración completada exitosamente.');
    } catch (err) {
        await t.rollback();
        console.error('❌ Error en migración:', err.message);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
