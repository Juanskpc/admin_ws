/**
 * Migración: tabla parqueadero.parq_factura
 * Ejecutar: node migrations/migrate_factura.js
 */
require('dotenv').config();
const { Sequelize } = require('sequelize');

const isSSL = process.env.DB_SSL === 'true';
const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  dialect: 'postgres',
  logging: console.log,
  dialectOptions: isSSL ? { ssl: { require: true, rejectUnauthorized: false } } : {},
});

const SQL = `
-- ── Asegurar esquema ──────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS parqueadero;

-- ── Tabla facturas ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parqueadero.parq_factura (
  id_factura        BIGSERIAL        PRIMARY KEY,
  id_negocio        INTEGER          NOT NULL,
  numero_factura    TEXT             NOT NULL,
  id_vehiculo       INTEGER          REFERENCES parqueadero.parq_vehiculo(id_vehiculo) ON DELETE SET NULL,
  placa             VARCHAR(20),
  id_tipo_vehiculo  INTEGER,
  id_tarifa         INTEGER,
  tipo_cobro        VARCHAR(10),
  valor_unitario    DECIMAL(12,2)    DEFAULT 0,
  valor_total       DECIMAL(12,2),
  estado            CHAR(1)          NOT NULL DEFAULT 'A', -- A=Abierta, C=Cerrada, X=Anulada
  fecha_entrada     TIMESTAMPTZ,
  fecha_cierre      TIMESTAMPTZ,
  fecha_creacion    TIMESTAMPTZ      NOT NULL DEFAULT now(),
  observaciones     TEXT,
  CONSTRAINT uq_parq_factura_numero UNIQUE (id_negocio, numero_factura)
);

CREATE INDEX IF NOT EXISTS idx_parq_factura_negocio  ON parqueadero.parq_factura (id_negocio);
CREATE INDEX IF NOT EXISTS idx_parq_factura_vehiculo ON parqueadero.parq_factura (id_vehiculo);
CREATE INDEX IF NOT EXISTS idx_parq_factura_estado   ON parqueadero.parq_factura (estado);
`;

(async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Conexión a DB establecida');
    await sequelize.query(SQL);
    console.log('✅ Migración parq_factura completada');
  } catch (err) {
    console.error('❌ Error en migración:', err.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
})();
