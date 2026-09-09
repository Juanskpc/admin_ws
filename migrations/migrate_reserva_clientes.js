/**
 * Clientes de `reserva`: enlaza las citas con `platform.persona_negocio` y publica la vista.
 *
 *   npm run migrate:reserva-clientes
 *
 * ## Por qué NO se crea una tabla `reserva_cliente`
 *
 * La base de clientes con el teléfono como llave **ya existe**: es `platform.persona_negocio`,
 * con `UNIQUE (id_negocio, telefono_e164)` y su `nombre_mostrado`. La decidió ADR-006 y la fijó
 * ADR-025 —«unicidad por (negocio, teléfono), jamás cruza inquilinos»— y `restaurante` ya la usa
 * desde F0. Crear aquí una segunda tabla de clientes con teléfono único dejaría al mismo cliente
 * partido en dos ficheros que nadie volvería a reconciliar, y rompería el invariante de que la
 * identidad de un negocio es una sola.
 *
 * Lo que faltaba era exactamente lo que este archivo hace, y estaba anotado como pendiente en
 * `intelligence/adapters/reserva/index.js`: `reserva_cita.id_persona_negocio`.
 *
 * ## Qué hace, en una sola transacción
 *
 * 1. Añade `reserva.reserva_cita.id_persona_negocio` — FK **nullable** (ADR-006: una vertical
 *    funciona sin persona) con `ON DELETE SET NULL`: borrar un cliente jamás borra una cita.
 * 2. Backfill de las citas históricas, con las mismas reglas que el de `restaurante`: solo
 *    móviles colombianos válidos, y `nombre_mostrado` = el de la cita **más reciente**.
 * 3. Registra la vista `/clientes` en el catálogo de permisos del vertical y se la concede a
 *    ADMINISTRADOR y RECEPCIONISTA (a PROFESIONAL no: ve su agenda, no la cartera del negocio).
 *
 * Idempotente: re-ejecutarla no duplica personas, no repite enlaces ni vuelve a insertar la vista.
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

/**
 * Los mismos criterios que `migrate_platform_backfill_restaurante.js` y
 * `app_core/helpers/telefono.js`. Si cambia uno, cambian los tres: son la definición de
 * "qué es un teléfono utilizable".
 */
