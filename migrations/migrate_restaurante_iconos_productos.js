/**
 * Migración: interruptor de los iconos de producto en el POS.
 *
 *  - general.gener_negocio.muestra_iconos_productos  (BOOLEAN, default TRUE)
 *      Con la opción activa, Pedidos lista cada producto con su icono (y también
 *      los del carrito); apagada, solo el nombre. Es cuestión de gusto y de qué
 *      tan cargada quiere el negocio su pantalla de venta.
 *
 * **Nace ENCENDIDA**, al revés que los otros interruptores del negocio. Y a
 * propósito: los iconos es lo que todos los negocios ven hoy, así que un default
 * en `false` le cambiaría la pantalla de venta a todo el mundo el día del
 * despliegue. Lo opt-in aquí es QUITARLOS. El `DEFAULT true` ya deja en TRUE las
 * filas existentes al añadir la columna, sin necesidad de un UPDATE de relleno.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-iconos-productos
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
        console.log('→ Migración Restaurante - Iconos de producto en Pedidos\n');

        console.log('1. Flag del negocio (activable por el admin en Configuración)...');
        await agregarColumna({
            esquema: 'general', tabla: 'gener_negocio', columna: 'muestra_iconos_productos',
            definicion: 'BOOLEAN NOT NULL DEFAULT true', transaction: t,
        });

        // gener_negocio ya lleva su trigger trg_audit desde migrate_auditoria_*:
        // una columna nueva entra sola en el snapshot JSONB.

        await t.commit();
        console.log('\n✓ Migración Iconos de producto completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
