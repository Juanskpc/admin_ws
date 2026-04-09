/**
 * Migración: agrega la columna valor_adicional a parqueadero.parq_tarifa.
 * valor_adicional = tarifa que se cobra por hora/fracción ADICIONAL después de la primera.
 * NULL significa que todas las horas se cobran al mismo precio (valor).
 *
 * Uso: node migrations/migrate_valor_adicional.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function run() {
  const t = await sequelize.transaction();
  try {
    console.log('Migrando: agregar valor_adicional a parq_tarifa...');
    await sequelize.query(`
      ALTER TABLE parqueadero.parq_tarifa
        ADD COLUMN IF NOT EXISTS valor_adicional DECIMAL(12,2) DEFAULT NULL;
    `, { transaction: t });
    console.log('   Columna valor_adicional OK');
    await t.commit();
    console.log('\n✅ Migración completada.');
  } catch (err) {
    await t.rollback();
    console.error('Error en migración:', err.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

run();
