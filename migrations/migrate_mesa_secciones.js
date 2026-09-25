/**
 * Migracion — secciones de mesas como ENTIDAD (restaurante.rest_mesa_seccion)
 *
 * Antes (migrate_mesa_seccion.js, 2026-09-25) la seccion era un texto libre en cada mesa: escribir
 * «Piso 1» a mano en diez mesas y equivocarse en una («piso1») creaba otra seccion. Ahora la
 * seccion se CREA una vez y las mesas se le ASIGNAN.
 *
 * Que hace, todo idempotente y en una transaccion:
 *  1. Crea `restaurante.rest_mesa_seccion` (id, negocio, nombre, orden, estado) con nombre unico por
 *     negocio sin distinguir mayusculas.
 *  2. Agrega `rest_mesa.id_seccion` (FK, NULL = sin seccion; borrar la seccion deja las mesas libres).
 *  3. Si existe la columna de texto `rest_mesa.seccion`, la MIGRA: crea una seccion por cada texto
 *     distinto (sin distinguir mayusculas ni espacios de mas) y liga las mesas. La columna de texto
 *     NO se borra: el codigo anterior todavia la lee, y quitarla haria imposible volver atras.
 *
 * Ejecutar: npm run migrate:restaurante-mesa-secciones
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function existeColumna(t, tabla, columna) {
  const [filas] = await sequelize.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'restaurante' AND table_name = :tabla AND column_name = :columna
  `, { replacements: { tabla, columna }, transaction: t });
  return filas.length > 0;
}

async function migrate() {
  const t = await sequelize.transaction();
  try {
    console.log('Iniciando migracion de secciones de mesas...');

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS restaurante.rest_mesa_seccion (
        id_seccion     SERIAL PRIMARY KEY,
        id_negocio     INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
        nombre         VARCHAR(60) NOT NULL,
        orden          INTEGER NOT NULL DEFAULT 0,
        estado         CHAR(1) NOT NULL DEFAULT 'A',
        fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `, { transaction: t });

    await sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_rest_mesa_seccion_nombre
      ON restaurante.rest_mesa_seccion (id_negocio, LOWER(nombre));
    `, { transaction: t });

    if (!(await existeColumna(t, 'rest_mesa', 'id_seccion'))) {
      await sequelize.query(`
        ALTER TABLE restaurante.rest_mesa
        ADD COLUMN id_seccion INTEGER NULL
        REFERENCES restaurante.rest_mesa_seccion(id_seccion) ON DELETE SET NULL;
      `, { transaction: t });
      console.log('  + columna rest_mesa.id_seccion creada');
    } else {
      console.log('  = rest_mesa.id_seccion ya existia');
    }

    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_rest_mesa_seccion ON restaurante.rest_mesa(id_seccion);
    `, { transaction: t });

    // ── Migrar el texto libre anterior, si lo hay ──
    if (await existeColumna(t, 'rest_mesa', 'seccion')) {
      await sequelize.query(`
        INSERT INTO restaurante.rest_mesa_seccion (id_negocio, nombre, orden)
        SELECT id_negocio,
               nombre,
               ROW_NUMBER() OVER (PARTITION BY id_negocio ORDER BY primera) - 1
        FROM (
          SELECT id_negocio,
                 MIN(REGEXP_REPLACE(BTRIM(seccion), '\\s+', ' ', 'g')) AS nombre,
                 MIN(id_mesa) AS primera
          FROM restaurante.rest_mesa
          WHERE seccion IS NOT NULL AND BTRIM(seccion) <> ''
          GROUP BY id_negocio, LOWER(REGEXP_REPLACE(BTRIM(seccion), '\\s+', ' ', 'g'))
        ) x
        ON CONFLICT DO NOTHING;
      `, { transaction: t });

      const [, meta] = await sequelize.query(`
        UPDATE restaurante.rest_mesa m
        SET id_seccion = s.id_seccion
        FROM restaurante.rest_mesa_seccion s
        WHERE m.id_seccion IS NULL
          AND m.seccion IS NOT NULL
          AND s.id_negocio = m.id_negocio
          AND LOWER(s.nombre) = LOWER(REGEXP_REPLACE(BTRIM(m.seccion), '\\s+', ' ', 'g'));
      `, { transaction: t });
      console.log(`  ~ mesas ligadas desde el texto anterior: ${meta?.rowCount ?? 0}`);
    }

    await t.commit();
    console.log('Migracion completada correctamente.');
  } catch (err) {
    await t.rollback();
    console.error('Error en migracion:', err.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

migrate();
