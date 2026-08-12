/**
 * F4-A — Habilitación de capacidades por inquilino (ADR-007, ADR-008, ADR-021).
 *
 * Ejecutar con:
 *   npm run migrate:platform-capacidades
 *
 * ## Qué se guarda aquí y qué NO
 *
 * La **declaración** de una capacidad (parámetros, tipo, idempotencia, feature que exige)
 * es **código**: vive en el manifiesto del adaptador y cambia cuando cambia el código, no
 * cuando cambia un inquilino. Guardarla en una tabla sería configuración que nadie edita.
 *
 * Lo que sí es dato por inquilino, y por tanto vive aquí, es **la habilitación**: qué
 * capacidades puede ejecutar el asistente de ESTE negocio. Es la capa de dominio del
 * Policy Gate (ADR-021: comercial → dominio → económica).
 *
 * ## Por qué no hay fila = denegado
 *
 * Ésta es la superficie de acción de un agente no determinista expuesto a internet
 * (ADR-007). Un default permisivo significaría que una capacidad nueva queda activa en
 * todos los inquilinos el día que se despliega, sin que nadie lo decida. La ausencia de
 * fila es una decisión no tomada, y una decisión no tomada no autoriza nada.
 *
 * ## Lo que esta migración NO crea, a propósito
 *
 * - `platform.business_policy` (límites económicos, ADR-011): ADR-011 dice que se empieza
 *   con 3–4 límites que **una capacidad real** aplique. F4-A solo tiene capacidades de
 *   consulta, que no aplican ninguno. Sin consumidor, no se crea (test de simplicidad).
 * - `platform.capacidad_idempotencia`: la clave de idempotencia protege mutaciones. F4-A
 *   no tiene ninguna. Llega con F4-B.
 * - Tabla de features: ADR-021 autoriza explícitamente empezar con el mapeo plan→features
 *   más simple posible. Hoy es una constante en `intelligence/core/features.js`.
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();

    try {
        console.log('→ Migración F4-A: habilitación de capacidades\n');

        const [schema] = await sequelize.query(
            `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'platform';`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!schema) {
            throw new Error('Falta el esquema platform. Ejecuta antes: npm run migrate:platform-persona');
        }

        console.log('1. Tabla platform.capacidad_habilitada...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS platform.capacidad_habilitada (
                id_negocio    integer NOT NULL
                              REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                -- Nombre de la capacidad tal como la declara su manifiesto. NO hay FK a un
                -- catálogo en base: el catálogo es el código. Si una capacidad se retira,
                -- su fila aquí queda huérfana y el Registry simplemente no la encuentra:
                -- deniega, que es el fallo seguro.
                capacidad     varchar(80) NOT NULL,
                habilitada    boolean NOT NULL DEFAULT true,
                habilitada_en timestamptz NOT NULL DEFAULT now(),
                -- Quién la habilitó. Nullable porque hoy la habilita un script de desarrollo,
                -- no una persona por pantalla.
                habilitada_por integer
                              REFERENCES general.gener_usuario(id_usuario) ON DELETE SET NULL,
                PRIMARY KEY (id_negocio, capacidad),
                -- Espejo de la convención de nombres del metamodelo (capability-language.md
                -- §1): verbo de negocio en español y minúsculas. Se hace cumplir en la base
                -- para que un typo no cree una habilitación fantasma que nunca casa.
                CONSTRAINT chk_capacidad_nombre
                    CHECK (capacidad ~ '^[a-z][a-z0-9_]*$')
            );
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('2. Índice de consulta del Policy Gate...');
        // La consulta caliente del Gate es "¿este negocio tiene habilitada X?", que ya
        // resuelve la PK. Este índice parcial sirve a la otra pregunta, la de la pantalla
        // de administración: "¿qué tiene habilitado este negocio?".
        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_capacidad_habilitada_negocio
                ON platform.capacidad_habilitada (id_negocio)
                WHERE habilitada;
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('3. Comentarios...');
        await sequelize.query(
            `
            COMMENT ON TABLE platform.capacidad_habilitada IS
            'Capa de DOMINIO del Policy Gate (ADR-021): qué capacidades puede ejecutar el '
            'asistente de cada negocio. La ausencia de fila DENIEGA. La declaración de la '
            'capacidad (parámetros, tipo) vive en el código, no aquí.';
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON COLUMN platform.capacidad_habilitada.capacidad IS
            'Nombre declarado en el manifiesto del adaptador (capability-language.md §1). '
            'Sin FK: el catálogo es el código.';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        await t.commit();
        console.log('✓ Habilitación de capacidades creada.\n');
        console.log('  Tabla vacía a propósito: sin fila, el Policy Gate deniega.');
        console.log('  Para habilitar en local: node scripts/capacidad.js habilitar <capacidad> --negocio <id>\n');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
