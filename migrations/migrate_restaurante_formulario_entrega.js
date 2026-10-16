/**
 * Migración: formulario de entrega por WhatsApp (WhatsApp Flows), por negocio.
 *
 *  - general.gener_negocio.formulario_entrega_flow_id  (VARCHAR(40), NULL)
 *
 * El id del Flow PUBLICADO en la WABA del negocio. Es a la vez el interruptor: NULL = apagado,
 * y el asistente pregunta con los botones de siempre. Nace NULL para todos —añade una función,
 * como los `permite_*`— y se llena con `scripts/formulario_entrega_whatsapp.js`, que crea y
 * publica el Flow en la cuenta correcta. Ver `docs/whatsapp-flows.md`.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-formulario-entrega
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
        console.log('→ Migración Restaurante - Formulario de entrega por WhatsApp\n');

        console.log('1. Id del Flow publicado del negocio (NULL = apagado)...');
        await agregarColumna({
            esquema: 'general', tabla: 'gener_negocio', columna: 'formulario_entrega_flow_id',
            definicion: 'VARCHAR(40) NULL', transaction: t,
        });

        // gener_negocio ya lleva su trigger trg_audit desde migrate_auditoria_*:
        // una columna nueva entra sola en el snapshot JSONB.

        await t.commit();
        console.log('\n✓ Migración Formulario de entrega completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
