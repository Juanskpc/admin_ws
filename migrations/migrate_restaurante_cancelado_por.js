/**
 * Migración: quién canceló un pedido.
 *
 *  - restaurante.pedid_orden.cancelado_por  (VARCHAR(10), nullable: 'cliente' | 'negocio')
 *
 * ## Por qué hace falta
 *
 * Hasta ahora `cancelarOrden` (panel, empleado) y `cancelarPorCliente` (bot de WhatsApp, F4-B)
 * dejaban la misma huella: `estado = 'CANCELADA'`. Un pedido cancelado desaparece de Despacho,
 * Cocina y Mesas en cuanto se cancela — es lo correcto para uno que canceló el propio empleado
 * desde la pantalla en la que está mirando, pero para uno que canceló EL CLIENTE por WhatsApp,
 * sin que nadie del negocio hiciera nada, la orden se esfuma sin que quede ningún rastro visible
 * en ninguna pantalla ni reporte. El negocio no se entera de que pasó, solo de que ya no está.
 *
 * Esta columna es la mitad de datos que le falta a Despacho para poder mostrar, aparte de los
 * pedidos activos, los cancelados recientes — y decir si los canceló el propio negocio o el
 * cliente (`pedidoService.getOrdenesCanceladasRecientes`).
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-cancelado-por
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
        console.log('→ Migración Restaurante - cancelado_por\n');

        console.log('1. Columna cancelado_por en pedid_orden...');
        await agregarColumna({
            esquema: 'restaurante', tabla: 'pedid_orden', columna: 'cancelado_por',
            definicion: "VARCHAR(10) CHECK (cancelado_por IN ('cliente', 'negocio'))",
            transaction: t,
        });

        await t.commit();
        console.log('\n✓ Migración cancelado_por completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
