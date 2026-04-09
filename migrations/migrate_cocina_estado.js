/**
 * Migración — Columna estado_cocina en pedid_orden
 *
 * Agrega una columna de seguimiento de estado en cocina al modelo de pedidos.
 * Esto permite el flujo Kanban del KDS: PENDIENTE → EN_PREPARACION → LISTO → ENTREGADO
 *
 * Ejecutar: node migrations/migrate_cocina_estado.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('╔══════════════════════════════════════════╗');
        console.log('║  MIGRACIÓN — Estado cocina (KDS)         ║');
        console.log('╚══════════════════════════════════════════╝\n');

        console.log('1. Agregando columna estado_cocina a pedid_orden...');
        await sequelize.query(`
            ALTER TABLE restaurante.pedid_orden
                ADD COLUMN IF NOT EXISTS estado_cocina VARCHAR(20) DEFAULT NULL;
        `, { transaction: t });
        console.log('   ✔ Columna estado_cocina agregada\n');

        console.log('2. Creando índice para consultas del KDS...');
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_pedid_orden_estado_cocina
                ON restaurante.pedid_orden(id_negocio, estado_cocina);
        `, { transaction: t });
        console.log('   ✔ Índice creado\n');

        await t.commit();
        console.log('════════════════════════════════════════════');
        console.log('    MIGRACIÓN COMPLETADA EXITOSAMENTE ✅');
        console.log('════════════════════════════════════════════\n');
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', err.message);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
