/**
 * Migración: el negocio confirma los pedidos que toma el asistente de WhatsApp.
 *
 *  - restaurante.pedid_orden.confirmado_en  (TIMESTAMP NULL)
 *      Cuándo una persona del negocio confirmó (dio por vista) la orden. NULL = sin confirmar.
 *
 * ## Por qué solo esta columna
 *
 * «Pendiente de confirmar» no se guarda: se deduce de `de_whatsapp AND confirmado_en IS NULL`
 * (ver `pedidoService.getOrdenesDespacho`). La razón es la misma que ya decidió `de_whatsapp`: que
 * el pedido lo tomó el bot lo dice su autor, y una segunda columna «origen» sería otra verdad que
 * alguien tiene que acordarse de rellenar. Lo único que el autor NO puede decir es si una persona
 * ya lo miró, y eso es lo que guarda esta columna. Para una orden tomada por una persona el valor
 * no significa nada y se queda en NULL.
 *
 * Es un instante y no un booleano por lo de siempre: la pregunta que sigue a «¿lo confirmaron?»
 * es «¿cuánto tardaron?», y con el instante se contesta sin otra columna.
 *
 * ## El backfill, y por qué solo la primera vez
 *
 * Las órdenes que ya existen se marcan confirmadas con su fecha de creación: sin eso, al
 * desplegar, todo pedido del bot que siga abierto aparecería de golpe como «sin confirmar» y
 * nadie sabría cuál es nuevo. Se hace solo en la ejecución que CREA la columna: repetir la
 * migración después no puede confirmar por su cuenta lo que llegó mientras tanto.
 *
 * Timestamp sin huso, como todo en este esquema: la sesión de Postgres está en `America/Bogota`
 * y estas columnas son hora de pared de Bogotá (ver `app_core/models/conection.js`).
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-confirmacion-asistente
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/** Agrega una columna solo si aún no existe (guarda por information_schema). @returns {boolean} true si la creó. */
async function agregarColumna({ esquema, tabla, columna, definicion, transaction }) {
    const [existe] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;
    `, { replacements: { esquema, tabla, columna }, transaction });

    if (existe.length > 0) {
        console.log(`   • ${esquema}.${tabla}.${columna} ya existía, se omite`);
        return false;
    }

    await sequelize.query(
        `ALTER TABLE ${esquema}.${tabla} ADD COLUMN ${columna} ${definicion};`,
        { transaction }
    );
    console.log(`   ✓ ${esquema}.${tabla}.${columna} creada`);
    return true;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - Confirmación de pedidos del asistente\n');

        console.log('1. Marca de confirmación en la orden...');
        const creada = await agregarColumna({
            esquema: 'restaurante', tabla: 'pedid_orden', columna: 'confirmado_en',
            definicion: 'TIMESTAMP NULL', transaction: t,
        });

        if (creada) {
            console.log('2. Las órdenes que ya existían se dan por confirmadas...');
            const [, meta] = await sequelize.query(
                `UPDATE restaurante.pedid_orden SET confirmado_en = fecha_creacion WHERE confirmado_en IS NULL;`,
                { transaction: t }
            );
            console.log(`   ✓ ${meta?.rowCount ?? 0} órdenes marcadas`);
        }

        // pedid_orden ya lleva su trigger trg_audit desde migrate_auditoria_*: una columna
        // nueva entra sola en el snapshot JSONB.

        await t.commit();
        console.log('\n✓ Migración Confirmación de pedidos del asistente completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
