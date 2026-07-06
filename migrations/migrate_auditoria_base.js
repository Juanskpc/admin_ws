/**
 * Migración: Infraestructura base de auditoría (Hito 0)
 *
 * Crea el esquema `auditoria` con:
 *   auditoria.audit_dato    → auditoría de datos (triggers I/U/D + baseline), particionada por mes
 *   auditoria.audit_evento  → auditoría de eventos de aplicación (login, OTP, etc.), particionada por mes
 *   auditoria.fn_audit()    → función trigger genérica (se suscribe por tabla en hitos posteriores)
 *   auditoria.fn_asegurar_particiones(n)          → crea particiones mensuales (mes actual + n adelante)
 *   auditoria.fn_aplicar_retencion(total, negocio) → borra particiones/filas vencidas
 *
 * IMPORTANTE: esta migración NO activa ningún trigger. Solo prepara la
 * infraestructura; las tablas se suscriben en migraciones posteriores
 * (migrate:auditoria-general, migrate:auditoria-<vertical>).
 *
 * Convenciones:
 *   - `fecha` es hora de pared Bogotá (timestamp without time zone), anclada
 *     explícitamente con `now() AT TIME ZONE 'America/Bogota'` para no depender
 *     de la TZ de la sesión.
 *   - El actor se lee de las GUC `app.id_usuario` / `app.id_negocio` fijadas
 *     por transacción desde conection.js (set_config(..., is_local=true)).
 *   - fn_audit() es DEFENSIVA: si el registro de auditoría falla, emite WARNING
 *     y NO tumba la operación de negocio.
 *
 * Idempotente. Ejecutar con: npm run migrate:auditoria-base
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: Infraestructura base de auditoría (Hito 0)\n');

        // 1. Esquema auditoria
        console.log('1. Creando esquema auditoria...');
        await sequelize.query(`CREATE SCHEMA IF NOT EXISTS auditoria;`, { transaction: t });

        // 2. Tabla de auditoría de datos (particionada por mes)
        console.log('2. Creando tabla auditoria.audit_dato (particionada)...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS auditoria.audit_dato (
                id_audit       BIGSERIAL,
                fecha          TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'America/Bogota'),
                esquema        VARCHAR(30)  NOT NULL,
                tabla          VARCHAR(63)  NOT NULL,
                operacion      CHAR(1)      NOT NULL CHECK (operacion IN ('I', 'U', 'D', 'B')),
                id_negocio     INTEGER      NULL,
                id_usuario     INTEGER      NULL,
                pk_registro    TEXT         NULL,
                datos_antes    JSONB        NULL,
                datos_despues  JSONB        NULL,
                PRIMARY KEY (id_audit, fecha)
            ) PARTITION BY RANGE (fecha);
        `, { transaction: t });

        // Partición DEFAULT: red de seguridad si el cron de particiones no corrió.
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS auditoria.audit_dato_default
                PARTITION OF auditoria.audit_dato DEFAULT;
        `, { transaction: t });

        // 3. Tabla de auditoría de eventos de aplicación (particionada por mes)
        console.log('3. Creando tabla auditoria.audit_evento (particionada)...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS auditoria.audit_evento (
                id_evento      BIGSERIAL,
                fecha          TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'America/Bogota'),
                modulo         VARCHAR(40)  NOT NULL,
                accion         VARCHAR(60)  NOT NULL,
                resultado      VARCHAR(20)  NOT NULL DEFAULT 'ok',
                id_negocio     INTEGER      NULL,
                id_usuario     INTEGER      NULL,
                ip             VARCHAR(45)  NULL,
                detalle        JSONB        NULL,
                PRIMARY KEY (id_evento, fecha)
            ) PARTITION BY RANGE (fecha);
        `, { transaction: t });

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS auditoria.audit_evento_default
                PARTITION OF auditoria.audit_evento DEFAULT;
        `, { transaction: t });

        // 4. Índices (sobre el padre: se propagan a particiones existentes y futuras)
        console.log('4. Creando índices...');
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_audit_dato_negocio_fecha
                ON auditoria.audit_dato (id_negocio, fecha);
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_audit_dato_tabla_fecha
                ON auditoria.audit_dato (esquema, tabla, fecha);
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_audit_dato_usuario_fecha
                ON auditoria.audit_dato (id_usuario, fecha);
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_audit_evento_negocio_fecha
                ON auditoria.audit_evento (id_negocio, fecha);
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_audit_evento_modulo_fecha
                ON auditoria.audit_evento (modulo, accion, fecha);
        `, { transaction: t });

        // 5. Función trigger genérica
        //    Uso al suscribir una tabla (hitos posteriores):
        //      CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE
        //        ON <esquema>.<tabla> FOR EACH ROW
        //        EXECUTE FUNCTION auditoria.fn_audit('<col_pk>' [, '<cols_sensibles_csv>']);
        //    TG_ARGV[0] = nombre de la columna PK (opcional, para pk_registro)
        //    TG_ARGV[1] = columnas sensibles extra a excluir, separadas por coma (opcional)
        //    La columna `password` SIEMPRE se excluye del snapshot.
        console.log('5. Creando función auditoria.fn_audit()...');
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

        // 6. Función de mantenimiento de particiones
        console.log('6. Creando función auditoria.fn_asegurar_particiones()...');
        await sequelize.query(`
            CREATE OR REPLACE FUNCTION auditoria.fn_asegurar_particiones(p_meses_adelante integer DEFAULT 1)
            RETURNS void LANGUAGE plpgsql AS $fn$
            DECLARE
                v_base   date := date_trunc('month', (now() AT TIME ZONE 'America/Bogota'))::date;
                v_ini    date;
                v_fin    date;
                v_sufijo text;
                v_tabla  text;
            BEGIN
                FOR i IN 0..p_meses_adelante LOOP
                    v_ini    := (v_base + (i * interval '1 month'))::date;
                    v_fin    := (v_base + ((i + 1) * interval '1 month'))::date;
                    v_sufijo := to_char(v_ini, 'YYYY_MM');
                    FOREACH v_tabla IN ARRAY ARRAY['audit_dato', 'audit_evento'] LOOP
                        BEGIN
                            EXECUTE format(
                                'CREATE TABLE IF NOT EXISTS auditoria.%I PARTITION OF auditoria.%I FOR VALUES FROM (%L) TO (%L)',
                                v_tabla || '_' || v_sufijo, v_tabla, v_ini, v_fin
                            );
                        EXCEPTION WHEN OTHERS THEN
                            -- Si la partición DEFAULT ya contiene filas de este rango,
                            -- CREATE PARTITION falla: avisar sin abortar el resto.
                            RAISE WARNING 'No se pudo crear partición %_%: %', v_tabla, v_sufijo, SQLERRM;
                        END;
                    END LOOP;
                END LOOP;
            END
            $fn$;
        `, { transaction: t });

        // 7. Función de retención
        //    - Filas de esquemas de negocio (≠ general) más viejas que p_meses_negocio → DELETE
        //    - Particiones completas más viejas que p_meses_total → DROP (instantáneo)
        console.log('7. Creando función auditoria.fn_aplicar_retencion()...');
        await sequelize.query(`
            CREATE OR REPLACE FUNCTION auditoria.fn_aplicar_retencion(
                p_meses_total   integer DEFAULT 24,
                p_meses_negocio integer DEFAULT 6
            ) RETURNS text LANGUAGE plpgsql AS $fn$
            DECLARE
                v_hoy          date := date_trunc('month', (now() AT TIME ZONE 'America/Bogota'))::date;
                v_corte_total  date := (v_hoy - (p_meses_total   * interval '1 month'))::date;
                v_corte_neg    date := (v_hoy - (p_meses_negocio * interval '1 month'))::date;
                v_part         record;
                v_mes          date;
                v_borradas     bigint := 0;
                v_dropped      integer := 0;
                v_tmp          bigint;
            BEGIN
                -- Purga de filas de esquemas de negocio (particiones viejas via pruning)
                DELETE FROM auditoria.audit_dato
                 WHERE fecha < v_corte_neg
                   AND esquema <> 'general';
                GET DIAGNOSTICS v_tmp = ROW_COUNT;
                v_borradas := v_tmp;

                -- Drop de particiones mensuales completas más viejas que el corte total
                FOR v_part IN
                    SELECT c.relname
                      FROM pg_inherits i
                      JOIN pg_class c ON c.oid = i.inhrelid
                      JOIN pg_class p ON p.oid = i.inhparent
                      JOIN pg_namespace n ON n.oid = p.relnamespace
                     WHERE n.nspname = 'auditoria'
                       AND p.relname IN ('audit_dato', 'audit_evento')
                       AND c.relname ~ '_[0-9]{4}_[0-9]{2}$'
                LOOP
                    v_mes := to_date(right(v_part.relname, 7), 'YYYY_MM');
                    IF v_mes < date_trunc('month', v_corte_total)::date THEN
                        EXECUTE format('DROP TABLE IF EXISTS auditoria.%I', v_part.relname);
                        v_dropped := v_dropped + 1;
                    END IF;
                END LOOP;

                RETURN format('retencion: %s filas de negocio purgadas, %s particiones eliminadas',
                              v_borradas, v_dropped);
            END
            $fn$;
        `, { transaction: t });

        // 8. Crear particiones iniciales (mes actual + siguiente)
        console.log('8. Creando particiones iniciales (mes actual + siguiente)...');
        await sequelize.query(`SELECT auditoria.fn_asegurar_particiones(1);`, { transaction: t });

        await t.commit();
        console.log('\n✅ Migración de infraestructura de auditoría completada.');
        console.log('   Recuerde: ningún trigger está activo todavía; las tablas se');
        console.log('   suscriben en migraciones posteriores (migrate:auditoria-general, ...).');
    } catch (error) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
