/**
 * F1 — Outbox transaccional en `platform` (ADR-012).
 *
 * Ejecutar con:
 *   npm run migrate:platform-outbox
 *
 * El evento se escribe en la MISMA transacción que la mutación de dominio, así que existe
 * si y solo si esa transacción confirmó: sin dual-write, sin eventos perdidos. Un relay lo
 * drena después, de forma asíncrona.
 *
 * Vive en `platform` y NO en `intelligence` — la distinción es la razón de ser del ADR: si
 * viviera en `intelligence`, una vertical tendría que escribir en el esquema de la IA para
 * emitir un evento, y la IA se volvería dependencia obligatoria del dominio (ADR-005).
 *
 * El outbox es una primitiva de plataforma, no de IA: sirve igual a notificaciones, CRM,
 * analítica y auditoría. La IA será solo uno más de sus consumidores.
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();

    try {
        console.log('→ Migración F1: platform.outbox\n');

        const [schema] = await sequelize.query(
            `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'platform';`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!schema) {
            throw new Error('Falta el esquema platform. Ejecuta antes: npm run migrate:platform-persona');
        }

        console.log('1. Tabla platform.outbox...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS platform.outbox (
                id_evento           uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
                tipo                varchar(100) NOT NULL,
                id_negocio          integer NOT NULL
                                    REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                ocurrido_en         timestamptz NOT NULL DEFAULT now(),
                payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
                estado              varchar(20) NOT NULL DEFAULT 'pendiente',
                intentos            integer NOT NULL DEFAULT 0,
                proximo_intento_en  timestamptz NOT NULL DEFAULT now(),
                ultimo_error        text,
                entregado_en        timestamptz,
                creado_en           timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT chk_outbox_estado
                    CHECK (estado IN ('pendiente', 'entregado', 'fallido')),
                -- La convención de nombres de ADR-013 (<agregado>.<hecho_pasado>.v<n>, en
                -- español y minúsculas) se hace cumplir en la base, no en el formulario.
                -- Un evento mal nombrado es un contrato roto para siempre: mejor que no entre.
                CONSTRAINT chk_outbox_tipo
                    CHECK (tipo ~ '^[a-z_]+\\.[a-z_]+\\.v[0-9]+$')
            );
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('2. Índice de sondeo del relay...');
        // La única consulta caliente: "dame los pendientes que ya toca reintentar".
        // Índice parcial: los entregados no estorban aunque la tabla crezca.
        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_outbox_pendientes
                ON platform.outbox (proximo_intento_en)
                WHERE estado = 'pendiente';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('3. Comentarios...');
        await sequelize.query(
            `
            COMMENT ON TABLE platform.outbox IS
            'Outbox transaccional de eventos de dominio (ADR-012). Se escribe en la misma '
            'transacción que la mutación que lo origina. Entrega AL MENOS UNA VEZ: los '
            'consumidores DEBEN ser idempotentes.';
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON COLUMN platform.outbox.tipo IS
            'Nombre del evento según ADR-013: <agregado>.<hecho_pasado>.v<n>, en español.';
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON COLUMN platform.outbox.estado IS
            'pendiente = por entregar · entregado = confirmado por todos los consumidores · '
            'fallido = agotó los reintentos (dead letter, requiere intervención).';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        await t.commit();
        console.log('✓ Outbox creado.\n');
        console.log('  Ninguna vertical emite todavía: un evento se define cuando hay');
        console.log('  productor Y consumidor (ADR-013, regla 4). Los primeros llegan en F4/F5.\n');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
