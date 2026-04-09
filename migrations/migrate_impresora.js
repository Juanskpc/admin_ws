/**
 * Migración: agrega columna nombre_impresora a parqueadero.parq_configuracion
 * Ejecutar con: node migrations/migrate_impresora.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
  const t = await sequelize.transaction();
  try {
    console.log('Migrando: agregar nombre_impresora a parq_configuracion...');
    await sequelize.query(`
      ALTER TABLE parqueadero.parq_configuracion
      ADD COLUMN IF NOT EXISTS nombre_impresora VARCHAR(255) DEFAULT NULL;
    `, { transaction: t });
    console.log('   Columna nombre_impresora OK');
    await t.commit();
    console.log('\nMigración completada.');
  } catch (err) {
    await t.rollback();
    console.error('Error en migración:', err);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

migrate();
