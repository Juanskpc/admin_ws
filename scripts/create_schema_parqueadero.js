/**
 * Script para crear el esquema `parqueadero` y sus tablas en la BD.
 * Ejecutar: node scripts/create_schema_parqueadero.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Sequelize } = require('sequelize');

const isSSL = process.env.DB_SSL === 'true';
const sequelize = new Sequelize(
  process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: console.log,
    dialectOptions: isSSL ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  }
);

(async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Conectado a la BD');

    const sql = fs.readFileSync(
      path.join(__dirname, 'create_schema_parqueadero.sql'),
      'utf-8'
    );

    await sequelize.query(sql);
    console.log('✅ Esquema "parqueadero" y tablas creadas exitosamente');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
})();
