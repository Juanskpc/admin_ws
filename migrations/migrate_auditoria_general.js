/**
 * Migración: Auditoría de configuración/seguridad — esquema general (Hito 1)
 *
 * 1) Suscribe a auditoria.fn_audit() las tablas críticas del esquema `general`
 *    (usuarios, roles, negocios, planes y sus asignaciones).
 * 2) Inserta un snapshot BASELINE (operacion 'B') de las filas existentes de
 *    cada tabla — estado de partida verificable de los registros actuales.
 *    El baseline se inserta UNA sola vez por tabla (guarda NOT EXISTS).
 *
 * Requiere: npm run migrate:auditoria-base (Hito 0) ejecutado previamente.
 *
 * La columna `password` queda excluida de snapshots y deltas (fn_audit la
 * elimina siempre; el baseline la resta explícitamente también).
 *
 * Idempotente: DROP TRIGGER IF EXISTS + CREATE, baseline con NOT EXISTS.
 * Ejecutar con: npm run migrate:auditoria-general
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/** Tablas a auditar: { tabla, pk } — TG_ARGV[0] = columna PK para pk_registro. */
const TABLAS = [
    { tabla: 'gener_usuario',         pk: 'id_usuario' },
    { tabla: 'gener_rol',             pk: 'id_rol' },
    { tabla: 'gener_usuario_rol',     pk: 'id_usuario_rol' },
    { tabla: 'gener_negocio',         pk: 'id_negocio' },
    { tabla: 'gener_negocio_usuario', pk: 'id_negocio_usuario' },
    { tabla: 'gener_negocio_plan',    pk: 'id_negocio_plan' },
    { tabla: 'gener_plan',            pk: 'id_plan' },
];

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: Auditoría del esquema general (Hito 1)\n');

        // 0. Precondición: la infraestructura del Hito 0 debe existir
        const [[infra]] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'auditoria' AND table_name = 'audit_dato'
             ) AS ok;`,
            { transaction: t }
        );
        if (!infra.ok) {
            throw new Error('Falta la infraestructura de auditoría. Ejecute primero: npm run migrate:auditoria-base');
        }

        for (const { tabla, pk } of TABLAS) {
            console.log(`• general.${tabla} (pk: ${pk})`);

            // 1. Verificar que la tabla existe antes de tocarla
            const [[existe]] = await sequelize.query(
                `SELECT EXISTS (
                     SELECT 1 FROM information_schema.tables
                      WHERE table_schema = 'general' AND table_name = :tabla
                 ) AS ok;`,
                { replacements: { tabla }, transaction: t }
            );
            if (!existe.ok) {
                console.log(`  ⚠️  No existe en la BD — omitida.`);
                continue;
            }

            // 2. Trigger de auditoría (idempotente: drop + create)
            await sequelize.query(
                `DROP TRIGGER IF EXISTS trg_audit ON general.${tabla};`,
                { transaction: t }
            );
            await sequelize.query(
                `CREATE TRIGGER trg_audit
                     AFTER INSERT OR UPDATE OR DELETE ON general.${tabla}
                     FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('${pk}');`,
                { transaction: t }
            );
            console.log('  ✓ trigger trg_audit');

            // 3. Baseline de filas existentes (solo si nunca se tomó para esta tabla)
            const [, meta] = await sequelize.query(
                `INSERT INTO auditoria.audit_dato
                     (esquema, tabla, operacion, id_negocio, id_usuario, pk_registro, datos_despues)
                 SELECT 'general', '${tabla}', 'B',
                        (to_jsonb(t) ->> 'id_negocio')::integer,
                        NULL,
                        to_jsonb(t) ->> '${pk}',
                        to_jsonb(t) - 'password'
                   FROM general.${tabla} t
                  WHERE NOT EXISTS (
                        SELECT 1 FROM auditoria.audit_dato d
                         WHERE d.esquema = 'general'
                           AND d.tabla = '${tabla}'
                           AND d.operacion = 'B'
                  );`,
                { transaction: t }
            );
            console.log(`  ✓ baseline: ${meta?.rowCount ?? 0} filas`);
        }

        await t.commit();
        console.log('\n✅ Auditoría del esquema general activa (triggers + baseline).');
    } catch (error) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
