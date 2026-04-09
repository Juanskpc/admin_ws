const { Sequelize, DataTypes } = require('sequelize');
const fs   = require('fs');
const path = require('path');
const pg   = require('pg');

// ── FIX CRÍTICO DE TIMEZONE ──────────────────────────────────────────────────
// pg v8+ interpreta TIMESTAMP WITHOUT TIME ZONE como hora LOCAL del proceso
// (en este caso Colombia UTC-5), añadiendo 5 horas al leer desde la BD que
// está en UTC. Forzamos lectura como UTC añadiendo 'Z' al string crudo.
// OID 1114 = timestamp, OID 1115 = timestamp[] (arrays)
pg.types.setTypeParser(1114, (val) => (val == null ? null : new Date(val + 'Z')));
pg.types.setTypeParser(1115, (val) => {
  if (!val) return val;
  // Desempaquetar array PostgreSQL "{2026-01-01 10:00:00,...}"
  return val.slice(1, -1).split(',').map((v) => {
    const s = v.trim().replace(/^"|"$/g, '');
    return s === 'NULL' ? null : new Date(s + 'Z');
  });
});
// ────────────────────────────────────────────────────────────────────────────

const isSSL = process.env.DB_SSL === 'true';

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    dialectOptions: isSSL ? {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    } : {},
    pool: {
      max: 10,
      min: 2,
      acquire: 30000,
      idle: 10000
    }
  }
);

const db = {};
const modelsPath = __dirname;

// Leer todos los modelos automáticamente
fs.readdirSync(modelsPath)
  .filter(file => 
    file !== 'conection.js' && 
    file.endsWith('.js')
  )
  .forEach(file => {
    const model = require(path.join(modelsPath, file))(sequelize, DataTypes);
    db[model.name] = model;
  });

// Ejecutar asociaciones (si existen)
Object.keys(db).forEach(modelName => {
  if (db[modelName].associate) {
    db[modelName].associate(db);
  }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;