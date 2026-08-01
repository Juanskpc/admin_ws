/**
 * F0 — pasos 2 y 3: enlaza `restaurante` con `platform.persona_negocio`.
 *
 * Ejecutar con:
 *   npm run migrate:platform-backfill-restaurante
 *
 * Hace dos cosas, en una sola transacción:
 *   2) Añade `restaurante.pedid_orden.id_persona_negocio` — FK NULLABLE (ADR-006). Es un
 *      cambio estrictamente aditivo: `restaurante` es Grupo 1 y está en producción
 *      (ADR-003, freeze §C.8). No se toca ninguna columna existente.
 *   3) Backfill: crea una `persona_negocio` por cada (negocio, móvil) distinto y enlaza las
 *      órdenes históricas.
 *
 * Reglas del backfill (ver mediciones/2026-07-31-calidad-telefonos-restaurante.md):
 *   - Solo se migran **móviles colombianos válidos** (10 dígitos, empieza en 3). El 5.2%
 *     restante —demasiado cortos, basura, fijos— se deja SIN enlazar, con
 *     `id_persona_negocio = NULL`. Para eso la FK es nullable: no se inventa identidad.
 *   - `nombre_mostrado` = nombre de la **orden más reciente** de ese teléfono. El 20.3% de
 *     los móviles tiene 2+ nombres distintos porque el nombre vive en la orden y no en una
 *     entidad cliente; se elige la intención más fresca, no la más frecuente.
 *   - La unicidad es por `(id_negocio, telefono_e164)` y **jamás cruza inquilinos** (ADR-025).
 *
 * Es idempotente: re-ejecutarla no duplica personas ni cambia enlaces ya correctos.
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/**
 * Misma normalización que scripts/medir_calidad_telefonos.js. Si una cambia, la otra
 * también: son la misma definición de "qué es un teléfono utilizable".
 */
const SQL_CANDIDATOS = `
CREATE TEMP TABLE tmp_backfill_movil ON COMMIT DROP AS
WITH base AS (
    SELECT
        o.id_orden,
        o.id_negocio,
        o.fecha_creacion,
        NULLIF(BTRIM(COALESCE(o.contacto_nombre, '')), '') AS nombre,
        NULLIF(regexp_replace(COALESCE(o.contacto_telefono, ''), '[^0-9]', '', 'g'), '') AS digitos
    FROM restaurante.pedid_orden o
),
norm AS (
    SELECT
        b.*,
        CASE
            WHEN b.digitos IS NULL THEN NULL
            WHEN length(b.digitos) = 12 AND left(b.digitos, 2) = '57' THEN right(b.digitos, 10)
            WHEN length(b.digitos) = 11 AND left(b.digitos, 1) = '0'  THEN right(b.digitos, 10)
            ELSE b.digitos
        END AS nacional
    FROM base b
)
SELECT
    n.id_orden,
    n.id_negocio,
    n.fecha_creacion,
    n.nombre,
    '+57' || n.nacional AS telefono_e164
FROM norm n
WHERE n.nacional IS NOT NULL
  AND length(n.nacional) = 10
  AND left(n.nacional, 1) = '3'
  AND n.nacional !~ '^(.)\\1+$';
`;

async function migrate() {
    const t = await sequelize.transaction();

    try {
        console.log('→ Migración F0 (pasos 2 y 3): pedid_orden ↔ platform.persona_negocio\n');

        console.log('1. Columna pedid_orden.id_persona_negocio (aditiva, nullable)...');
        await sequelize.query(
            `
            ALTER TABLE restaurante.pedid_orden
                ADD COLUMN IF NOT EXISTS id_persona_negocio uuid;
            `,
            { transaction: t }
        );

        const [fk] = await sequelize.query(
            `
            SELECT 1 FROM pg_constraint
             WHERE conname = 'fk_pedid_orden_persona_negocio'
               AND conrelid = 'restaurante.pedid_orden'::regclass;
            `,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!fk) {
            // ON DELETE SET NULL: borrar una persona_negocio jamás puede borrar una orden.
            await sequelize.query(
                `
                ALTER TABLE restaurante.pedid_orden
                    ADD CONSTRAINT fk_pedid_orden_persona_negocio
                    FOREIGN KEY (id_persona_negocio)
                    REFERENCES platform.persona_negocio(id_persona_negocio)
                    ON DELETE SET NULL;
                `,
                { transaction: t }
            );
            console.log('   FK creada.');
        } else {
            console.log('   FK ya existía.');
        }

        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_pedid_orden_persona_negocio
                ON restaurante.pedid_orden (id_persona_negocio)
                WHERE id_persona_negocio IS NOT NULL;
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('2. Identificando móviles válidos en las órdenes...');
        await sequelize.query(SQL_CANDIDATOS, { transaction: t });
        const [cand] = await sequelize.query(
            `SELECT count(*) AS ordenes, count(DISTINCT (id_negocio, telefono_e164)) AS personas
               FROM tmp_backfill_movil;`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        console.log(`   ${cand.ordenes} órdenes con móvil válido → ${cand.personas} personas.\n`);

        console.log('3. Creando persona_negocio (nombre = el de la orden más reciente)...');
        await sequelize.query(
            `
            INSERT INTO platform.persona_negocio (id_negocio, telefono_e164, nombre_mostrado)
            SELECT DISTINCT ON (id_negocio, telefono_e164)
                   id_negocio, telefono_e164, nombre
              FROM tmp_backfill_movil
             ORDER BY id_negocio, telefono_e164, fecha_creacion DESC
            ON CONFLICT (id_negocio, telefono_e164) WHERE telefono_e164 IS NOT NULL
            DO NOTHING;
            `,
            { transaction: t }
        );
        const [creadas] = await sequelize.query(
            `SELECT count(*) AS n FROM platform.persona_negocio;`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        console.log(`   platform.persona_negocio: ${creadas.n} filas.\n`);

        console.log('4. Enlazando órdenes históricas...');
        const [, meta] = await sequelize.query(
            `
            UPDATE restaurante.pedid_orden o
               SET id_persona_negocio = pn.id_persona_negocio
              FROM tmp_backfill_movil m
              JOIN platform.persona_negocio pn
                ON pn.id_negocio    = m.id_negocio
               AND pn.telefono_e164 = m.telefono_e164
             WHERE o.id_orden = m.id_orden
               AND o.id_persona_negocio IS DISTINCT FROM pn.id_persona_negocio;
            `,
            { transaction: t }
        );
        console.log(`   ${meta?.rowCount ?? 0} órdenes enlazadas.\n`);

        console.log('5. Resumen final...');
        const [resumen] = await sequelize.query(
            `
            SELECT
                count(*)                                                AS ordenes_total,
                count(*) FILTER (WHERE id_persona_negocio IS NOT NULL)  AS enlazadas,
                count(*) FILTER (WHERE id_persona_negocio IS NULL
                                   AND NULLIF(BTRIM(COALESCE(contacto_telefono,'')),'') IS NOT NULL)
                                                                        AS con_telefono_sin_enlazar
              FROM restaurante.pedid_orden;
            `,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        console.log(`   Órdenes totales:              ${resumen.ordenes_total}`);
        console.log(`   Enlazadas a persona_negocio:  ${resumen.enlazadas}`);
        console.log(`   Con teléfono pero sin enlazar: ${resumen.con_telefono_sin_enlazar}  (teléfono no utilizable — esperado)`);

        await t.commit();
        console.log('\n✓ Backfill completado.\n');
        console.log('  Siguiente paso de F0: camino de escritura (resolver-o-crear al crear la orden).\n');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
