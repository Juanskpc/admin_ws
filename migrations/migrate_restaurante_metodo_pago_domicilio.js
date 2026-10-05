/**
 * Migración: de qué forma de pago sale el pago al domiciliario.
 *
 *  - Agrega general.gener_negocio.id_metodo_pago_domicilio (INTEGER NULL, FK a
 *    restaurante.rest_metodo_pago).
 *
 * El problema que arregla: el EGRESO del domicilio se ataba al pedido y nada más, así
 * que el desglose del turno lo restaba de la MISMA forma de pago con la que el cliente
 * pagó. Un pedido de 20.000 + 7.000 de domicilio cobrado por transferencia dejaba
 * «Transferencia 20.000» y el efectivo intacto, cuando lo que de verdad pasó es que
 * entraron 27.000 por transferencia y salieron 7.000 del cajón.
 *
 * Con esta columna el negocio dice de dónde sale ese pago. NULL = comportamiento de
 * siempre (sale de la forma de pago del pedido), así que nadie cambia sin tocar nada.
 *
 * Los negocios que YA tienen `permite_pago_domicilio` activo sí se siembran con su
 * «Efectivo» activo: son exactamente los que pagan domiciliarios, y todos lo hacen en
 * efectivo. Es el caso que pidió la funcionalidad (El Callejero). Si no tienen una
 * forma de pago llamada así, quedan en NULL y lo eligen en Configuración.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-metodo-pago-domicilio
 * o, en una base que lleve el registro de migraciones:
 *   node scripts/migrar.js restaurante-metodo-pago-domicilio
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function columnaExiste({ schema, table, column, transaction }) {
    const [rows] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = :schema AND table_name = :table AND column_name = :column;
    `, { replacements: { schema, table, column }, transaction });
    return rows.length > 0;
}

async function restriccionExiste({ schema, table, name, transaction }) {
    const [rows] = await sequelize.query(`
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = :schema AND table_name = :table AND constraint_name = :name;
    `, { replacements: { schema, table, name }, transaction });
    return rows.length > 0;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - Forma de pago del domicilio\n');

        console.log('1. Agregando general.gener_negocio.id_metodo_pago_domicilio...');
        const yaCol = await columnaExiste({
            schema: 'general', table: 'gener_negocio', column: 'id_metodo_pago_domicilio', transaction: t,
        });
        if (!yaCol) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio
                ADD COLUMN id_metodo_pago_domicilio INTEGER NULL;
            `, { transaction: t });
            console.log('   ✓ columna creada (NULL = sale de la forma de pago del pedido)');
        } else {
            console.log('   • ya existía, se omite');
        }

        // ON DELETE SET NULL y no RESTRICT: borrar una forma de pago es cosa de
        // Configuración, y si alguna vez se borra la elegida el negocio debe volver al
        // comportamiento de siempre, no quedarse con una FK que no deja borrar nada.
        console.log('2. FK → restaurante.rest_metodo_pago...');
        const yaFk = await restriccionExiste({
            schema: 'general', table: 'gener_negocio',
            name: 'fk_gener_negocio_metodo_pago_domicilio', transaction: t,
        });
        if (!yaFk) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio
                ADD CONSTRAINT fk_gener_negocio_metodo_pago_domicilio
                FOREIGN KEY (id_metodo_pago_domicilio)
                REFERENCES restaurante.rest_metodo_pago (id_metodo_pago)
                ON DELETE SET NULL;
            `, { transaction: t });
            console.log('   ✓ constraint creada');
        } else {
            console.log('   • ya existía, se omite');
        }

        // Siembra: solo negocios con el cobro de domicilio ya activo, solo si no tienen
        // nada elegido, y solo si tienen un «Efectivo» activo propio (y que no sea la
        // forma de pago de las cuentas de cliente, que no mueve el cajón).
        console.log('3. Sembrando «Efectivo» en los negocios que ya cobran domicilio...');
        const [sembrados] = await sequelize.query(`
            UPDATE general.gener_negocio n
               SET id_metodo_pago_domicilio = mp.id_metodo_pago
              FROM restaurante.rest_metodo_pago mp
             WHERE mp.id_negocio = n.id_negocio
               AND mp.estado = 'A'
               AND NOT mp.es_cuenta
               AND lower(trim(mp.nombre)) = 'efectivo'
               AND n.permite_pago_domicilio = true
               AND n.id_metodo_pago_domicilio IS NULL
            RETURNING n.id_negocio, n.nombre, mp.nombre AS metodo;
        `, { transaction: t });
        if (sembrados.length === 0) {
            console.log('   • ningún negocio aplicable (o ya estaban sembrados)');
        } else {
            for (const f of sembrados) {
                console.log(`   ✓ ${f.id_negocio} · ${f.nombre} → ${f.metodo}`);
            }
        }

        await t.commit();
        console.log('\n✓ Migración Forma de pago del domicilio completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
