/**
 * Cobranza — precio de Reserva en pesos chilenos (2026-10-08).
 *
 *   node scripts/migrar.js cobranza-precio-reserva-clp
 *   npm run migrate:cobranza-precio-reserva-clp      (no queda apuntado en gener_migracion)
 *
 * ## El problema
 *
 * `migrate_cobranza_precio_aplicativo` (2026-09-24) abrió `cob_precio_plan` a un precio por
 * aplicativo y sembró los de Reserva **solo en COP**. La nota de entonces lo dijo: «el de Chile
 * (CLP) no cambia porque no hay precios de Reserva en CLP» — y en ese momento no había clientes
 * chilenos de Reserva, así que era una deuda sin consecuencia.
 *
 * Dejó de serlo. El negocio 16 (Chile, CLP, dLocal, módulo RESERVA) renovó el 2026-10-06 y
 * `getPrecio` hizo lo único que podía hacer: como no había fila de Reserva en CLP, cayó al precio
 * **por defecto**, que es el de Restaurante. Le cobró $8.900 CLP en vez del precio de Reserva.
 * No es un fallo del código —el respaldo al precio por defecto es el diseño— sino un precio que
 * faltaba por sembrar.
 *
 * ## Lo que hace
 *
 * Siembra las dos filas que faltaban: Plan Básico y Plan Avanzado de Reserva en CLP mensual.
 * Nada más. La columna y el índice único ya los creó la migración de 2026-09-24, de la que ésta
 * **depende**: si no está, aborta en vez de sembrar precios que nadie podría distinguir.
 *
 * ## Lo que NO toca
 *
 * - **Ninguna factura ya emitida.** La #19, pagada a $8.900 por el período 10-oct → 9-nov, se
 *   queda como está (decisión del dueño, 2026-10-08). La renovación cotiza a precio de hoy
 *   (`calcularCobro`), así que el precio nuevo entra solo en el período siguiente.
 * - **Los precios en COP**, que ya son los correctos ($37.999 / $69.999).
 * - **Los planes con facturación y los Empresariales**, que no tienen precio CLP de ninguna clase
 *   y por tanto no se venden en Chile (ver `docs/precios-y-planes.md` §8).
 *
 * Todo se resuelve por NOMBRE y nunca por id: los ids de plan y de tipo difieren entre dev y
 * producción. Idempotente: no duplica filas y se puede correr las veces que haga falta.
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/**
 * Precios de Reserva en CLP mensual (decisión del dueño, 2026-10-08).
 *
 * El salto sobre Restaurante ($8.900 / $18.900) es de $4.000 fijos en los dos planes. No replica
 * la proporción de COP —allá el salto también es fijo, de $10.000— pero sí su forma: en las dos
 * monedas Reserva cuesta un escalón constante más que Restaurante, no un porcentaje.
 */
const PRECIOS_RESERVA_CLP = [
    { plan: 'Plan Básico', precio: 12900 },
    { plan: 'Plan Avanzado', precio: 22900 },
];

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: precio de Reserva en CLP\n');

        // ── 0. La dependencia ─────────────────────────────────────────────────
        // Sin `id_tipo_modulo` no hay a dónde sembrar: las filas entrarían como precio por
        // defecto y PISARÍAN el de Restaurante en CLP, que es peor que el problema de partida.
        const [[col]] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'cobranza' AND table_name = 'cob_precio_plan'
                    AND column_name = 'id_tipo_modulo'
             ) AS existe;`,
            { transaction: t },
        );
        if (!col.existe) {
            throw new Error(
                'Falta cobranza.cob_precio_plan.id_tipo_modulo. '
                + 'Corre antes: node scripts/migrar.js cobranza-precio-aplicativo'
            );
        }
        console.log('0. Dependencia (id_tipo_modulo): presente.');

        // ── 1. El aplicativo ──────────────────────────────────────────────────
        const [tipos] = await sequelize.query(
            `SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA' LIMIT 1;`,
            { transaction: t },
        );
        const reserva = tipos[0];
        if (!reserva) {
            // Una base sin el aplicativo Reserva no tiene a quién cobrarle esto. No es un error:
            // es una base que todavía no vende Reserva.
            console.log('1. No existe el tipo «RESERVA»: no hay nada que sembrar.');
            await t.commit();
            console.log('\n✔ Migración completada (sin cambios).');
            return;
        }
        console.log(`1. Aplicativo RESERVA: id ${reserva.id_tipo_negocio}.\n`);

        // ── 2. Los precios ────────────────────────────────────────────────────
        for (const { plan, precio } of PRECIOS_RESERVA_CLP) {
            const insertados = await sequelize.query(
                `INSERT INTO cobranza.cob_precio_plan (id_plan, moneda, ciclo, precio, estado, id_tipo_modulo)
                 SELECT p.id_plan, 'CLP', 'mensual', :precio, 'A', :modulo
                   FROM general.gener_plan p
                  WHERE p.nombre = :plan AND p.estado = 'A'
                    AND NOT EXISTS (
                        SELECT 1 FROM cobranza.cob_precio_plan x
                         WHERE x.id_plan = p.id_plan AND x.moneda = 'CLP' AND x.ciclo = 'mensual'
                           AND x.id_tipo_modulo = :modulo
                    )
                 RETURNING id_precio;`,
                {
                    replacements: { plan, precio, modulo: reserva.id_tipo_negocio },
                    transaction: t,
                    type: sequelize.QueryTypes.SELECT,
                },
            );
            console.log(
                `2. ${plan} en Reserva (CLP $${precio}): `
                + (insertados.length ? 'sembrado.' : 'ya estaba (o el plan no existe).')
            );
        }

        // ── 3. Lo que queda cotizando ─────────────────────────────────────────
        // Se imprime para poder comprobar de un vistazo que un negocio de Reserva en Chile ya no
        // cae al precio por defecto. Es la pregunta que trajo esta migración aquí.
        const [resumen] = await sequelize.query(
            `SELECT p.nombre AS plan,
                    MAX(pr.precio) FILTER (WHERE pr.id_tipo_modulo IS NULL)    AS por_defecto,
                    MAX(pr.precio) FILTER (WHERE pr.id_tipo_modulo = :modulo)  AS reserva
               FROM cobranza.cob_precio_plan pr
               JOIN general.gener_plan p ON p.id_plan = pr.id_plan
              WHERE pr.moneda = 'CLP' AND pr.ciclo = 'mensual' AND pr.estado = 'A'
              GROUP BY p.nombre
              ORDER BY p.nombre;`,
            { replacements: { modulo: reserva.id_tipo_negocio }, transaction: t },
        );
        console.log('\n   CLP mensual, después de la migración:');
        for (const f of resumen) {
            console.log(
                `     ${f.plan.padEnd(16)} por defecto: ${f.por_defecto ?? '—'}`
                + `   reserva: ${f.reserva ?? '—'}`
            );
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