const SQL_CANDIDATOS = `
CREATE TEMP TABLE tmp_backfill_citas ON COMMIT DROP AS
WITH base AS (
    SELECT
        c.id_cita,
        c.id_negocio,
        c.fecha_creacion,
        NULLIF(BTRIM(COALESCE(c.cliente_nombre, '')), '')                            AS nombre,
        NULLIF(regexp_replace(COALESCE(c.cliente_telefono, ''), '[^0-9]', '', 'g'), '') AS digitos
    FROM reserva.reserva_cita c
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
    n.id_cita,
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
        console.log('\n=== Migración: clientes de reserva ↔ platform.persona_negocio ===\n');

        // Sin el esquema `platform` esto no tiene dónde apoyarse. Se comprueba antes de
        // tocar nada para que el error diga qué falta y no un "relation does not exist".
        const [platform] = await sequelize.query(
            `SELECT to_regclass('platform.persona_negocio') AS tabla;`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!platform?.tabla) {
            throw new Error(
                'Falta platform.persona_negocio. Ejecuta antes: npm run migrate:platform-persona'
            );
        }

        // ── 1. Columna ────────────────────────────────────────────────
        console.log('1. Columna reserva_cita.id_persona_negocio (aditiva, nullable)...');
        await sequelize.query(
            `ALTER TABLE reserva.reserva_cita
                ADD COLUMN IF NOT EXISTS id_persona_negocio uuid;`,
            { transaction: t }
        );

        const [fk] = await sequelize.query(
            `SELECT 1 FROM pg_constraint
              WHERE conname = 'fk_reserva_cita_persona_negocio'
                AND conrelid = 'reserva.reserva_cita'::regclass;`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!fk) {
            await sequelize.query(
                `ALTER TABLE reserva.reserva_cita
                    ADD CONSTRAINT fk_reserva_cita_persona_negocio
                    FOREIGN KEY (id_persona_negocio)
                    REFERENCES platform.persona_negocio(id_persona_negocio)
                    ON DELETE SET NULL;`,
                { transaction: t }
            );
            console.log('   FK creada.');
        } else {
            console.log('   FK ya existía.');
        }

        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_reserva_cita_persona_negocio
                ON reserva.reserva_cita (id_persona_negocio)
                WHERE id_persona_negocio IS NOT NULL;`,
            { transaction: t }
        );
        console.log('   OK\n');

        // ── 2. Backfill ───────────────────────────────────────────────
        console.log('2. Identificando móviles válidos en las citas...');
        await sequelize.query(SQL_CANDIDATOS, { transaction: t });
        const [cand] = await sequelize.query(
            `SELECT count(*)::int AS citas,
                    count(DISTINCT (id_negocio, telefono_e164))::int AS personas
               FROM tmp_backfill_citas;`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        console.log(`   ${cand.citas} citas con móvil válido → ${cand.personas} clientes.\n`);

        console.log('3. Creando clientes (nombre = el de la cita más reciente)...');
        await sequelize.query(
            `INSERT INTO platform.persona_negocio (id_negocio, telefono_e164, nombre_mostrado)
             SELECT DISTINCT ON (id_negocio, telefono_e164)
                    id_negocio, telefono_e164, nombre
               FROM tmp_backfill_citas
              ORDER BY id_negocio, telefono_e164, fecha_creacion DESC
             ON CONFLICT (id_negocio, telefono_e164) WHERE telefono_e164 IS NOT NULL
             DO NOTHING;`,
            { transaction: t }
        );

        console.log('4. Enlazando citas históricas...');
        const [, meta] = await sequelize.query(
            `UPDATE reserva.reserva_cita c
                SET id_persona_negocio = pn.id_persona_negocio
               FROM tmp_backfill_citas m
               JOIN platform.persona_negocio pn
                 ON pn.id_negocio    = m.id_negocio
                AND pn.telefono_e164 = m.telefono_e164
              WHERE c.id_cita = m.id_cita
                AND c.id_persona_negocio IS DISTINCT FROM pn.id_persona_negocio;`,
            { transaction: t }
        );
        console.log(`   ${meta?.rowCount ?? 0} citas enlazadas.\n`);

        // ── 3. Vista en el catálogo de permisos ───────────────────────
        console.log('5. Publicando la vista /clientes en el catálogo...');
        const [tipo] = await sequelize.query(
            `SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA';`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!tipo) {
            throw new Error('No existe el tipo de negocio RESERVA. Ejecuta antes: npm run migrate:reserva');
        }
        const idTipo = tipo.id_tipo_negocio;

        const [root] = await sequelize.query(
            `SELECT id_nivel FROM general.gener_nivel
              WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/reserva';`,
            { replacements: { tipo: idTipo }, type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!root) {
            throw new Error('No existe el nivel raíz /reserva. Ejecuta antes: npm run migrate:reserva');
        }

        await sequelize.query(
            `INSERT INTO general.gener_nivel
                 (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
             SELECT 'CLIENTES', :padre, 'contact', 'A', 1, '/clientes', :tipo
              WHERE NOT EXISTS (
                  SELECT 1 FROM general.gener_nivel
                   WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/clientes'
              );`,
            { replacements: { padre: root.id_nivel, tipo: idTipo }, transaction: t }
        );

        // ADMINISTRADOR y RECEPCIONISTA la ven; PROFESIONAL no —mira su agenda, no la
        // cartera del negocio—. Son valores de partida: cada negocio los ajusta en Roles.
        await sequelize.query(
            `INSERT INTO general.gener_rol_nivel
                 (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
             SELECT r.id_rol, n.id_nivel,
                    true,
                    false,
                    r.descripcion = 'ADMINISTRADOR',
                    false,
                    'A'
               FROM general.gener_rol r
               JOIN general.gener_nivel n
                 ON n.id_tipo_negocio = :tipo AND n.id_tipo_nivel = 1 AND n.url = '/clientes'
              WHERE r.id_tipo_negocio = :tipo
                AND r.estado = 'A'
                AND r.descripcion IN ('ADMINISTRADOR', 'RECEPCIONISTA')
             ON CONFLICT (id_rol, id_nivel) DO NOTHING;`,
            { replacements: { tipo: idTipo }, transaction: t }
        );

        // Y el ajuste por-negocio para los que ya existen: sin esta fila, un negocio con
        // ajustes propios no vería la vista aunque su rol la tenga.
        await sequelize.query(
            `INSERT INTO general.gener_nivel_negocio
                 (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
             SELECT neg.id_negocio, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
               FROM general.gener_negocio neg
               JOIN general.gener_nivel niv
                 ON niv.id_tipo_negocio = :tipo AND niv.id_tipo_nivel = 1 AND niv.url = '/clientes'
               JOIN general.gener_rol_nivel rn
                 ON rn.id_nivel = niv.id_nivel
              WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
             ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;`,
            { replacements: { tipo: idTipo }, transaction: t }
        );
        console.log('   OK\n');

        // ── Resumen ───────────────────────────────────────────────────
        const [resumen] = await sequelize.query(
            `SELECT
                (SELECT count(*)::int FROM reserva.reserva_cita)                          AS citas_total,
                (SELECT count(*)::int FROM reserva.reserva_cita
                  WHERE id_persona_negocio IS NOT NULL)                                   AS enlazadas,
                (SELECT count(*)::int FROM reserva.reserva_cita
                  WHERE id_persona_negocio IS NULL
                    AND NULLIF(BTRIM(COALESCE(cliente_telefono, '')), '') IS NOT NULL)    AS con_telefono_sin_enlazar;`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );

        await t.commit();

        console.log(`   Citas totales:                     ${resumen.citas_total}`);
        console.log(`   Enlazadas a un cliente:            ${resumen.enlazadas}`);
        console.log(`   Con teléfono pero sin enlazar:     ${resumen.con_telefono_sin_enlazar}`);
        console.log('\n   (Las últimas son teléfonos que no son un móvil colombiano válido:');
        console.log('    fijos, incompletos o basura. No se inventa identidad — ADR-006.)');
        console.log('\n✓ Listo.\n');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
