/**
 * Cobranza — complementos del plan (2026-09-21).
 *
 * El cliente puede ampliar su plan con **usuarios adicionales** y **cajas adicionales** al
 * comprarlo, y esa elección queda guardada para siempre: define lo que paga cada mes y lo que
 * puede usar. Hasta hoy el plan era un solo número; desde aquí, lo que se cobra es
 * `plan + Σ(cantidad × precio del complemento)`.
 *
 * ## Qué crea
 *
 * 1. `general.gener_plan.usuarios_incluidos` / `cajas_incluidas` — lo que el plan trae de serie.
 *    Antes vivía solo en el texto de la landing («4 usuarios incluidos») y ningún proyecto podía
 *    preguntarlo. Sin esto, «usuario adicional» no tiene contra qué sumarse.
 *
 * 2. `cobranza.cob_complemento` — el catálogo: qué se puede añadir, qué límite amplía y cuántas
 *    unidades como mucho.
 *
 * 3. `cobranza.cob_precio_complemento` — su precio por moneda y ciclo, con la misma forma que
 *    `cob_precio_plan`: un complemento sin precio en una moneda simplemente no se ofrece ahí.
 *
 * 4. `cobranza.cob_suscripcion_complemento` — lo que cada negocio contrató. Cuelga de la
 *    suscripción (y lleva `id_negocio` para consultarlo sin pasar por ella). Es la fuente de
 *    verdad para las dos preguntas: «¿cuánto cobro este mes?» y «¿cuántos usuarios/cajas puede
 *    tener este negocio?» (`app_core/helpers/limitesNegocio.js`).
 *
 *    Lleva **dos cantidades**, y la diferencia entre ellas es una decisión comercial, no un
 *    error: `cantidad` es lo que el negocio puede usar y `cantidad_facturable` es lo que se le
 *    cobra. Un cliente con 8 usuarios adicionales de los que solo se cobran 3 tiene 5 de
 *    cortesía: los usa, no los paga. Sin esta separación, los negocios que ya venían usando más
 *    de lo que su plan incluye (Zona Burger con 12 usuarios en un plan de 4) solo tendrían dos
 *    salidas, y las dos malas: cobrarles de golpe algo que nunca pactaron, o dejarles el límite
 *    abierto y no poder aplicarlo a nadie.
 *
 * 5. `cobranza.cob_factura_detalle` — las líneas de cada factura. El total ya no es un solo
 *    precio: la factura tiene que decir qué parte fue plan y qué parte cada complemento, o nadie
 *    podrá explicarle al cliente por qué pagó lo que pagó.
 *
 * ## Auditoría
 *
 * Regla fija: tabla con dinero o estado → `trg_audit` en la misma migración. Se auditan el
 * catálogo, sus precios y lo contratado por cada negocio. `cob_factura_detalle` NO: es detalle de
 * una factura que ya se audita, se reescribe entera al recalcular y no tiene estado propio.
 *
 * Idempotente: `IF NOT EXISTS` en cada tabla, `information_schema` antes de cada ALTER y
 * `ON CONFLICT DO NOTHING` en las semillas.
 *
 * Ejecutar con: npm run migrate:cobranza-complementos
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/** Lo que trae cada plan de serie. Coincide con las tarjetas de la landing (4/1 y 8/2). */
const INCLUIDOS_POR_PLAN = [
    { nombre: 'Plan Básico', usuarios: 4, cajas: 1 },
    { nombre: 'Plan Avanzado', usuarios: 8, cajas: 2 },
];

/** El catálogo inicial. `amplia` es el límite que suma; `cantidad_maxima` el tope por negocio. */
const COMPLEMENTOS = [
    {
        codigo: 'USUARIO_ADICIONAL',
        nombre: 'Usuario adicional',
        descripcion: 'Una persona más en tu equipo, con su propio acceso y sus propios permisos.',
        amplia: 'usuarios',
        maxima: 20,
        orden: 10,
        precio: 3999,
    },
    {
        codigo: 'CAJA_ADICIONAL',
        nombre: 'Caja adicional',
        descripcion: 'Otro punto de cobro abierto a la vez — una segunda barra, un segundo mostrador.',
        amplia: 'cajas',
        maxima: 5,
        orden: 20,
        precio: 9999,
    },
];

