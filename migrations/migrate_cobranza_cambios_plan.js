/**
 * El cliente puede cambiar de plan y de complementos cuando quiera, sin esperar a la renovación.
 *
 * ## La regla
 *
 * **Sube → ahora, pagando solo la diferencia. Baja → en la próxima renovación.**
 *
 * Subir de plan (o añadir un usuario extra) genera un cobro de AJUSTE por la diferencia
 * prorrateada de los días que le quedan al ciclo, y el cambio entra al pagarlo. No mueve la fecha
 * de vencimiento: no está comprando otro mes, está mejorando el que ya tiene.
 *
 * Bajar no cobra nada y queda agendado para la renovación: ese mes ya lo pagó completo, y
 * quitárselo antes sería cobrarle un servicio que después no recibe.
 *
 * ## Qué hace falta en la base
 *
 * 1. `cob_factura.tipo` — una factura de ajuste **no extiende la vigencia**; una de renovación sí.
 *    Sin la columna, el pago de un ajuste regalaría un mes entero: `aplicarPagoAprobado` suma un
 *    ciclo a cualquier factura que se pague.
 *
 * 2. `cob_suscripcion_complemento.cantidad_solicitada` — lo que el cliente pidió y todavía no ha
 *    pagado. Es al complemento lo que `id_plan_solicitado` es al plan, y por el mismo motivo:
 *    `cantidad` manda en los límites de uso, así que moverla antes de cobrar sería regalar el
 *    complemento. Al pagar se copia sobre `cantidad` y se limpia.
 *
 * Idempotente: `information_schema` antes de cada ALTER.
 *
 * Ejecutar con: npm run migrate:cobranza-cambios-plan
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

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
        console.log('→ Migración: cambios de plan y complementos a mitad de ciclo\n');

        const [infra] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'cobranza' AND table_name = 'cob_suscripcion_complemento'
             ) AS ok;`,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        if (!infra.ok) {
            throw new Error(
                'Faltan los complementos. Ejecute primero: npm run migrate:cobranza-complementos'
            );
        }

        // ── 1. Renovación o ajuste ───────────────────────────────────────────────────────
        console.log('1. cob_factura.tipo...');
        if (await existeColumna('cobranza', 'cob_factura', 'tipo', t)) {
            console.log('   ya existía.');
        } else {
            // Todo lo que hay hoy es renovación: el ajuste no existía hasta esta migración.
            await sequelize.query(
                `ALTER TABLE cobranza.cob_factura
                   ADD COLUMN tipo varchar(12) NOT NULL DEFAULT 'renovacion';
                 ALTER TABLE cobranza.cob_factura
                   ADD CONSTRAINT chk_cob_factura_tipo CHECK (tipo IN ('renovacion', 'ajuste'));`,
                { transaction: t }
            );
            console.log('   añadida (todo lo existente queda como renovación).');
        }
        await sequelize.query(
            `COMMENT ON COLUMN cobranza.cob_factura.tipo IS
             'renovacion = compra un ciclo y extiende la vigencia. ajuste = diferencia prorrateada por subir de plan o añadir complementos a mitad de ciclo; NO mueve el vencimiento.';`,
            { transaction: t }
        );

        // ── 2. Lo pedido y no pagado ─────────────────────────────────────────────────────
        console.log('2. cob_suscripcion_complemento.cantidad_solicitada...');
        if (await existeColumna('cobranza', 'cob_suscripcion_complemento', 'cantidad_solicitada', t)) {
            console.log('   ya existía.');
        } else {
            await sequelize.query(
                `ALTER TABLE cobranza.cob_suscripcion_complemento
                   ADD COLUMN cantidad_solicitada smallint;
                 ALTER TABLE cobranza.cob_suscripcion_complemento
                   ADD CONSTRAINT chk_cob_susc_comp_solicitada
                   CHECK (cantidad_solicitada IS NULL OR cantidad_solicitada >= 0);`,
                { transaction: t }
            );
            console.log('   añadida.');
        }
        await sequelize.query(
            `COMMENT ON COLUMN cobranza.cob_suscripcion_complemento.cantidad_solicitada IS
             'Cantidad que el cliente pidió y aún no se hace efectiva. NULL = no hay cambio pendiente. Al pagar se copia sobre cantidad.';`,
            { transaction: t }
        );

        // ── 3. Una fila puede quedar en cero mientras espera ─────────────────────────────
        //
        // Hasta ahora `cantidad > 0` porque un complemento contratado siempre tenía al menos una
        // unidad. Ahora existe el caso «pedí quitarlo pero todavía no se aplica»: la fila sigue
        // viva con `cantidad_solicitada = 0` hasta la renovación. El cero de verdad —contratado en
        // cero— se sigue evitando desactivando la fila, no guardándola en cero.
        console.log('3. cantidad puede llegar a cero al aplicar una baja...');
        const [check] = await sequelize.query(
            `SELECT 1 AS ok FROM pg_constraint
              WHERE conname = 'chk_cob_susc_comp_cantidad'
                AND conrelid = 'cobranza.cob_suscripcion_complemento'::regclass;`,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        if (check?.ok) {
            await sequelize.query(
                `ALTER TABLE cobranza.cob_suscripcion_complemento
                   DROP CONSTRAINT chk_cob_susc_comp_cantidad;
                 ALTER TABLE cobranza.cob_suscripcion_complemento
                   ADD CONSTRAINT chk_cob_susc_comp_cantidad CHECK (cantidad >= 0);`,
                { transaction: t }
            );
            console.log('   ajustada a cantidad >= 0.');
        } else {
            console.log('   ya estaba.');
        }

        await t.commit();
        console.log('\n✅ Listo. Subir de plan cobra la diferencia; bajar espera a la renovación.');
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Falló la migración:', err.message);
        throw err;
    } finally {
        await sequelize.close();
    }
}

migrate().catch(() => process.exit(1));
