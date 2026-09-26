/**
 * Estancias: reservas por noches sobre unidades (habitaciones, cabañas, cupos de guardería).
 *
 *   npm run migrate:reserva-estancias
 *
 * Es el segundo motor del módulo `reserva` (ver `docs/perfiles-de-reserva.md` §2.3). Vive en
 * tablas propias y **no toca** las de citas: la agenda de la barbería no se entera de que
 * existe. Comparte con ella clientes (`persona_negocio`), caja, formas de pago y permisos.
 *
 * ## Decisiones que están en el esquema
 *
 * - **Fechas `DATE`, no `timestamp`.** Una noche no tiene hora ni zona horaria. La hora de
 *   entrada y salida es configuración del negocio (`reserva_config.hora_checkin/checkout`), no
 *   dato de cada reserva.
 * - **El sobrecupo se impide en la base.** `EXCLUDE USING gist` sobre `(id_unidad, daterange)`
 *   para las estancias vivas: dos reservas de la misma habitación en noches que se pisan no
 *   pueden existir aunque dos peticiones lleguen a la vez. Necesita `btree_gist`; si no se puede
 *   crear (rol sin permiso), se avisa y el servicio sigue protegiendo con un bloqueo por unidad,
 *   que es lo que hace de todos modos.
 * - **La caja es la de siempre.** `reserva_movimiento_caja` gana `id_estancia`: un anticipo o un
 *   saldo es un ingreso más del turno, con su forma de pago.
 *
 * Idempotente.
 */
'use strict';
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');
const { publicarVista, auditar, asegurarColumna } = require('./lib_vistas_reserva');

async function crearBtreeGist() {
    // Fuera de la transacción principal: si el rol no puede crear extensiones, el error no debe
    // abortar el resto de la migración.
    try {
        await sequelize.query('CREATE EXTENSION IF NOT EXISTS btree_gist;');
        return true;
    } catch (err) {
        console.log(`   ⚠️  No se pudo crear btree_gist (${err.message}).`);
        console.log('      La exclusión de sobrecupo en la base queda sin crear; el servicio');
        console.log('      sigue impidiéndolo con un bloqueo por unidad. Pídele a un superusuario:');
        console.log('      CREATE EXTENSION btree_gist;  y vuelve a correr esta migración.');
        return false;
    }
}

