/**
 * Migración — Tabla rest_mesa + columna id_mesa en pedid_orden
 *
 * 1. Crea restaurante.rest_mesa
 * 2. Agrega columna id_mesa (FK) en restaurante.pedid_orden
 * 3. Inserta mesas de ejemplo para id_negocio = 1
 *
 * Ejecutar: node migrations/migrate_mesas.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('╔══════════════════════════════════════════╗');
        console.log('║  MIGRACIÓN — Mesas del restaurante       ║');
        console.log('╚══════════════════════════════════════════╝\n');

        // ====================================================
        // 1. Crear tabla rest_mesa
        // ====================================================
        console.log('1. Creando tabla rest_mesa...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_mesa (
                id_mesa         SERIAL PRIMARY KEY,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                nombre          VARCHAR(100) NOT NULL,
                numero          INTEGER NOT NULL,
                capacidad       INTEGER NOT NULL DEFAULT 4,
                estado          CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(id_negocio, numero)
            );
            CREATE INDEX IF NOT EXISTS idx_rest_mesa_negocio
                ON restaurante.rest_mesa(id_negocio, estado);
        `, { transaction: t });
        console.log('   ✔ rest_mesa creada\n');

        // ====================================================
        // 2. Agregar columna id_mesa a pedid_orden
        // ====================================================
        console.log('2. Agregando columna id_mesa a pedid_orden...');
        await sequelize.query(`
            ALTER TABLE restaurante.pedid_orden
                ADD COLUMN IF NOT EXISTS id_mesa INTEGER
                    REFERENCES restaurante.rest_mesa(id_mesa)
                    ON DELETE SET NULL;
        `, { transaction: t });
        console.log('   ✔ Columna id_mesa agregada\n');

        // ====================================================
        // 3. Insertar mesas de ejemplo para id_negocio = 1
        // ====================================================
        console.log('3. Insertando mesas de ejemplo...');
        await sequelize.query(`
            INSERT INTO restaurante.rest_mesa (id_negocio, nombre, numero, capacidad)
            VALUES
                (1, 'Mesa 1',  1, 4),
                (1, 'Mesa 2',  2, 4),
                (1, 'Mesa 3',  3, 4),
                (1, 'Mesa 4',  4, 6),
                (1, 'Mesa 5',  5, 6),
                (1, 'Mesa 6',  6, 2),
                (1, 'Mesa 7',  7, 2),
                (1, 'Mesa 8',  8, 8),
                (1, 'Mesa 9',  9, 4),
                (1, 'Mesa 10', 10, 4),
                (1, 'Barra 1', 11, 1),
                (1, 'Barra 2', 12, 1)
            ON CONFLICT (id_negocio, numero) DO NOTHING;
        `, { transaction: t });
        console.log('   ✔ 12 mesas insertadas\n');

        await t.commit();
        console.log('════════════════════════════════════════════');
        console.log('    MIGRACIÓN COMPLETADA EXITOSAMENTE ✅');
        console.log('════════════════════════════════════════════\n');
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', err.message);
        console.error(err);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
