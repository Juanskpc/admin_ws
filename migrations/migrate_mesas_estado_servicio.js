/**
 * Migracion — estado_servicio para restaurante.rest_mesa
 *
 * Ejecutar: node migrations/migrate_mesas_estado_servicio.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
  const t = await sequelize.transaction();
  try {
    console.log('Iniciando migracion de estado_servicio en rest_mesa...');

    await sequelize.query(`
      ALTER TABLE restaurante.rest_mesa
      ADD COLUMN IF NOT EXISTS estado_servicio VARCHAR(20) NOT NULL DEFAULT 'DISPONIBLE';
    `, { transaction: t });

    await sequelize.query(`
      UPDATE restaurante.rest_mesa
      SET estado_servicio = CASE
        WHEN estado = 'I' THEN 'DISPONIBLE'
        ELSE COALESCE(estado_servicio, 'DISPONIBLE')
      END;
    `, { transaction: t });

    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_rest_mesa_estado_servicio
      ON restaurante.rest_mesa(id_negocio, estado, estado_servicio);
    `, { transaction: t });

    await t.commit();
    console.log('Migracion completada correctamente.');
  } catch (err) {
    await t.rollback();
    console.error('Error en migracion:', err.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

migrate();
