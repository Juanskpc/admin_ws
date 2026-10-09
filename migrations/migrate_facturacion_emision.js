/**
 * FE-2 — Las tablas de emisión (tarea R1.1 de `docs/plan-fe-restaurante.md`).
 *
 * FE-1 (`migrate_facturacion_datos_fiscales.js`) creó el sitio donde viven los datos fiscales del
 * negocio. Esto crea el sitio donde vive lo que se EMITE: cómo emite cada negocio
 * (`fe_configuracion`), con qué rango (`fe_resolucion`), el documento y sus líneas
 * (`fe_documento`, `fe_documento_linea`), cada llamada al proveedor (`fe_intento`) y la copia
 * propia del PDF y el XML (`fe_documento_archivo`).
 *
 * ## Sigue sin cambiar nada para nadie
 *
 * Ninguna tabla nace con filas. Un negocio no factura hasta que se cumplen los cuatro
 * interruptores de D12 (feature, modo, datos completos y configuración activa), y el cuarto
 * —`fe_configuracion.estado`— solo lo mueve un super admin.
 *
 * ## Tres decisiones que están en el esquema y no en un `if`
 *
 * 1. **Un documento aceptado no se toca** (D18): el trigger `trg_fe_documento_inmutable` rechaza
 *    cualquier cambio de sus campos fiscales y su borrado. Los campos de operación
 *    (`proximo_intento_en`, `avisos`…) sí se pueden mover. La única puerta para borrar es
 *    `SET LOCAL facturacion.permitir_borrado_pruebas = 'on'`, que existe para que las suites
 *    limpien lo suyo.
 * 2. **Una venta se factura una sola vez** (D5): `uq_fedoc_origen`. El gancho del cobro se puede
 *    llamar dos veces —`marcarPagado` y `cerrarOrden`— y el segundo no crea nada.
 *    Y **no toda venta se factura**: por defecto solo la que el cajero pide
 *    (`fe_configuracion.facturar_todo = false`). Un negocio con un paquete pequeño de documentos
 *    no puede gastarlo en cada gaseosa; el que quiera facturarlo todo lo enciende.
 * 3. **El origen es texto y no tiene FK** (ADR-005): `origen_id` guarda el `id_orden` como texto.
 *    Facturación sabe de qué venta salió el documento; el restaurante no sabe que existe.
 *
 * `ON DELETE RESTRICT` hacia el negocio, nunca CASCADE: un documento fiscal se conserva cinco
 * años aunque el negocio se vaya.
 *
 * Idempotente: `IF NOT EXISTS` en todo, y la ALTER comprueba `information_schema` antes.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

const SQL_ESQUEMA = `
CREATE SCHEMA IF NOT EXISTS facturacion;

-- 1. Cómo emite cada negocio (1:1)
CREATE TABLE IF NOT EXISTS facturacion.fe_configuracion (
    id_negocio                 integer PRIMARY KEY
                               REFERENCES general.gener_negocio(id_negocio) ON DELETE RESTRICT,
    proveedor                  varchar(20)  NOT NULL DEFAULT 'FACTUS',
    ambiente                   varchar(12)  NOT NULL DEFAULT 'PRUEBAS',
    estado                     varchar(15)  NOT NULL DEFAULT 'SIN_CONFIGURAR',
    -- JSON {client_id, client_secret, username, password} cifrado con credencialCifrada.cifrar()
    credenciales_cifradas      text,
    -- Impuesto que se aplica a un producto que no tiene el suyo (D7)
    impuesto_defecto_codigo    varchar(4)   NOT NULL DEFAULT 'ZZ',
    impuesto_defecto_tarifa    numeric(5,2) NOT NULL DEFAULT 0,
    -- Impuesto de la línea de domicilio (D8)
    impuesto_domicilio_codigo  varchar(4)   NOT NULL DEFAULT 'ZZ',
    impuesto_domicilio_tarifa  numeric(5,2) NOT NULL DEFAULT 0,
    -- ¿Factus envía el correo al comprador cuando hay correo?
    enviar_correo              boolean      NOT NULL DEFAULT true,
    -- false (defecto): solo se factura el cobro en el que el cajero lo pide.
    -- true: todo cobro sale facturado, a consumidor final si no se dice otra cosa.
    facturar_todo              boolean      NOT NULL DEFAULT false,
    activado_en                timestamptz,
    activado_por               integer REFERENCES general.gener_usuario(id_usuario),
    creado_en                  timestamptz  NOT NULL DEFAULT now(),
    actualizado_en             timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT chk_fecfg_proveedor CHECK (proveedor IN ('FACTUS')),
    CONSTRAINT chk_fecfg_ambiente  CHECK (ambiente IN ('PRUEBAS','PRODUCCION')),
    CONSTRAINT chk_fecfg_estado    CHECK (estado IN ('SIN_CONFIGURAR','EN_PRUEBAS','ACTIVO','SUSPENDIDO'))
);

-- 2. Rangos de numeración, copiados del proveedor (el proveedor lleva el consecutivo, D3)
CREATE TABLE IF NOT EXISTS facturacion.fe_resolucion (
    id_resolucion       uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
    id_negocio          integer NOT NULL
                        REFERENCES general.gener_negocio(id_negocio) ON DELETE RESTRICT,
    id_rango_proveedor  integer NOT NULL,
    tipo_documento      varchar(4)  NOT NULL DEFAULT 'FV',
    prefijo             varchar(10),
    numero_resolucion   varchar(40),
    rango_desde         bigint,
    rango_hasta         bigint,
    consecutivo_actual  bigint,
    vigencia_desde      date,
    vigencia_hasta      date,
    vencida             boolean NOT NULL DEFAULT false,
    en_uso              boolean NOT NULL DEFAULT false,
    sincronizado_en     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_feres_tipo CHECK (tipo_documento IN ('FV','NC')),
    CONSTRAINT uq_feres_rango UNIQUE (id_negocio, id_rango_proveedor)
);
-- Un solo rango en uso por negocio y tipo de documento
CREATE UNIQUE INDEX IF NOT EXISTS uq_feres_en_uso
    ON facturacion.fe_resolucion (id_negocio, tipo_documento) WHERE en_uso;

-- 3. El documento fiscal (cabecera)
CREATE TABLE IF NOT EXISTS facturacion.fe_documento (
    id_documento          uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
    id_negocio            integer NOT NULL
                          REFERENCES general.gener_negocio(id_negocio) ON DELETE RESTRICT,
    tipo                  varchar(4)  NOT NULL,              -- FV factura de venta · NC nota crédito
    estado                varchar(16) NOT NULL DEFAULT 'EN_COLA',
    ambiente              varchar(12) NOT NULL,              -- copiado de fe_configuracion al crear
    proveedor             varchar(20) NOT NULL DEFAULT 'FACTUS',
    -- De qué venta salió. Texto y sin FK a propósito (ADR-005).
    origen_vertical       varchar(20) NOT NULL,              -- 'RESTAURANTE'
    origen_tipo           varchar(30) NOT NULL,              -- 'PEDIDO'
    origen_id             varchar(40) NOT NULL,              -- id_orden como texto
    origen_referencia     varchar(40),                       -- numero_orden, para mostrar
    -- Para una NC: la factura que anula
    id_documento_referencia uuid REFERENCES facturacion.fe_documento(id_documento),
    -- Lo que se le manda al proveedor como reference_code. Único en todo el sistema.
    codigo_referencia     varchar(60) NOT NULL,
    -- Instantáneas: nunca se releen de otra tabla después de crear el documento
    emisor                jsonb NOT NULL,
    adquiriente           jsonb NOT NULL,
    pagos                 jsonb NOT NULL DEFAULT '[]'::jsonb,
    subtotal              numeric(14,2) NOT NULL DEFAULT 0,  -- suma de bases (sin impuestos)
    total_impuestos       numeric(14,2) NOT NULL DEFAULT 0,
    total                 numeric(14,2) NOT NULL DEFAULT 0,
    ajuste_redondeo       numeric(8,2)  NOT NULL DEFAULT 0,  -- ver R3.2
    -- Lo que devuelve el proveedor
    numero                varchar(30),
    cufe                  varchar(200),
    fecha_validacion      timestamptz,
    url_publica           text,
    url_qr                text,
    -- Reintentos
    intentos              integer NOT NULL DEFAULT 0,
    proximo_intento_en    timestamptz,
    ultimo_error          text,
    -- Evidencia
    payload               jsonb,
    respuesta             jsonb,
    avisos                jsonb NOT NULL DEFAULT '[]'::jsonb,
    creado_por            integer REFERENCES general.gener_usuario(id_usuario),
    creado_en             timestamptz NOT NULL DEFAULT now(),
    actualizado_en        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_fedoc_tipo   CHECK (tipo IN ('FV','NC')),
    CONSTRAINT chk_fedoc_estado CHECK (estado IN
        ('PENDIENTE_DATOS','EN_COLA','ENVIANDO','ACEPTADO','RECHAZADO','ERROR','ANULADO')),
    CONSTRAINT chk_fedoc_ambiente CHECK (ambiente IN ('PRUEBAS','PRODUCCION')),
    CONSTRAINT uq_fedoc_referencia UNIQUE (codigo_referencia),
    -- Invariante 2: una venta se factura una sola vez
    CONSTRAINT uq_fedoc_origen UNIQUE (id_negocio, origen_vertical, origen_tipo, origen_id, tipo)
);
CREATE INDEX IF NOT EXISTS ix_fedoc_negocio_fecha
    ON facturacion.fe_documento (id_negocio, creado_en DESC);
CREATE INDEX IF NOT EXISTS ix_fedoc_pendientes
    ON facturacion.fe_documento (proximo_intento_en)
    WHERE estado IN ('EN_COLA','ERROR','ENVIANDO');

-- 4. Líneas
CREATE TABLE IF NOT EXISTS facturacion.fe_documento_linea (
    id_linea           bigserial PRIMARY KEY,
    id_documento       uuid NOT NULL REFERENCES facturacion.fe_documento(id_documento),
    id_negocio         integer NOT NULL,
    orden              integer NOT NULL,
    codigo             varchar(50) NOT NULL,
    descripcion        varchar(300) NOT NULL,
    cantidad           numeric(12,3) NOT NULL,
    precio_bruto       numeric(14,2) NOT NULL,  -- precio de carta, con impuesto
    precio_neto        numeric(14,2) NOT NULL,  -- sin impuesto, lo que se envía como price
    codigo_impuesto    varchar(4) NOT NULL,
    tarifa_impuesto    numeric(5,2) NOT NULL,
    base               numeric(14,2) NOT NULL,
    impuesto           numeric(14,2) NOT NULL,
    total              numeric(14,2) NOT NULL,
    unidad_medida      varchar(10) NOT NULL,
    es_domicilio       boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS ix_felinea_documento ON facturacion.fe_documento_linea (id_documento);

-- 5. Bitácora de llamadas al proveedor
CREATE TABLE IF NOT EXISTS facturacion.fe_intento (
    id_intento     bigserial PRIMARY KEY,
    id_documento   uuid NOT NULL REFERENCES facturacion.fe_documento(id_documento),
    id_negocio     integer NOT NULL,
    iniciado_en    timestamptz NOT NULL DEFAULT now(),
    duracion_ms    integer,
    http_status    integer,
    resultado      varchar(24) NOT NULL,
    mensaje        text,
    respuesta      jsonb
);
CREATE INDEX IF NOT EXISTS ix_feintento_documento ON facturacion.fe_intento (id_documento);

-- 6. Copia propia del PDF y el XML (D13)
CREATE TABLE IF NOT EXISTS facturacion.fe_documento_archivo (
    id_documento   uuid NOT NULL REFERENCES facturacion.fe_documento(id_documento),
    tipo           varchar(3) NOT NULL,
    contenido      bytea NOT NULL,
    bytes          integer NOT NULL,
    sha256         char(64) NOT NULL,
    descargado_en  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id_documento, tipo),
    CONSTRAINT chk_fearch_tipo CHECK (tipo IN ('PDF','XML'))
);

-- 7. Inmutabilidad (invariante 1, D18)
CREATE OR REPLACE FUNCTION facturacion.fe_documento_inmutable() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.estado = 'ACEPTADO'
           AND coalesce(current_setting('facturacion.permitir_borrado_pruebas', true), '') <> 'on' THEN
            RAISE EXCEPTION 'FE_DOCUMENTO_INMUTABLE: el documento % fue aceptado y no se puede borrar',
                OLD.id_documento;
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.estado = 'ACEPTADO' AND (
           NEW.estado      IS DISTINCT FROM OLD.estado
        OR NEW.total       IS DISTINCT FROM OLD.total
        OR NEW.numero      IS DISTINCT FROM OLD.numero
        OR NEW.cufe        IS DISTINCT FROM OLD.cufe
        OR NEW.adquiriente IS DISTINCT FROM OLD.adquiriente
        OR NEW.emisor      IS DISTINCT FROM OLD.emisor
        OR NEW.payload     IS DISTINCT FROM OLD.payload
        OR NEW.respuesta   IS DISTINCT FROM OLD.respuesta) THEN
        RAISE EXCEPTION 'FE_DOCUMENTO_INMUTABLE: el documento % fue aceptado y no se puede modificar',
            OLD.id_documento;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fe_documento_inmutable ON facturacion.fe_documento;
CREATE TRIGGER trg_fe_documento_inmutable
    BEFORE UPDATE OR DELETE ON facturacion.fe_documento
    FOR EACH ROW EXECUTE FUNCTION facturacion.fe_documento_inmutable();
`;

async function existeTabla(esquema, tabla, t) {
    const filas = await Models.sequelize.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = :esquema AND table_name = :tabla LIMIT 1;`,
        {
            replacements: { esquema, tabla },
            transaction: t,
            type: Models.sequelize.QueryTypes.SELECT,
        }
    );
    return filas.length > 0;
}

async function existeColumna(esquema, tabla, columna, t) {
    const filas = await Models.sequelize.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna LIMIT 1;`,
        {
            replacements: { esquema, tabla, columna },
            transaction: t,
            type: Models.sequelize.QueryTypes.SELECT,
        }
    );
    return filas.length > 0;
}

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. Tablas de emisión y trigger de inmutabilidad...');
        // Sin `replacements`: el SQL lleva `::jsonb` y un cuerpo plpgsql, y Sequelize no debe
        // interpretar nada de eso.
        await Models.sequelize.query(SQL_ESQUEMA, { transaction: t });

        // La tabla ya existía en las bases migradas antes del 2026-10-09: ahí el CREATE de arriba
        // no hace nada y la columna hay que añadirla.
        console.log('1b. facturacion.fe_configuracion.facturar_todo...');
        if (await existeColumna('facturacion', 'fe_configuracion', 'facturar_todo', t)) {
            console.log('   (ya existía)');
        } else {
            await Models.sequelize.query(
                `ALTER TABLE facturacion.fe_configuracion
                   ADD COLUMN facturar_todo boolean NOT NULL DEFAULT false;`,
                { transaction: t }
            );
        }

        console.log('2. restaurante.rest_metodo_pago.codigo_medio_pago_dian...');
        if (!(await existeTabla('restaurante', 'rest_metodo_pago', t))) {
            console.log('   (la tabla no existe en esta base: se omite)');
        } else if (await existeColumna('restaurante', 'rest_metodo_pago', 'codigo_medio_pago_dian', t)) {
            console.log('   (ya existía)');
        } else {
            // NULL permitido: un método sin código se envía como «otro» (ZZZ).
            await Models.sequelize.query(
                `ALTER TABLE restaurante.rest_metodo_pago ADD COLUMN codigo_medio_pago_dian varchar(3);`,
                { transaction: t }
            );
        }

        const tablas = await Models.sequelize.query(
            `SELECT table_name::text AS nombre FROM information_schema.tables
              WHERE table_schema = 'facturacion' ORDER BY table_name;`,
            { transaction: t, type: Models.sequelize.QueryTypes.SELECT }
        );
        const configurados = await Models.sequelize.query(
            `SELECT count(*)::int AS n FROM facturacion.fe_configuracion;`,
            { transaction: t, type: Models.sequelize.QueryTypes.SELECT }
        );

        await t.commit();

        console.log('\n=== FE-2 (esquema de emisión) listo ===');
        console.log(`   Tablas en facturacion: ${tablas.map((x) => x.nombre).join(', ')}`);
        console.log(`   Negocios con configuración de emisión: ${configurados[0].n}`);
        console.log('\n   Nada cambia para ningún negocio hasta que un super admin configure uno.');
        console.log('✓ Listo.');
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

migrate()
    .then(() => Models.sequelize.close())
    .catch(async (error) => {
        console.error('Falló la migración:', error.message);
        await Models.sequelize.close();
        process.exit(1);
    });
