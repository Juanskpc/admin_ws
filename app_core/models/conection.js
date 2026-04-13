const { Sequelize, DataTypes } = require('sequelize');
const fs   = require('fs');
const path = require('path');
const pg   = require('pg');

const appTimezone = process.env.APP_TIMEZONE || 'America/Bogota';
const appTimezoneOffset = process.env.APP_TIMEZONE_OFFSET || '-05:00';
const dbTimestampsAreUtc = process.env.DB_TIMESTAMPS_ARE_UTC === 'true';

function normalizePgTimestamp(raw) {
  return String(raw).replace(' ', 'T');
}

function parsePgTimestamp(raw) {
  if (raw == null) return null;
  const normalized = normalizePgTimestamp(raw);
  const value = dbTimestampsAreUtc ? `${normalized}Z` : normalized;
  return new Date(value);
}

// OID 1114 = timestamp, OID 1115 = timestamp[] (arrays)
pg.types.setTypeParser(1114, (val) => parsePgTimestamp(val));
pg.types.setTypeParser(1115, (val) => {
  if (!val) return val;
  return val.slice(1, -1).split(',').map((v) => {
    const s = v.trim().replace(/^"|"$/g, '');
    return s === 'NULL' ? null : parsePgTimestamp(s);
  });
});

const isSSL = process.env.DB_SSL === 'true';

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    timezone: appTimezoneOffset,
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

sequelize.addHook('afterConnect', async (connection) => {
  await connection.query(`SET TIME ZONE '${appTimezone}'`);
});

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

// ── Pool pg nativo para queries raw (usado en reporteDao, etc.) ──
const pool = new pg.Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  max: 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 30000,
  ...(process.env.DB_SSL === 'true' ? { ssl: { require: true, rejectUnauthorized: false } } : {}),
});

module.exports = { ...db, pool };