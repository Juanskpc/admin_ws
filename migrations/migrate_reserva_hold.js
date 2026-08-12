/**
 * F3 — Reserva temporal (*hold*) con TTL en `reserva`.
 *
 * Ejecutar con:
 *   npm run migrate:reserva-hold
 *
 * ## Para qué
 *
 * Un *hold* es «este hueco es tuyo mientras terminamos de hablar». Existe porque
 * [ADR-010](../docs/adr/ADR-010-ejecucion-segura.md) exige que toda mutación siga
 * `propose → hold → confirm`: la capacidad primero **propone** (y bloquea el slot), la
 * propuesta se confirma con el cliente, y solo entonces se **confirma** la mutación.
 *
 * Sin él, una conversación de tres turnos calcula la disponibilidad al principio y crea la
 * cita al final; entre medias, la recepcionista pudo dar ese hueco desde el panel. El
 * asistente prometería una cita que ya no existe.
 *
 * Vive en el esquema `reserva` y no en `platform` porque es un concepto **de la vertical**:
 * una agenda con reservas temporales es útil aunque no exista ninguna IA — el propio
 * formulario web podría usarlo el día que quiera sostener el slot mientras el cliente sube
 * el comprobante de pago.
 *
 * ## El TTL no necesita cron
 *
 * Un hold expirado deja de contar en la comprobación de solape porque el predicado incluye
 * `expira_en > now()`. La agenda se libera sola, sin proceso de limpieza. Purgar filas
 * viejas es housekeeping opcional, no una condición de correctitud.
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();

    try {
        console.log('→ Migración F3: reserva.reserva_hold\n');

        const [tabla] = await sequelize.query(
            `SELECT 1 FROM information_schema.tables WHERE table_schema = 'reserva' AND table_name = 'reserva_cita';`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!tabla) {
            throw new Error('Falta el esquema de reserva. Ejecuta antes: npm run migrate:reserva');
        }

        console.log('1. Tabla reserva.reserva_hold...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS reserva.reserva_hold (
                id_hold           serial PRIMARY KEY,
                -- Identificador público del hold. Mismo patrón que reserva_cita.codigo_publico:
                -- el entero es interno y el uuid es lo que viaja por una conversación, para
                -- que nadie pueda adivinar el hold de otro cliente contando hacia arriba.
                codigo            uuid NOT NULL DEFAULT gen_random_uuid(),
                id_negocio        integer NOT NULL
                                  REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                id_profesional    integer NOT NULL
                                  REFERENCES reserva.reserva_profesional(id_profesional),
                -- Wall-time de Bogotá, igual que reserva_cita (ADR-024: las verticales
                -- conservan su convención; no se mezcla con el timestamptz de intelligence).
                fecha_hora_inicio timestamp NOT NULL,
                fecha_hora_fin    timestamp NOT NULL,
                expira_en         timestamptz NOT NULL,
                estado            varchar(20) NOT NULL DEFAULT 'activo',
                -- Qué cita acabó naciendo de este hold. Nullable: la mayoría expiran.
                id_cita           integer REFERENCES reserva.reserva_cita(id_cita) ON DELETE SET NULL,
                -- Con qué se pensaba llenar el hueco. Se guarda para que confirmar no
                -- dependa de que quien confirma recuerde los mismos servicios (ADR-010:
                -- «el contexto conversacional es una pista, nunca un hecho»).
                id_servicios      integer[] NOT NULL DEFAULT '{}',
                creado_en         timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT chk_hold_rango CHECK (fecha_hora_fin > fecha_hora_inicio),
                CONSTRAINT chk_hold_estado
                    CHECK (estado IN ('activo', 'confirmado', 'liberado')),
                CONSTRAINT uq_hold_codigo UNIQUE (codigo)
            );
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('2. Índice de la comprobación de solape...');
        // La consulta caliente es «holds vigentes de este profesional que tocan esta franja».
        // Índice parcial: los expirados y consumidos no estorban aunque la tabla crezca.
        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_hold_activos
                ON reserva.reserva_hold (id_profesional, fecha_hora_inicio, fecha_hora_fin)
                WHERE estado = 'activo';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('3. Comentarios...');
        await sequelize.query(
            `
            COMMENT ON TABLE reserva.reserva_hold IS
            'Reserva temporal de un hueco (ADR-010, propose→hold→confirm). Participa en la '
            'MISMA comprobación de solape que la creación de citas. Un hold con expira_en '
            'pasado deja de contar solo: no hay cron de limpieza y no hace falta.';
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON COLUMN reserva.reserva_hold.expira_en IS
            'TTL. Pasado este instante el hueco vuelve a estar libre sin que nadie borre la fila.';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        await t.commit();
        console.log('✓ reserva.reserva_hold creada.\n');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
