/**
 * Migracion: columnas de control de inventario en restaurante.carta_ingrediente
 * Ejecutar con: node migrations/migrate_inventario_insumos.js
 */

require('dotenv').config();
const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
    dialectOptions: process.env.DB_SSL === 'true'
      ? { ssl: { require: true, rejectUnauthorized: false } }
      : {},
  }
);

async function run() {
  try {
    console.log('Iniciando migracion inventario de insumos...');

    await sequelize.query(`
      ALTER TABLE restaurante.carta_ingrediente
      ADD COLUMN IF NOT EXISTS unidad_medida VARCHAR(20) DEFAULT 'g';
    `);

    await sequelize.query(`
      ALTER TABLE restaurante.carta_ingrediente
      ADD COLUMN IF NOT EXISTS stock_actual DECIMAL(12,3) DEFAULT 0;
    `);

    await sequelize.query(`
      ALTER TABLE restaurante.carta_ingrediente
      ADD COLUMN IF NOT EXISTS stock_minimo DECIMAL(12,3) DEFAULT 0;
    `);

    await sequelize.query(`
      ALTER TABLE restaurante.carta_ingrediente
      ADD COLUMN IF NOT EXISTS stock_maximo DECIMAL(12,3) DEFAULT 0;
    `);

    await sequelize.query(`
      UPDATE restaurante.carta_ingrediente
      SET stock_maximo = CASE
        WHEN stock_maximo IS NULL OR stock_maximo <= 0 THEN GREATEST(stock_actual, stock_minimo * 2, 1)
        ELSE stock_maximo
      END;
    `);

    console.log('Migracion completada.');
    process.exit(0);
  } catch (err) {
    console.error('Error en migracion inventario:', err.message);
    process.exit(1);
  }
}

run();
