-- ============================================================
-- ESQUEMA: parqueadero
-- Tablas específicas para el módulo de parqueadero
-- ============================================================

-- 1. Crear esquema
CREATE SCHEMA IF NOT EXISTS parqueadero;

-- 2. Tipos de vehículo
CREATE TABLE IF NOT EXISTS parqueadero.parq_tipo_vehiculo (
    id_tipo_vehiculo  SERIAL PRIMARY KEY,
    nombre            VARCHAR(100) NOT NULL,
    descripcion       VARCHAR(255),
    id_negocio        INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
    estado            CHAR(1) DEFAULT 'A',
    fecha_creacion    TIMESTAMP DEFAULT NOW()
);

-- 3. Tarifas
CREATE TABLE IF NOT EXISTS parqueadero.parq_tarifa (
    id_tarifa         SERIAL PRIMARY KEY,
    id_tipo_vehiculo  INTEGER NOT NULL REFERENCES parqueadero.parq_tipo_vehiculo(id_tipo_vehiculo),
    id_negocio        INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
    tipo_cobro        VARCHAR(30) NOT NULL DEFAULT 'HORA',  -- HORA | FRACCION | DIA | MES
    valor             NUMERIC(12,2) NOT NULL DEFAULT 0,
    descripcion       VARCHAR(255),
    estado            CHAR(1) DEFAULT 'A',
    fecha_creacion    TIMESTAMP DEFAULT NOW()
);

-- 4. Configuración de capacidad por negocio
CREATE TABLE IF NOT EXISTS parqueadero.parq_capacidad (
    id_capacidad      SERIAL PRIMARY KEY,
    id_negocio        INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
    id_tipo_vehiculo  INTEGER NOT NULL REFERENCES parqueadero.parq_tipo_vehiculo(id_tipo_vehiculo),
    espacios_total    INTEGER NOT NULL DEFAULT 0,
    estado            CHAR(1) DEFAULT 'A',
    fecha_creacion    TIMESTAMP DEFAULT NOW(),
    UNIQUE(id_negocio, id_tipo_vehiculo)
);

-- 5. Registro de vehículos (entradas/salidas)
CREATE TABLE IF NOT EXISTS parqueadero.parq_vehiculo (
    id_vehiculo       SERIAL PRIMARY KEY,
    placa             VARCHAR(20) NOT NULL,
    id_tipo_vehiculo  INTEGER NOT NULL REFERENCES parqueadero.parq_tipo_vehiculo(id_tipo_vehiculo),
    id_negocio        INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
    fecha_entrada     TIMESTAMP NOT NULL DEFAULT NOW(),
    fecha_salida      TIMESTAMP,
    id_tarifa         INTEGER REFERENCES parqueadero.parq_tarifa(id_tarifa),
    valor_cobrado     NUMERIC(12,2),
    id_usuario_entrada INTEGER REFERENCES general.gener_usuario(id_usuario),
    id_usuario_salida  INTEGER REFERENCES general.gener_usuario(id_usuario),
    observaciones     TEXT,
    estado            CHAR(1) DEFAULT 'A',  -- A=Activo(dentro), S=Salió, X=Anulado
    fecha_creacion    TIMESTAMP DEFAULT NOW()
);

-- 6. Abonados / mensualidades
CREATE TABLE IF NOT EXISTS parqueadero.parq_abonado (
    id_abonado        SERIAL PRIMARY KEY,
    nombre            VARCHAR(200) NOT NULL,
    documento         VARCHAR(50),
    telefono          VARCHAR(50),
    placa             VARCHAR(20) NOT NULL,
    id_tipo_vehiculo  INTEGER NOT NULL REFERENCES parqueadero.parq_tipo_vehiculo(id_tipo_vehiculo),
    id_negocio        INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
    fecha_inicio      DATE NOT NULL,
    fecha_fin         DATE NOT NULL,
    valor_mensualidad NUMERIC(12,2) NOT NULL DEFAULT 0,
    estado            CHAR(1) DEFAULT 'A',
    fecha_creacion    TIMESTAMP DEFAULT NOW()
);

-- 7. Caja
CREATE TABLE IF NOT EXISTS parqueadero.parq_caja (
    id_caja           SERIAL PRIMARY KEY,
    id_negocio        INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
    id_usuario        INTEGER NOT NULL REFERENCES general.gener_usuario(id_usuario),
    monto_apertura    NUMERIC(12,2) NOT NULL DEFAULT 0,
    monto_cierre      NUMERIC(12,2),
    fecha_apertura    TIMESTAMP NOT NULL DEFAULT NOW(),
    fecha_cierre      TIMESTAMP,
    estado            CHAR(1) DEFAULT 'A',  -- A=Abierta, C=Cerrada
    observaciones     TEXT
);

-- 8. Movimientos de caja
CREATE TABLE IF NOT EXISTS parqueadero.parq_movimiento_caja (
    id_movimiento     SERIAL PRIMARY KEY,
    id_caja           INTEGER NOT NULL REFERENCES parqueadero.parq_caja(id_caja),
    tipo              VARCHAR(10) NOT NULL,   -- INGRESO | EGRESO
    monto             NUMERIC(12,2) NOT NULL,
    concepto          VARCHAR(255),
    id_vehiculo       INTEGER REFERENCES parqueadero.parq_vehiculo(id_vehiculo),
    id_usuario        INTEGER NOT NULL REFERENCES general.gener_usuario(id_usuario),
    fecha             TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 9. Métodos de pago configurados por negocio
CREATE TABLE IF NOT EXISTS parqueadero.parq_metodo_pago (
    id_metodo_pago    SERIAL PRIMARY KEY,
    nombre            VARCHAR(100) NOT NULL,
    id_negocio        INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
    estado            CHAR(1) DEFAULT 'A',
    fecha_creacion    TIMESTAMP DEFAULT NOW()
);

-- 10. Datos / configuración del parqueadero
CREATE TABLE IF NOT EXISTS parqueadero.parq_configuracion (
    id_configuracion  SERIAL PRIMARY KEY,
    id_negocio        INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) UNIQUE,
    nombre_comercial  VARCHAR(200),
    direccion         VARCHAR(255),
    telefono          VARCHAR(50),
    horario_apertura  TIME,
    horario_cierre    TIME,
    logo_url          VARCHAR(500),
    estado            CHAR(1) DEFAULT 'A',
    fecha_creacion    TIMESTAMP DEFAULT NOW(),
    fecha_actualizacion TIMESTAMP DEFAULT NOW()
);

-- Índices útiles
CREATE INDEX IF NOT EXISTS idx_vehiculo_placa     ON parqueadero.parq_vehiculo(placa);
CREATE INDEX IF NOT EXISTS idx_vehiculo_negocio   ON parqueadero.parq_vehiculo(id_negocio);
CREATE INDEX IF NOT EXISTS idx_vehiculo_estado    ON parqueadero.parq_vehiculo(estado);
CREATE INDEX IF NOT EXISTS idx_vehiculo_entrada   ON parqueadero.parq_vehiculo(fecha_entrada);
CREATE INDEX IF NOT EXISTS idx_abonado_placa      ON parqueadero.parq_abonado(placa);
CREATE INDEX IF NOT EXISTS idx_caja_negocio       ON parqueadero.parq_caja(id_negocio);
CREATE INDEX IF NOT EXISTS idx_tarifa_negocio     ON parqueadero.parq_tarifa(id_negocio);