const TABLAS_AUDITADAS = [
    { tabla: 'cob_complemento', pk: 'id_complemento' },
    { tabla: 'cob_precio_complemento', pk: 'id_precio' },
    { tabla: 'cob_suscripcion_complemento', pk: 'id_suscripcion_complemento' },
];

async function existeColumna(esquema, tabla, columna, t) {
    const filas = await sequelize.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna
          LIMIT 1;`,
        { replacements: { esquema, tabla, columna }, transaction: t, type: sequelize.QueryTypes.SELECT }
    );
    return filas.length > 0;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: complementos del plan\n');

        const [[infra]] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'cobranza' AND table_name = 'cob_suscripcion'
             ) AS ok;`,
            { transaction: t }
        );
        if (!infra.ok) {
            throw new Error('Falta el esquema de cobranza. Ejecute primero: npm run migrate:cobranza');
        }

        // ── 1. Lo que trae cada plan de serie ────────────────────────────────────────────
        console.log('1. gener_plan.usuarios_incluidos / cajas_incluidas...');
        for (const columna of ['usuarios_incluidos', 'cajas_incluidas']) {
            if (await existeColumna('general', 'gener_plan', columna, t)) {
                console.log(`   ${columna}: ya existía.`);
                continue;
            }
            await sequelize.query(
                `ALTER TABLE general.gener_plan ADD COLUMN ${columna} smallint
                   CHECK (${columna} IS NULL OR ${columna} >= 0);`,
                { transaction: t }
            );
            console.log(`   ${columna}: añadida.`);
        }
        await sequelize.query(
            `COMMENT ON COLUMN general.gener_plan.usuarios_incluidos IS
             'Usuarios que trae el plan de serie. NULL = sin límite. Los complementos suman encima.';
             COMMENT ON COLUMN general.gener_plan.cajas_incluidas IS
             'Cajas (puntos de cobro simultáneos) que trae el plan de serie. NULL = sin límite.';`,
            { transaction: t }
        );
        for (const p of INCLUIDOS_POR_PLAN) {
            // Solo si están vacías: un ajuste hecho a mano después no se pisa al re-ejecutar.
            await sequelize.query(
                `UPDATE general.gener_plan
                    SET usuarios_incluidos = COALESCE(usuarios_incluidos, :usuarios),
                        cajas_incluidas    = COALESCE(cajas_incluidas, :cajas)
                  WHERE nombre = :nombre;`,
                { replacements: p, transaction: t }
            );
        }
        console.log('   valores de serie fijados (sin pisar los existentes).');

        // ── 2. Catálogo ──────────────────────────────────────────────────────────────────
        console.log('2. cobranza.cob_complemento...');
        await sequelize.query(
            `CREATE TABLE IF NOT EXISTS cobranza.cob_complemento (
                id_complemento   serial        PRIMARY KEY,
                codigo           varchar(40)   NOT NULL,
                nombre           varchar(80)   NOT NULL,
                descripcion      text,
                amplia           varchar(20),
                cantidad_maxima  smallint      NOT NULL DEFAULT 20,
                orden            smallint      NOT NULL DEFAULT 0,
                estado           char(1)       NOT NULL DEFAULT 'A',
                creado_en        timestamp     NOT NULL DEFAULT now(),

                CONSTRAINT uq_cob_complemento_codigo UNIQUE (codigo),
                CONSTRAINT chk_cob_complemento_estado CHECK (estado IN ('A','I')),
                CONSTRAINT chk_cob_complemento_max    CHECK (cantidad_maxima > 0),
                CONSTRAINT chk_cob_complemento_amplia CHECK (amplia IS NULL OR amplia IN ('usuarios','cajas'))
            );
            COMMENT ON TABLE cobranza.cob_complemento IS
              'Lo que se puede añadir a un plan. amplia = el límite que suma (usuarios|cajas).';`,
            { transaction: t }
        );
        for (const c of COMPLEMENTOS) {
            await sequelize.query(
                `INSERT INTO cobranza.cob_complemento (codigo, nombre, descripcion, amplia, cantidad_maxima, orden)
                 VALUES (:codigo, :nombre, :descripcion, :amplia, :maxima, :orden)
                 ON CONFLICT (codigo) DO NOTHING;`,
                { replacements: c, transaction: t }
            );
        }
        console.log(`   ${COMPLEMENTOS.length} complementos en el catálogo.`);

        // ── 3. Precios ───────────────────────────────────────────────────────────────────
        console.log('3. cobranza.cob_precio_complemento...');
        await sequelize.query(
            `CREATE TABLE IF NOT EXISTS cobranza.cob_precio_complemento (
                id_precio       serial        PRIMARY KEY,
                id_complemento  integer       NOT NULL
                                REFERENCES cobranza.cob_complemento(id_complemento) ON DELETE CASCADE,
                moneda          char(3)       NOT NULL,
                ciclo           varchar(10)   NOT NULL DEFAULT 'mensual',
                precio          numeric(12,2) NOT NULL,
                estado          char(1)       NOT NULL DEFAULT 'A',

                CONSTRAINT uq_cob_precio_complemento UNIQUE (id_complemento, moneda, ciclo),
                CONSTRAINT chk_cob_precio_comp_ciclo  CHECK (ciclo IN ('mensual','anual')),
                CONSTRAINT chk_cob_precio_comp_estado CHECK (estado IN ('A','I')),
                CONSTRAINT chk_cob_precio_comp_valor  CHECK (precio >= 0)
            );`,
            { transaction: t }
        );
        for (const c of COMPLEMENTOS) {
            await sequelize.query(
                `INSERT INTO cobranza.cob_precio_complemento (id_complemento, moneda, ciclo, precio)
                 SELECT id_complemento, 'COP', 'mensual', :precio
                   FROM cobranza.cob_complemento WHERE codigo = :codigo
                 ON CONFLICT (id_complemento, moneda, ciclo) DO NOTHING;`,
                { replacements: c, transaction: t }
            );
        }
        console.log('   precios COP mensuales sembrados (sin pisar los existentes).');

        // ── 4. Lo contratado ─────────────────────────────────────────────────────────────
        console.log('4. cobranza.cob_suscripcion_complemento...');
        await sequelize.query(
            `CREATE TABLE IF NOT EXISTS cobranza.cob_suscripcion_complemento (
                id_suscripcion_complemento serial   PRIMARY KEY,
                id_suscripcion  integer    NOT NULL
                                REFERENCES cobranza.cob_suscripcion(id_suscripcion) ON DELETE CASCADE,
                id_negocio      integer    NOT NULL
                                REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                id_complemento  integer    NOT NULL
                                REFERENCES cobranza.cob_complemento(id_complemento),
                cantidad            smallint NOT NULL,
                cantidad_facturable smallint NOT NULL DEFAULT 0,
                estado          char(1)    NOT NULL DEFAULT 'A',
                creado_en       timestamp  NOT NULL DEFAULT now(),
                actualizado_en  timestamp  NOT NULL DEFAULT now(),

                CONSTRAINT uq_cob_susc_complemento     UNIQUE (id_suscripcion, id_complemento),
                CONSTRAINT chk_cob_susc_comp_cantidad  CHECK (cantidad > 0),
                CONSTRAINT chk_cob_susc_comp_facturable
                    CHECK (cantidad_facturable >= 0 AND cantidad_facturable <= cantidad),
                CONSTRAINT chk_cob_susc_comp_estado    CHECK (estado IN ('A','I'))
            );
            CREATE INDEX IF NOT EXISTS ix_cob_susc_comp_negocio
                ON cobranza.cob_suscripcion_complemento (id_negocio);
            COMMENT ON TABLE cobranza.cob_suscripcion_complemento IS
              'Complementos contratados por cada negocio. Suman al cobro de cada período y a los límites de uso.';`,
            { transaction: t }
        );
        // Para una base que ya tenga la tabla de antes de que existiera la cortesía: la
        // columna nace igualada a `cantidad` (todo lo contratado se cobra), que es como se
        // comportaba hasta ahora.
        if (!(await existeColumna('cobranza', 'cob_suscripcion_complemento', 'cantidad_facturable', t))) {
            await sequelize.query(
                `ALTER TABLE cobranza.cob_suscripcion_complemento
                   ADD COLUMN cantidad_facturable smallint NOT NULL DEFAULT 0;
                 UPDATE cobranza.cob_suscripcion_complemento SET cantidad_facturable = cantidad;
                 ALTER TABLE cobranza.cob_suscripcion_complemento
                   ADD CONSTRAINT chk_cob_susc_comp_facturable
                   CHECK (cantidad_facturable >= 0 AND cantidad_facturable <= cantidad);`,
                { transaction: t }
            );
            console.log('   cantidad_facturable añadida (igualada a lo contratado).');
        }
        await sequelize.query(
            `COMMENT ON COLUMN cobranza.cob_suscripcion_complemento.cantidad IS
               'Lo que el negocio puede usar. Cuenta para los límites.';
             COMMENT ON COLUMN cobranza.cob_suscripcion_complemento.cantidad_facturable IS
               'Lo que se le cobra. La diferencia con cantidad es cortesía.';`,
            { transaction: t }
        );
        console.log('   lista.');

        // ── 5. Detalle de cada factura ───────────────────────────────────────────────────
        console.log('5. cobranza.cob_factura_detalle...');
        await sequelize.query(
            `CREATE TABLE IF NOT EXISTS cobranza.cob_factura_detalle (
                id_factura_detalle serial        PRIMARY KEY,
                id_factura       integer       NOT NULL
                                 REFERENCES cobranza.cob_factura(id_factura) ON DELETE CASCADE,
                tipo             varchar(12)   NOT NULL,
                id_plan          integer       REFERENCES general.gener_plan(id_plan),
                id_complemento   integer       REFERENCES cobranza.cob_complemento(id_complemento),
                descripcion      varchar(120)  NOT NULL,
                cantidad         smallint      NOT NULL DEFAULT 1,
                precio_unitario  numeric(12,2) NOT NULL,
                subtotal         numeric(12,2) NOT NULL,

                CONSTRAINT chk_cob_fact_det_tipo CHECK (tipo IN ('plan','complemento')),
                CONSTRAINT chk_cob_fact_det_cant CHECK (cantidad > 0)
            );
            CREATE INDEX IF NOT EXISTS ix_cob_fact_det_factura
                ON cobranza.cob_factura_detalle (id_factura);
            COMMENT ON TABLE cobranza.cob_factura_detalle IS
              'Líneas de cada factura: el plan y cada complemento. La suma es cob_factura.total.';`,
            { transaction: t }
        );
        console.log('   lista.');

        // ── 6. Auditoría ─────────────────────────────────────────────────────────────────
        console.log('6. Triggers de auditoría...');
        const [[fn]] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM information_schema.routines
                  WHERE routine_schema = 'auditoria' AND routine_name = 'fn_audit'
             ) AS ok;`,
            { transaction: t }
        );
        if (!fn.ok) {
            console.log('   ⚠️  auditoria.fn_audit no existe — triggers omitidos.');
        } else {
            for (const { tabla, pk } of TABLAS_AUDITADAS) {
                await sequelize.query(`DROP TRIGGER IF EXISTS trg_audit ON cobranza.${tabla};`, {
                    transaction: t,
                });
                await sequelize.query(
                    `CREATE TRIGGER trg_audit
                         AFTER INSERT OR UPDATE OR DELETE ON cobranza.${tabla}
                         FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('${pk}');`,
                    { transaction: t }
                );
                console.log(`   ✓ cobranza.${tabla} (pk: ${pk})`);
            }
        }

        await t.commit();
        console.log('\n✅ Complementos listos: se cobran con el plan y amplían sus límites.');
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
