/**
 * Cobranza — el negocio puede cambiar de plan al pagar (2026-09-15).
 *
 * Decisión del dueño: el administrador de un negocio elige su plan desde «Mis pagos», tanto para
 * pagar un plan vencido con otro plan como para estrenar plan el mes siguiente. El cobro tiene que
 * salir por el monto del plan elegido.
 *
 * ## Por qué hacen falta DOS columnas y no basta con cambiar `cob_suscripcion.id_plan`
 *
 * 1. `cob_suscripcion.id_plan_solicitado` — el plan que el cliente ELIGIÓ pero **todavía no ha
 *    pagado**. Cambiar `id_plan` directamente sería regalarle el plan nuevo: la generación
 *    automática sincroniza la suscripción con el plan vigente del negocio
 *    (`gener_negocio_plan`), así que al día siguiente el cambio se habría perdido, y mientras
 *    tanto el negocio figuraría en un plan que no pagó.
 *
 * 2. `cob_factura.id_plan` — el plan que cobra CADA factura. Sin esto, una factura emitida por el
 *    Plan Avanzado se aplicaría contra el plan que tenga la suscripción el día del pago, que puede
 *    ser otro. La factura es el documento: tiene que decir qué se cobró.
 *
 * Al pagar, `aplicarPagoAprobado` fija en el negocio el plan de la factura y limpia el solicitado.
 *
 * Idempotente: comprueba `information_schema` antes de cada ALTER.
 * Ejecutar con: npm run migrate:cobranza-plan-solicitado
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function existeColumna(tabla, columna, t) {
    const filas = await sequelize.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'cobranza' AND table_name = :tabla AND column_name = :columna
          LIMIT 1;`,
        { replacements: { tabla, columna }, transaction: t, type: sequelize.QueryTypes.SELECT }
    );
    return filas.length > 0;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: cambio de plan por el negocio\n');

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

        console.log('1. cob_suscripcion.id_plan_solicitado...');
        if (await existeColumna('cob_suscripcion', 'id_plan_solicitado', t)) {
            console.log('   ya existía.');
        } else {
            await sequelize.query(
                `ALTER TABLE cobranza.cob_suscripcion
                   ADD COLUMN id_plan_solicitado integer
                   REFERENCES general.gener_plan(id_plan);`,
                { transaction: t }
            );
            await sequelize.query(
                `COMMENT ON COLUMN cobranza.cob_suscripcion.id_plan_solicitado IS
                 'Plan elegido por el cliente y aún no pagado. Manda sobre id_plan al generar el cobro; se limpia al pagarlo.';`,
                { transaction: t }
            );
            console.log('   añadida.');
        }

        console.log('2. cob_factura.id_plan...');
        if (await existeColumna('cob_factura', 'id_plan', t)) {
            console.log('   ya existía.');
        } else {
            await sequelize.query(
                `ALTER TABLE cobranza.cob_factura
                   ADD COLUMN id_plan integer
                   REFERENCES general.gener_plan(id_plan);`,
                { transaction: t }
            );
            await sequelize.query(
                `COMMENT ON COLUMN cobranza.cob_factura.id_plan IS
                 'El plan que cobra esta factura. Al pagarla, es el plan que queda en el negocio.';`,
                { transaction: t }
            );
            console.log('   añadida.');
        }

        // Las facturas viejas cobraron el plan que tenía su suscripción: es la mejor respuesta
        // disponible y deja la columna utilizable sin casos nulos que cada consulta deba esquivar.
        console.log('3. Backfill del plan en las facturas existentes...');
        const backfill = await sequelize.query(
            `UPDATE cobranza.cob_factura f
                SET id_plan = s.id_plan
               FROM cobranza.cob_suscripcion s
              WHERE s.id_suscripcion = f.id_suscripcion
                AND f.id_plan IS NULL
             RETURNING f.referencia;`,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        console.log(`   ${backfill.length} factura(s) actualizadas.`);

        await t.commit();
        console.log('\n✅ El negocio puede elegir plan; la factura sabe cuál cobra.');
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
