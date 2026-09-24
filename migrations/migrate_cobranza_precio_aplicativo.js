/**
 * Cobranza — precio de un plan POR APLICATIVO (2026-09-24).
 *
 *   npm run migrate:cobranza-precio-aplicativo
 *
 * ## El problema
 *
 * La landing publica Reserva más caro que Restaurante ($37.999 frente a $27.999 en el plan de
 * entrada, $69.999 frente a $59.999 en el completo) y `cob_precio_plan` guardaba UN precio por
 * (plan, moneda, ciclo). Lo que se prometía y lo que se cobraba no podían coincidir.
 *
 * ## Lo que hace
 *
 * 1. `cob_precio_plan.id_tipo_modulo` — el aplicativo al que aplica el precio. **NULL = precio por
 *    defecto**, el que vale para todos los aplicativos que no tengan uno propio. Es el módulo del
 *    negocio (`gener_negocio.id_tipo_negocio`), no su oficio.
 * 2. La unicidad pasa de (plan, moneda, ciclo) a (plan, moneda, ciclo, aplicativo): un índice único
 *    con `COALESCE(id_tipo_modulo, 0)`, porque en un índice único normal dos NULL no chocan y
 *    podría haber dos precios «por defecto» para lo mismo.
 * 3. Los precios de Reserva de los dos planes que ya existen, COP mensual, como filas NUEVAS.
 *
 * ## Lo que NO toca
 *
 * Ningún precio existente: las filas de hoy quedan con `id_tipo_modulo = NULL`, así que un negocio
 * de Restaurante (y cualquiera sin precio propio) cotiza exactamente lo mismo que antes. Solo el
 * negocio cuyo aplicativo tenga fila propia cambia de precio.
 *
 * ⚠️ Un negocio de Reserva que ya paga toma el precio de Reserva en su próxima renovación: la
 * renovación cotiza a precio de hoy (`calcularCobro`). El dueño lo decidió así el 2026-09-24
 * porque hoy no hay clientes reales de Reserva en Colombia; el de Chile (CLP) no cambia porque
 * no se siembran precios de Reserva en CLP.
 *
 * Todo se resuelve por NOMBRE y nunca por id: los ids de plan y de tipo difieren entre dev y
 * producción. Idempotente: comprueba `information_schema` y no duplica filas.
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/** Precios de Reserva (COP, mensual) — `PRECIO_PLAN.RESERVA` de la landing. */
const PRECIOS_RESERVA = [
    { plan: 'Plan Básico', precio: 37999 },
    { plan: 'Plan Avanzado', precio: 69999 },
];

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: precio por aplicativo en cob_precio_plan\n');

        // ── 1. La columna ─────────────────────────────────────────────────────
        const [[col]] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'cobranza' AND table_name = 'cob_precio_plan'
                    AND column_name = 'id_tipo_modulo'
             ) AS existe;`,
            { transaction: t },
        );
        if (!col.existe) {
            await sequelize.query(
                `ALTER TABLE cobranza.cob_precio_plan
                   ADD COLUMN id_tipo_modulo INTEGER NULL
                   REFERENCES general.gener_tipo_negocio(id_tipo_negocio);
                 COMMENT ON COLUMN cobranza.cob_precio_plan.id_tipo_modulo IS
                   'Aplicativo (módulo del negocio) al que aplica el precio. NULL = precio por defecto.';`,
                { transaction: t },
            );
            console.log('1. id_tipo_modulo: creada.');
        } else {
            console.log('1. id_tipo_modulo: ya existe.');
        }

        // ── 2. La unicidad ────────────────────────────────────────────────────
        const [[uq]] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'cobranza.cob_precio_plan'::regclass AND conname = 'uq_cob_precio_plan'
             ) AS existe;`,
            { transaction: t },
        );
        if (uq.existe) {
            // Al soltar la restricción cae también su índice.
            await sequelize.query(
                `ALTER TABLE cobranza.cob_precio_plan DROP CONSTRAINT uq_cob_precio_plan;`,
                { transaction: t },
            );
            console.log('2. Restricción vieja (plan, moneda, ciclo): retirada.');
        }
        await sequelize.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_cob_precio_plan_aplicativo
                 ON cobranza.cob_precio_plan (id_plan, moneda, ciclo, COALESCE(id_tipo_modulo, 0));`,
            { transaction: t },
        );
        console.log('2. Índice único (plan, moneda, ciclo, aplicativo): listo.\n');

        // ── 3. Precios de Reserva ─────────────────────────────────────────────
        const [tiposReserva] = await sequelize.query(
            `SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA' LIMIT 1;`,
            { transaction: t },
        );
        const reserva = tiposReserva[0];
        if (!reserva) {
            console.log('3. No existe el tipo «RESERVA»: no se siembran precios de Reserva.');
        } else {
            for (const { plan, precio } of PRECIOS_RESERVA) {
                const insertados = await sequelize.query(
                    `INSERT INTO cobranza.cob_precio_plan (id_plan, moneda, ciclo, precio, estado, id_tipo_modulo)
                     SELECT p.id_plan, 'COP', 'mensual', :precio, 'A', :modulo
                       FROM general.gener_plan p
                      WHERE p.nombre = :plan AND p.estado = 'A'
                        AND NOT EXISTS (
                            SELECT 1 FROM cobranza.cob_precio_plan x
                             WHERE x.id_plan = p.id_plan AND x.moneda = 'COP' AND x.ciclo = 'mensual'
                               AND x.id_tipo_modulo = :modulo
                        )
                     RETURNING id_precio;`,
                    {
                        replacements: { plan, precio, modulo: reserva.id_tipo_negocio },
                        transaction: t,
                        type: sequelize.QueryTypes.SELECT,
                    },
                );
                console.log(`3. ${plan} en Reserva (COP $${precio}): ${insertados.length ? 'sembrado' : 'ya estaba (o el plan no existe)'}.`);
            }
        }

        await t.commit();
        console.log('\n✔ Migración completada.');
    } catch (err) {
        await t.rollback();
        console.error('✖ Migración fallida (se revirtió todo):', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