async function migrar() {
    console.log('\n=== Migración: estancias (reserva) ===\n');
    console.log('0. Extensión btree_gist...');
    const hayGist = await crearBtreeGist();
    if (hayGist) console.log('   OK');

    const t = await sequelize.transaction();
    try {
        console.log('\n1. Tipos de unidad y unidades...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_unidad_tipo (
                id_unidad_tipo      SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                nombre              VARCHAR(100) NOT NULL,
                descripcion         TEXT,
                -- Huéspedes incluidos en la tarifa y máximo que admite la unidad.
                ocupacion_base      SMALLINT NOT NULL DEFAULT 2 CHECK (ocupacion_base > 0),
                capacidad_max       SMALLINT NOT NULL DEFAULT 2 CHECK (capacidad_max > 0),
                tarifa_base         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tarifa_base >= 0),
                -- Noches de viernes y sábado. NULL = cobra la base.
                tarifa_fin_semana   NUMERIC(14,2) NULL CHECK (tarifa_fin_semana >= 0),
                -- Por huésped adicional sobre la ocupación base, por noche.
                tarifa_persona_extra NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tarifa_persona_extra >= 0),
                min_noches          SMALLINT NOT NULL DEFAULT 1 CHECK (min_noches >= 1),
                comodidades         JSONB NOT NULL DEFAULT '[]'::jsonb,
                imagen_url          VARCHAR(500),
                orden               SMALLINT NOT NULL DEFAULT 0,
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_unidad_tipo_negocio
                ON reserva.reserva_unidad_tipo (id_negocio);

            CREATE TABLE IF NOT EXISTS reserva.reserva_unidad (
                id_unidad           SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_unidad_tipo      INTEGER NOT NULL REFERENCES reserva.reserva_unidad_tipo(id_unidad_tipo),
                nombre              VARCHAR(60) NOT NULL,
                notas               VARCHAR(255),
                -- Secreto del calendario que se exporta a Airbnb/Booking. Quien lo tenga ve las
                -- noches ocupadas (sin datos del huésped), así que no es el id.
                ical_token          UUID NOT NULL DEFAULT gen_random_uuid(),
                orden               SMALLINT NOT NULL DEFAULT 0,
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_unidad_tipo
                ON reserva.reserva_unidad (id_negocio, id_unidad_tipo);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_reserva_unidad_ical
                ON reserva.reserva_unidad (ical_token);
        `, { transaction: t });
        console.log('   OK');

        console.log('\n2. Tarifas por temporada...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_tarifa_temporada (
                id_tarifa           SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_unidad_tipo      INTEGER NOT NULL REFERENCES reserva.reserva_unidad_tipo(id_unidad_tipo) ON DELETE CASCADE,
                nombre              VARCHAR(80) NOT NULL,
                -- Noches a las que aplica, ambas inclusive.
                desde               DATE NOT NULL,
                hasta               DATE NOT NULL,
                precio_noche        NUMERIC(14,2) NOT NULL CHECK (precio_noche >= 0),
                min_noches          SMALLINT NULL CHECK (min_noches >= 1),
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CHECK (hasta >= desde)
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_tarifa_tipo
                ON reserva.reserva_tarifa_temporada (id_unidad_tipo, desde);
        `, { transaction: t });
        console.log('   OK');

        console.log('\n3. Estancias...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_estancia (
                id_estancia             SERIAL PRIMARY KEY,
                id_negocio              INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_unidad               INTEGER NOT NULL REFERENCES reserva.reserva_unidad(id_unidad),
                id_unidad_tipo          INTEGER NOT NULL REFERENCES reserva.reserva_unidad_tipo(id_unidad_tipo),
                fecha_entrada           DATE NOT NULL,
                fecha_salida            DATE NOT NULL,
                estado                  VARCHAR(20) NOT NULL DEFAULT 'pendiente'
                                        CHECK (estado IN ('pendiente', 'confirmada', 'en_curso',
                                                          'finalizada', 'cancelada', 'no_show')),
                huespedes               SMALLINT NOT NULL DEFAULT 1 CHECK (huespedes > 0),
                cliente_nombre          VARCHAR(150) NOT NULL,
                cliente_telefono        VARCHAR(30),
                cliente_email           VARCHAR(120),
                cliente_documento       VARCHAR(30),
                id_persona_negocio      UUID NULL REFERENCES platform.persona_negocio(id_persona_negocio),
                id_mascota              UUID NULL REFERENCES reserva.reserva_mascota(id_mascota) ON DELETE SET NULL,
                notas                   TEXT,
                codigo_publico          VARCHAR(36) NOT NULL,
                -- Precio de cada noche congelado al reservar: cambiar la tarifa mañana no
                -- reescribe lo que ya se prometió.
                detalle_noches          JSONB NOT NULL DEFAULT '[]'::jsonb,
                monto_total             NUMERIC(14,2) NOT NULL DEFAULT 0,
                monto_abono             NUMERIC(14,2) NULL,
                requiere_pago           BOOLEAN NOT NULL DEFAULT false,
                pago_estado             VARCHAR(25) NOT NULL DEFAULT 'no_aplica',
                comprobante_pago_url    VARCHAR(500),
                pago_validado_por_id_usuario INTEGER REFERENCES general.gener_usuario(id_usuario),
                pago_validado_en        TIMESTAMP,
                pago_rechazo_motivo     TEXT,
                checkin_en              TIMESTAMP,
                checkout_en             TIMESTAMP,
                cancelado_por           VARCHAR(20),
                cancelado_motivo        TEXT,
                origen                  VARCHAR(20) NOT NULL DEFAULT 'directo',
                creado_por_id_usuario   INTEGER REFERENCES general.gener_usuario(id_usuario),
                fecha_creacion          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CHECK (fecha_salida > fecha_entrada)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_reserva_estancia_codigo
                ON reserva.reserva_estancia (codigo_publico);
            CREATE INDEX IF NOT EXISTS idx_reserva_estancia_fechas
                ON reserva.reserva_estancia (id_negocio, fecha_entrada, fecha_salida);
            CREATE INDEX IF NOT EXISTS idx_reserva_estancia_unidad
                ON reserva.reserva_estancia (id_unidad, fecha_entrada);

            CREATE TABLE IF NOT EXISTS reserva.reserva_estancia_cargo (
                id_cargo            SERIAL PRIMARY KEY,
                id_estancia         INTEGER NOT NULL REFERENCES reserva.reserva_estancia(id_estancia) ON DELETE CASCADE,
                concepto            VARCHAR(150) NOT NULL,
                valor               NUMERIC(14,2) NOT NULL CHECK (valor > 0),
                id_usuario          INTEGER REFERENCES general.gener_usuario(id_usuario),
                fecha               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_estancia_cargo
                ON reserva.reserva_estancia_cargo (id_estancia);
        `, { transaction: t });

        if (hayGist) {
            const [[existe]] = await sequelize.query(`
                SELECT 1 AS ok FROM pg_constraint WHERE conname = 'ex_reserva_estancia_sin_sobrecupo';
            `, { transaction: t });
            if (!existe) {
                await sequelize.query(`
                    ALTER TABLE reserva.reserva_estancia
                    ADD CONSTRAINT ex_reserva_estancia_sin_sobrecupo
                    EXCLUDE USING gist (
                        id_unidad WITH =,
                        daterange(fecha_entrada, fecha_salida, '[)') WITH &&
                    ) WHERE (estado IN ('pendiente', 'confirmada', 'en_curso'));
                `, { transaction: t });
                console.log('   + exclusión de sobrecupo');
            } else {
                console.log('   · exclusión de sobrecupo ya existe');
            }
        }
        console.log('   OK');

        console.log('\n4. Bloqueos de unidad y calendarios externos...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_calendario_externo (
                id_calendario       SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_unidad           INTEGER NOT NULL REFERENCES reserva.reserva_unidad(id_unidad) ON DELETE CASCADE,
                nombre              VARCHAR(60) NOT NULL,
                url_ical            VARCHAR(1000) NOT NULL,
                ultima_sincronizacion TIMESTAMP,
                ultimo_error        TEXT,
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS reserva.reserva_bloqueo_unidad (
                id_bloqueo          SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_unidad           INTEGER NOT NULL REFERENCES reserva.reserva_unidad(id_unidad) ON DELETE CASCADE,
                -- Noches bloqueadas: [desde, hasta), igual que una estancia.
                fecha_desde         DATE NOT NULL,
                fecha_hasta         DATE NOT NULL,
                motivo              VARCHAR(255),
                origen              VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual', 'ical')),
                id_calendario       INTEGER NULL REFERENCES reserva.reserva_calendario_externo(id_calendario) ON DELETE CASCADE,
                uid_externo         VARCHAR(255),
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CHECK (fecha_hasta > fecha_desde)
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_bloqueo_unidad
                ON reserva.reserva_bloqueo_unidad (id_unidad, fecha_desde);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_reserva_bloqueo_unidad_ext
                ON reserva.reserva_bloqueo_unidad (id_calendario, uid_externo)
                WHERE id_calendario IS NOT NULL;
        `, { transaction: t });
        console.log('   OK');

        console.log('\n5. Caja...');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_movimiento_caja', 'id_estancia',
            'INTEGER NULL REFERENCES reserva.reserva_estancia(id_estancia) ON DELETE SET NULL');
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_reserva_mov_estancia
                ON reserva.reserva_movimiento_caja (id_estancia) WHERE id_estancia IS NOT NULL;
        `, { transaction: t });

        console.log('\n6. Auditoría...');
        for (const [tabla, pk] of [
            ['reserva.reserva_unidad_tipo', 'id_unidad_tipo'],
            ['reserva.reserva_unidad', 'id_unidad'],
            ['reserva.reserva_tarifa_temporada', 'id_tarifa'],
            ['reserva.reserva_estancia', 'id_estancia'],
            ['reserva.reserva_estancia_cargo', 'id_cargo'],
        ]) {
            if (await auditar(sequelize, t, tabla, pk)) console.log(`   ✓ ${tabla}`);
        }

        console.log('\n7. Vistas del catálogo de permisos...');
        const vistas = [
            {
                url: '/ocupacion', descripcion: 'OCUPACION', icono: 'calendar-range',
                roles: { ADMINISTRADOR: { crear: true, editar: true }, RECEPCIONISTA: { crear: true, editar: true } },
            },
            {
                url: '/estancias', descripcion: 'ESTANCIAS', icono: 'bed-double',
                roles: {
                    ADMINISTRADOR: { crear: true, editar: true, eliminar: true },
                    RECEPCIONISTA: { crear: true, editar: true },
                },
            },
            {
                url: '/unidades', descripcion: 'UNIDADES', icono: 'door-open',
                roles: { ADMINISTRADOR: { crear: true, editar: true, eliminar: true } },
            },
        ];
        for (const v of vistas) {
            const r = await publicarVista(sequelize, t, v);
            console.log(`   ${v.url} (${r.ajustes} ajuste(s) de negocio)`);
        }

        await t.commit();
        console.log('\n✓ Migración de estancias completada.');
        console.log('  Siguiente: npm run migrate:reserva-subniveles\n');
    } catch (err) {
        await t.rollback();
        console.error('\n✗ Error — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
