/**
 * Migracion — seccion para restaurante.rest_mesa
 *
 * Objetivo: que el administrador agrupe sus mesas como quiera («Piso 1», «Patio», «Terraza»…).
 * Es texto libre y opcional: NULL = mesa sin seccion (el salon se ve como siempre).
 *
 * Idempotente: comprueba information_schema antes de alterar.
 * Ejecutar: npm run migrate:restaurante-mesa-seccion
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
  const t = await sequelize.transaction();
  try {
    console.log('Iniciando migracion de seccion en rest_mesa...');

    const [existe] = await sequelize.query(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'restaurante'
        AND table_name = 'rest_mesa'
        AND column_name = 'seccion'
    `, { transaction: t });

    if (existe.length === 0) {
      await sequelize.query(`
        ALTER TABLE restaurante.rest_mesa
        ADD COLUMN seccion VARCHAR(60) NULL;
      `, { transaction: t });
      console.log('  + columna seccion creada');
    } else {
      console.log('  = la columna seccion ya existia');
    }

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
