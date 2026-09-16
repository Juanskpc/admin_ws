/**
 * Migración: interruptor para que el propio personal del restaurante (mesero, cajero,
 * el dueño) pueda elegirse como domiciliario, no solo quien tenga el rol DOMICILIARIO.
 *
 *  - general.gener_negocio.permite_domicilio_personal  (BOOLEAN, default FALSE)
 *
 * En negocios pequeños no hay un domiciliario dedicado: sale a repartir quien esté libre.
 * Encendido, `GET /restaurante/domiciliarios` lista a todo el personal activo del negocio
 * (gener_negocio_usuario) en vez de solo a quienes tienen el rol DOMICILIARIO.
 *
 * Opt-in (nace apagado, como `permite_multipago` / `permite_cuentas_cliente`): añade una
 * opción que antes no existía, así que el cambio de comportamiento lo pide cada negocio.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-domicilio-personal
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
        console.log('→ Migración Restaurante - Domiciliario = personal del negocio\n');

        console.log('1. Interruptor del negocio (se enciende desde Configuración > Operación)...');
        await agregarColumna({
            esquema: 'general', tabla: 'gener_negocio', columna: 'permite_domicilio_personal',
            definicion: 'BOOLEAN NOT NULL DEFAULT false', transaction: t,
        });

        // gener_negocio ya lleva su trigger trg_audit desde migrate_auditoria_*:
        // una columna nueva entra sola en el snapshot JSONB.

        await t.commit();
        console.log('\n✓ Migración Domiciliario = personal completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
