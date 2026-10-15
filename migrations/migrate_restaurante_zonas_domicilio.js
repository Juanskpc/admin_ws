/**
 * Migración: barrios y veredas por comuna/corregimiento, con precio por zona (2026-10-15).
 *
 * ## Qué resuelve
 *
 * Hasta hoy cada negocio escribía sus barrios uno a uno con su precio (`rest_barrio_domicilio`).
 * Para una ciudad entera eso son ~550 filas, y casi siempre el precio es el mismo para toda una
 * comuna. Con esto:
 *
 *  - Hay un **catálogo** de la ciudad, compartido por todos los negocios: zonas (comuna o
 *    corregimiento) y sus lugares (barrio o vereda). Se siembra con Pasto desde
 *    `migrations/data/barrios_pasto.json` (sacado del Excel `barriosPasto.xlsx`). Otra ciudad =
 *    otro JSON y otra siembra.
 *  - Cada negocio copia el catálogo a SUS tablas y pone precio **por zona**
 *    (`rest_zona_domicilio.valor`) y, si quiere ser más fino, **por barrio**
 *    (`rest_barrio_domicilio.valor`). El valor de un barrio es el suyo y, si no tiene, el de su
 *    zona: `COALESCE(barrio.valor, zona.valor)`. Sin ninguno de los dos, el barrio no se ofrece.
 *
 * ## Qué cambia en `rest_barrio_domicilio`
 *
 *  - `valor` admite NULL (= «el de su zona»). Las filas de siempre tienen valor y no cambian.
 *  - `id_zona_domicilio` (NULL = barrio suelto, como los de antes).
 *  - `id_geo_lugar` (NULL = barrio que el negocio escribió a mano) y `tipo` (BARRIO / VEREDA).
 *  - El nombre deja de ser único por negocio y pasa a ser único **por zona**: «San José» existe en
 *    la Comuna 1, en Buesaquillo y en El Encano.
 *
 * Idempotente. npm run migrate:restaurante-zonas-domicilio
 */
require('dotenv').config();
const path = require('path');
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;
const CATALOGOS = [path.join(__dirname, 'data', 'barrios_pasto.json')];

async function existeColumna(t, esquema, tabla, columna) {
    const [fila] = await sequelize.query(
        `SELECT 1 AS hay FROM information_schema.columns
          WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;`,
        { replacements: { esquema, tabla, columna }, type: sequelize.QueryTypes.SELECT, transaction: t }
    );
    return Boolean(fila);
}

async function anadirColumna(t, esquema, tabla, columna, definicion) {
    if (await existeColumna(t, esquema, tabla, columna)) {
        console.log(`   • ${tabla}.${columna} ya existía`);
        return;
    }
    await sequelize.query(`ALTER TABLE ${esquema}.${tabla} ADD COLUMN ${columna} ${definicion};`, { transaction: t });
    console.log(`   ✓ ${tabla}.${columna}`);
}

async function triggerAudit(t, tabla, pk) {
    const [fn] = await sequelize.query(
        `SELECT 1 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'auditoria' AND p.proname = 'fn_audit';`,
        { type: sequelize.QueryTypes.SELECT, transaction: t }
    );
    if (!fn) {
        console.log(`   ⚠️  auditoria.fn_audit no existe — ${tabla} sin trigger.`);
        return;
    }
    await sequelize.query(`DROP TRIGGER IF EXISTS trg_audit ON ${tabla};`, { transaction: t });
    await sequelize.query(
        `CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON ${tabla}
             FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('${pk}');`,
        { transaction: t }
    );
}

