/**
 * Migración: Auditoría del vertical Restaurante — piloto (Hito 2)
 *
 * 1) Actualiza auditoria.fn_audit() a v2: en INSERT sin GUC de actor, cae a la
 *    columna `id_usuario` de la fila (creador del registro) — salvo cuando esa
 *    columna es la PK de la tabla (ej. gener_usuario: sería el usuario creado,
 *    no el actor). Cubre escrituras fuera de transacción (sin SET LOCAL).
 * 2) Suscribe las tablas con dinero/estado del esquema `restaurante`:
 *    rest_caja, rest_movimiento_caja, pedid_orden, carta_producto.
 * 3) Baseline 'B' de filas existentes. rest_movimiento_caja no tiene columna
 *    id_negocio: el tenant del baseline se resuelve con JOIN a rest_caja.
 *
 * Requiere: migrate:auditoria-base (Hito 0).
 * Idempotente. Ejecutar con: npm run migrate:auditoria-restaurante
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/**
 * Tablas a auditar.
 *  - pk: columna PK (TG_ARGV[0] del trigger).
 *  - tenantExpr: SQL para resolver id_negocio en el baseline (alias `t`).
 */
const TENANT_DEFAULT = `(to_jsonb(t) ->> 'id_negocio')::integer`;
const TABLAS = [
    { tabla: 'rest_caja',            pk: 'id_caja',       tenantExpr: TENANT_DEFAULT },
    { tabla: 'rest_movimiento_caja', pk: 'id_movimiento',
      tenantExpr: `(SELECT c.id_negocio FROM restaurante.rest_caja c WHERE c.id_caja = t.id_caja)` },
    { tabla: 'pedid_orden',          pk: 'id_orden',      tenantExpr: TENANT_DEFAULT },
    { tabla: 'carta_producto',       pk: 'id_producto',   tenantExpr: TENANT_DEFAULT },
];

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: Auditoría del vertical Restaurante (Hito 2)\n');

        // 0. Precondición: infraestructura del Hito 0
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

        // 1. fn_audit v2 — fallback de actor a la columna id_usuario de la fila en INSERT
        console.log('1. Actualizando auditoria.fn_audit() a v2...');
        await sequelize.query(`
            CREATE OR REPLACE FUNCTION auditoria.fn_audit() RETURNS trigger
            LANGUAGE plpgsql AS $fn$
            DECLARE
                v_old      jsonb;
                v_new      jsonb;
                v_antes    jsonb;
                v_despues  jsonb;
                v_usuario  integer;
                v_negocio  integer;
                v_pk       text;
                v_col      text;
            BEGIN
                v_old := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
                v_new := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;

                -- Nunca almacenar credenciales en la auditoría
                v_old := v_old - 'password';
                v_new := v_new - 'password';
                IF TG_NARGS > 1 AND COALESCE(TG_ARGV[1], '') <> '' THEN
                    FOREACH v_col IN ARRAY string_to_array(TG_ARGV[1], ',') LOOP
                        v_old := v_old - trim(v_col);
                        v_new := v_new - trim(v_col);
                    END LOOP;
                END IF;

                IF TG_OP = 'UPDATE' THEN
                    -- Delta: solo los campos que realmente cambiaron
                    SELECT jsonb_object_agg(n.key, n.value),
                           jsonb_object_agg(n.key, v_old -> n.key)
                      INTO v_despues, v_antes
                      FROM jsonb_each(v_new) n
                     WHERE v_old -> n.key IS DISTINCT FROM n.value;
                    IF v_despues IS NULL THEN
                        RETURN NULL; -- UPDATE sin cambios reales: no auditar
                    END IF;
                ELSE
                    v_antes   := v_old;
                    v_despues := v_new;
                END IF;

                -- Actor: GUC fijada por transacción desde el backend (puede no existir)
                v_usuario := NULLIF(current_setting('app.id_usuario', true), '')::integer;

                -- v2: en INSERT sin GUC (escritura fuera de transacción), la columna
                -- id_usuario de la fila es el creador → actor. NO aplica cuando
                -- id_usuario es la PK de la tabla (sería el registro, no el actor).
                IF v_usuario IS NULL AND TG_OP = 'INSERT'
                   AND COALESCE(TG_ARGV[0], '') <> 'id_usuario' THEN
                    v_usuario := (v_new ->> 'id_usuario')::integer;
                END IF;

                -- Tenant: columna id_negocio de la fila; fallback a la GUC
                v_negocio := COALESCE(
                    (COALESCE(v_new, v_old) ->> 'id_negocio')::integer,
                    NULLIF(current_setting('app.id_negocio', true), '')::integer
                );

                IF TG_NARGS > 0 AND COALESCE(TG_ARGV[0], '') <> '' THEN
                    v_pk := COALESCE(v_new ->> TG_ARGV[0], v_old ->> TG_ARGV[0]);
                END IF;

                INSERT INTO auditoria.audit_dato
                    (esquema, tabla, operacion, id_negocio, id_usuario, pk_registro, datos_antes, datos_despues)
                VALUES
                    (TG_TABLE_SCHEMA, TG_TABLE_NAME, LEFT(TG_OP, 1),
                     v_negocio, v_usuario, v_pk, v_antes, v_despues);

                RETURN NULL;
            EXCEPTION WHEN OTHERS THEN
                -- Política: un fallo de auditoría NO tumba la operación de negocio
                RAISE WARNING 'auditoria.fn_audit falló en %.%: %',
                    TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLERRM;
                RETURN NULL;
            END
            $fn$;
        `, { transaction: t });

        // 2. Triggers + baseline por tabla
        for (const { tabla, pk, tenantExpr } of TABLAS) {
            console.log(`• restaurante.${tabla} (pk: ${pk})`);

            const [[existe]] = await sequelize.query(
                `SELECT EXISTS (
                     SELECT 1 FROM information_schema.tables
                      WHERE table_schema = 'restaurante' AND table_name = :tabla
                 ) AS ok;`,
                { replacements: { tabla }, transaction: t }
            );
            if (!existe.ok) {
                console.log(`  ⚠️  No existe en la BD — omitida.`);
                continue;
            }

            await sequelize.query(
                `DROP TRIGGER IF EXISTS trg_audit ON restaurante.${tabla};`,
                { transaction: t }
            );
            await sequelize.query(
                `CREATE TRIGGER trg_audit
                     AFTER INSERT OR UPDATE OR DELETE ON restaurante.${tabla}
                     FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('${pk}');`,
                { transaction: t }
            );
            console.log('  ✓ trigger trg_audit');

            await sequelize.query(
                `INSERT INTO auditoria.audit_dato
                     (esquema, tabla, operacion, id_negocio, id_usuario, pk_registro, datos_despues)
                 SELECT 'restaurante', '${tabla}', 'B',
                        ${tenantExpr},
                        NULL,
                        to_jsonb(t) ->> '${pk}',
                        to_jsonb(t) - 'password'
                   FROM restaurante.${tabla} t
                  WHERE NOT EXISTS (
                        SELECT 1 FROM auditoria.audit_dato d
                         WHERE d.esquema = 'restaurante'
                           AND d.tabla = '${tabla}'
                           AND d.operacion = 'B'
                  );`,
                { transaction: t }
            );
            // El rowCount de INSERT...SELECT no es confiable en sequelize.query:
            // contar directo (ver memoria del Hito 1).
            const [[{ n }]] = await sequelize.query(
                `SELECT count(*)::int AS n FROM auditoria.audit_dato
                  WHERE esquema = 'restaurante' AND tabla = :tabla AND operacion = 'B';`,
                { replacements: { tabla }, transaction: t }
            );
            console.log(`  ✓ baseline: ${n} filas`);
        }

        await t.commit();
        console.log('\n✅ Auditoría del vertical Restaurante activa (triggers + baseline).');
    } catch (error) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
