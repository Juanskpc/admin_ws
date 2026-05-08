/**
 * Migracion: agrega visibilidad a menu y redes sociales en negocio
 * Ejecutar con: node migrations/migrate_menu_visible_redes.js
 *
 * Cambios:
 * 1. Agrega columna visible a restaurante.carta_categoria
 * 2. Agrega columna visible a restaurante.carta_producto
 * 3. Agrega columnas direccion, url_whatsapp, url_facebook, url_instagram a general.gener_negocio
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('Iniciando migracion: visibilidad y redes...\n');

        console.log('1. Agregando columna visible en carta_categoria...');
        await sequelize.query(`
            ALTER TABLE restaurante.carta_categoria
            ADD COLUMN IF NOT EXISTS visible BOOLEAN DEFAULT true;
        `, { transaction: t });
        console.log('   OK\n');

        console.log('2. Agregando columna visible en carta_producto...');
        await sequelize.query(`
            ALTER TABLE restaurante.carta_producto
            ADD COLUMN IF NOT EXISTS visible BOOLEAN DEFAULT true;
        `, { transaction: t });
        console.log('   OK\n');

        console.log('3. Agregando columnas de contacto en gener_negocio...');
        await sequelize.query(`
            ALTER TABLE general.gener_negocio
            ADD COLUMN IF NOT EXISTS direccion VARCHAR(255);
        `, { transaction: t });
        await sequelize.query(`
            ALTER TABLE general.gener_negocio
            ADD COLUMN IF NOT EXISTS url_whatsapp VARCHAR(255);
        `, { transaction: t });
        await sequelize.query(`
            ALTER TABLE general.gener_negocio
            ADD COLUMN IF NOT EXISTS url_facebook VARCHAR(255);
        `, { transaction: t });
        await sequelize.query(`
            ALTER TABLE general.gener_negocio
            ADD COLUMN IF NOT EXISTS url_instagram VARCHAR(255);
        `, { transaction: t });
        console.log('   OK\n');

        await t.commit();
        console.log('Migracion completada exitosamente.');
    } catch (err) {
        await t.rollback();
        console.error('Error en migracion:', err.message);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
