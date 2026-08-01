/**
 * F0 — Esquema `platform`: modelo de identidad (persona / identificador / persona_negocio).
 *
 * Ejecutar con:
 *   npm run migrate:platform-persona
 *
 * Decisiones que implementa (no las toma — ver los ADRs):
 *   ADR-006  modelo de dos niveles; las verticales referencian persona_negocio, nunca persona.
 *   ADR-024  PK en UUID v7; FK a id_negocio siguen siendo enteras.
 *   ADR-025  mientras el nivel global esté vacío, el teléfono operativo vive en persona_negocio,
 *            único por (id_negocio, telefono_e164). persona y persona_identificador se crean VACÍAS.
 *   freeze.md §D.4 + decisión 2026-07-31: timestamptz en platform (no wall-time).
 *
 * Esta migración NO crea el camino de escritura ni el backfill: son pasos posteriores de F0.
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();

    try {
        console.log('→ Migración F0: esquema platform (identidad)\n');

        console.log('1. Esquema platform...');
        await sequelize.query('CREATE SCHEMA IF NOT EXISTS platform;', { transaction: t });
        console.log('   OK\n');

        /*
         * uuidv7() es nativo en PostgreSQL 18, pero produccion corre 17.9 y NO lo tiene.
         * Definir la funcion aqui mantiene la migracion valida en ambas versiones. El dia que
         * produccion suba a 18 se puede reemplazar el cuerpo por "SELECT uuidv7()" y borrarla.
         */
        console.log('2. Funcion platform.uuid_generate_v7()...');
        await sequelize.query(
            `
            CREATE OR REPLACE FUNCTION platform.uuid_generate_v7()
            RETURNS uuid
            LANGUAGE plpgsql
            VOLATILE
            AS $func$
            BEGIN
                -- Parte de un UUID v4 (que ya trae la variante correcta), sobrescribe los
                -- primeros 48 bits con el timestamp Unix en milisegundos y fuerza la version 7.
                RETURN encode(
                    set_bit(
                        set_bit(
                            overlay(
                                uuid_send(gen_random_uuid())
                                PLACING substring(
                                    int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
                                    FROM 3
                                )
                                FROM 1 FOR 6
                            ),
                            52, 1
                        ),
                        53, 1
                    ),
                    'hex'
                )::uuid;
            END
            $func$;
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('3. Tabla platform.persona (nivel global — se crea VACÍA)...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS platform.persona (
                id_persona      uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
                creado_en       timestamptz NOT NULL DEFAULT now(),
                actualizado_en  timestamptz
            );
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON TABLE platform.persona IS
            'El ser humano, global y transversal a inquilinos. Sin PII de perfil: solo ancla identidad. '
            'NO SE PUEBLA hasta que exista el Portal del Cliente (ADR-006, ADR-025). '
            'Que esté vacía es deliberado — no es código muerto.';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('4. Tabla platform.persona_identificador (reservada — se crea VACÍA)...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS platform.persona_identificador (
                id_persona_identificador uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
                id_persona      uuid NOT NULL
                                REFERENCES platform.persona(id_persona) ON DELETE CASCADE,
                tipo            varchar(20) NOT NULL,
                valor           varchar(255) NOT NULL,
                verificado_en   timestamptz,
                activo          boolean NOT NULL DEFAULT true,
                creado_en       timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT chk_persona_identificador_tipo
                    CHECK (tipo IN ('telefono', 'email'))
            );
            `,
            { transaction: t }
        );
        // Un mismo identificador activo no puede pertenecer a dos personas. Los inactivos se
        // conservan como historial (un humano cambia de número), por eso el índice es parcial.
        await sequelize.query(
            `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_persona_identificador_activo
                ON platform.persona_identificador (tipo, valor) WHERE activo;
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON TABLE platform.persona_identificador IS
            'Teléfonos/emails de una persona global. Frontera reservada: VACÍA hasta el Portal del '
            'Cliente. Mientras tanto el teléfono operativo vive en persona_negocio (ADR-025).';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('5. Tabla platform.persona_negocio (operativa desde F0)...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS platform.persona_negocio (
                id_persona_negocio  uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
                id_negocio          integer NOT NULL
                                    REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                id_persona          uuid
                                    REFERENCES platform.persona(id_persona) ON DELETE SET NULL,
                telefono_e164       varchar(20),
                nombre_mostrado     varchar(150),
                notas               text,
                etiquetas           text[] NOT NULL DEFAULT '{}',
                consentimiento_mensajeria      boolean NOT NULL DEFAULT false,
                consentimiento_actualizado_en  timestamptz,
                preferencias_canal  jsonb NOT NULL DEFAULT '{}'::jsonb,
                creado_en           timestamptz NOT NULL DEFAULT now(),
                actualizado_en      timestamptz,
                CONSTRAINT chk_persona_negocio_telefono_e164
                    CHECK (telefono_e164 IS NULL OR telefono_e164 ~ '^\\+[1-9][0-9]{7,14}$')
            );
            `,
            { transaction: t }
        );
        // Clave de resolución de F0: unicidad por (negocio, teléfono). Jamás cruza inquilinos.
        await sequelize.query(
            `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_persona_negocio_telefono
                ON platform.persona_negocio (id_negocio, telefono_e164)
                WHERE telefono_e164 IS NOT NULL;
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_persona_negocio_negocio
                ON platform.persona_negocio (id_negocio);
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_persona_negocio_persona
                ON platform.persona_negocio (id_persona) WHERE id_persona IS NOT NULL;
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON TABLE platform.persona_negocio IS
            'La relación de una persona con UN negocio. Es lo que las verticales referencian, '
            'siempre con FK nullable (ADR-006). id_persona permanece NULL hasta el Portal del Cliente.';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        await t.commit();
        console.log('✓ Esquema platform creado.\n');
        console.log('  persona y persona_identificador quedan VACÍAS a propósito (ADR-025).');
        console.log('  Siguiente paso de F0: pedid_orden.id_persona_negocio + backfill.\n');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
