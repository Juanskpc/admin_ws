/**
 * Migración: interruptor del control de inventario por negocio.
 *
 *  - general.gener_negocio.controla_inventario  (BOOLEAN, default TRUE)
 *
 * Apagado, el POS deja de mirar y de mover el stock de insumos: el pedido pasa siempre y
 * no aparece el aviso de «stock insuficiente». Es para los negocios que no llevan receta
 * cargada —la mayoría de los pequeños— y a los que la validación solo les estorbaba.
 *
 * ## Por qué nace ENCENDIDA, al revés que los demás interruptores
 *
 * `permite_descuento`, `permite_multipago` y `permite_cuentas_cliente` nacen apagados porque
 * añaden algo que antes no existía: encenderlos es la novedad. Este no añade, RETIRA una
 * comprobación que hoy ya corre en todos los negocios. Nacer apagado le quitaría el control
 * de inventario a quien sí lo usa, sin haberlo pedido y sin enterarse, que es exactamente la
 * clase de cambio silencioso que no se puede hacer en producción. Así que es un opt-OUT: el
 * default conserva el comportamiento actual y solo cambia quien vaya a apagarlo a mano.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-control-inventario
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/** Agrega una columna solo si aún no existe (guarda por information_schema). */
async function agregarColumna({ esquema, tabla, columna, definicion, transaction }) {
    const [existe] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;
    `, { replacements: { esquema, tabla, columna }, transaction });

    if (existe.length > 0) {
        console.log(`   • ${esquema}.${tabla}.${columna} ya existía, se omite`);
        return;
    }

    await sequelize.query(
        `ALTER TABLE ${esquema}.${tabla} ADD COLUMN ${columna} ${definicion};`,
        { transaction }
    );
    console.log(`   ✓ ${esquema}.${tabla}.${columna} creada`);
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - Control de inventario por negocio\n');

        console.log('1. Interruptor del negocio (se apaga desde Configuración)...');
        await agregarColumna({
            esquema: 'general', tabla: 'gener_negocio', columna: 'controla_inventario',
            definicion: 'BOOLEAN NOT NULL DEFAULT true', transaction: t,
        });

        // gener_negocio ya lleva su trigger trg_audit desde migrate_auditoria_*:
        // una columna nueva entra sola en el snapshot JSONB.

        await t.commit();
        console.log('\n✓ Migración Control de inventario completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