async function sembrar(t, archivo) {
    const datos = require(archivo);
    let zonasNuevas = 0;
    let lugaresNuevos = 0;
    for (const [orden, zona] of datos.zonas.entries()) {
        const [existente] = await sequelize.query(
            `SELECT id_geo_zona FROM general.gener_geo_zona
              WHERE lower(ciudad) = lower(:ciudad) AND lower(nombre) = lower(:nombre);`,
            { replacements: { ciudad: datos.ciudad, nombre: zona.nombre }, type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        let idZona = existente?.id_geo_zona;
        if (!idZona) {
            const [nueva] = await sequelize.query(
                `INSERT INTO general.gener_geo_zona (ciudad, departamento, tipo, nombre, orden)
                 VALUES (:ciudad, :departamento, :tipo, :nombre, :orden) RETURNING id_geo_zona;`,
                {
                    replacements: {
                        ciudad: datos.ciudad,
                        departamento: datos.departamento,
                        tipo: zona.tipo,
                        nombre: zona.nombre,
                        orden,
                    },
                    type: sequelize.QueryTypes.SELECT,
                    transaction: t,
                }
            );
            idZona = nueva.id_geo_zona;
            zonasNuevas += 1;
        }
        for (const lugar of zona.lugares) {
            const [r] = await sequelize.query(
                `INSERT INTO general.gener_geo_lugar (id_geo_zona, tipo, nombre)
                 VALUES (:idZona, :tipo, :nombre)
                 ON CONFLICT DO NOTHING RETURNING id_geo_lugar;`,
                { replacements: { idZona, tipo: lugar.tipo, nombre: lugar.nombre }, type: sequelize.QueryTypes.SELECT, transaction: t }
            );
            if (r) lugaresNuevos += 1;
        }
    }
    console.log(`   ✓ ${datos.ciudad}: ${zonasNuevas} zonas y ${lugaresNuevos} lugares nuevos`);
}

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('1. Catálogo de la ciudad (general.gener_geo_zona / gener_geo_lugar)...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS general.gener_geo_zona (
                id_geo_zona  SERIAL PRIMARY KEY,
                ciudad       VARCHAR(80)  NOT NULL,
                departamento VARCHAR(80)  NULL,
                -- COMUNA (urbana) o CORREGIMIENTO (rural).
                tipo         VARCHAR(20)  NOT NULL,
                nombre       VARCHAR(100) NOT NULL,
                orden        SMALLINT     NOT NULL DEFAULT 0
            );
            CREATE UNIQUE INDEX IF NOT EXISTS ux_geo_zona_ciudad_nombre
                ON general.gener_geo_zona (lower(ciudad), lower(nombre));

            CREATE TABLE IF NOT EXISTS general.gener_geo_lugar (
                id_geo_lugar SERIAL PRIMARY KEY,
                id_geo_zona  INTEGER      NOT NULL REFERENCES general.gener_geo_zona(id_geo_zona) ON DELETE CASCADE,
                -- BARRIO (en una comuna) o VEREDA (en un corregimiento).
                tipo         VARCHAR(20)  NOT NULL,
                nombre       VARCHAR(100) NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS ux_geo_lugar_zona_nombre
                ON general.gener_geo_lugar (id_geo_zona, lower(nombre));
            `,
            { transaction: t }
        );
        for (const archivo of CATALOGOS) await sembrar(t, archivo);

        console.log('2. restaurante.rest_zona_domicilio (precio por zona del negocio)...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS restaurante.rest_zona_domicilio (
                id_zona_domicilio SERIAL PRIMARY KEY,
                id_negocio  INTEGER      NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                id_geo_zona INTEGER      NULL REFERENCES general.gener_geo_zona(id_geo_zona),
                tipo        VARCHAR(20)  NOT NULL DEFAULT 'COMUNA',
                nombre      VARCHAR(100) NOT NULL,
                -- NULL = sin precio de zona: sus barrios solo se ofrecen si tienen el suyo.
                valor       NUMERIC(12,2) NULL,
                orden       SMALLINT     NOT NULL DEFAULT 0,
                estado      CHAR(1)      NOT NULL DEFAULT 'A',
                fecha_creacion TIMESTAMP NOT NULL DEFAULT now()
            );
            CREATE UNIQUE INDEX IF NOT EXISTS ux_rest_zona_domicilio_nombre
                ON restaurante.rest_zona_domicilio (id_negocio, lower(nombre)) WHERE estado = 'A';
            `,
            { transaction: t }
        );
        await triggerAudit(t, 'restaurante.rest_zona_domicilio', 'id_zona_domicilio');

        console.log('3. restaurante.rest_barrio_domicilio...');
        await anadirColumna(
            t, 'restaurante', 'rest_barrio_domicilio', 'id_zona_domicilio',
            'integer NULL REFERENCES restaurante.rest_zona_domicilio(id_zona_domicilio)'
        );
        await anadirColumna(
            t, 'restaurante', 'rest_barrio_domicilio', 'id_geo_lugar',
            'integer NULL REFERENCES general.gener_geo_lugar(id_geo_lugar)'
        );
        await anadirColumna(t, 'restaurante', 'rest_barrio_domicilio', 'tipo', "varchar(20) NOT NULL DEFAULT 'BARRIO'");
        const [nulo] = await sequelize.query(
            `SELECT is_nullable FROM information_schema.columns
              WHERE table_schema = 'restaurante' AND table_name = 'rest_barrio_domicilio' AND column_name = 'valor';`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (nulo?.is_nullable === 'NO') {
            await sequelize.query(
                `ALTER TABLE restaurante.rest_barrio_domicilio
                   ALTER COLUMN valor DROP NOT NULL, ALTER COLUMN valor DROP DEFAULT;`,
                { transaction: t }
            );
            console.log('   ✓ valor admite NULL (= el de su zona)');
        }
        // El nombre pasa a ser único por zona, no por negocio.
        await sequelize.query(
            `DROP INDEX IF EXISTS restaurante.ux_rest_barrio_domicilio_nombre;
             CREATE UNIQUE INDEX IF NOT EXISTS ux_rest_barrio_domicilio_zona_nombre
                 ON restaurante.rest_barrio_domicilio (id_negocio, COALESCE(id_zona_domicilio, 0), lower(nombre))
                 WHERE estado = 'A';
             CREATE INDEX IF NOT EXISTS ix_rest_barrio_domicilio_zona
                 ON restaurante.rest_barrio_domicilio (id_zona_domicilio) WHERE id_zona_domicilio IS NOT NULL;`,
            { transaction: t }
        );
        console.log('   ✓ nombre único por zona');

        await t.commit();
        console.log('\n✅ Migración de zonas de domicilio completada.');
    } catch (err) {
        await t.rollback();
        console.error('❌ Error en la migración (revertida):', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
