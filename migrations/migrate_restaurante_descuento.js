/**
 * Migración: Descuento en pedidos + interruptor del aviso de cobro al enviar.
 *
 *  - general.gener_negocio.permite_descuento     (BOOLEAN, default false)
 *      Opt-in: habilita registrar un descuento al tomar el pedido.
 *  - general.gener_negocio.pregunta_cobro_envio  (BOOLEAN, default false)
 *      Opt-in: al enviar a despacho/caja, vuelve a preguntar "Cobrar ahora" o
 *      "Enviar sin cobrar". Apagado (el default) el pedido se envía sin cobrar
 *      y sin interrumpir al mesero, que era la queja.
 *  - restaurante.pedid_orden.descuento           (NUMERIC(12,2), default 0)
 *      Rebaja aplicada al pedido. Va RESTADA dentro de `total`, igual que
 *      `valor_domicilio` va sumado: caja, multipago y reportes siguen cuadrando
 *      contra un único número.
 *
 * Los tres nacen apagados/en cero, así que ningún negocio existente cambia de
 * comportamiento hasta que su administrador active la opción en Configuración.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-descuento
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
        console.log('→ Migración Restaurante - Descuento y aviso de cobro\n');

        console.log('1. Flags del negocio (activables por el admin en Configuración)...');
        await agregarColumna({
            esquema: 'general', tabla: 'gener_negocio', columna: 'permite_descuento',
            definicion: 'BOOLEAN NOT NULL DEFAULT false', transaction: t,
        });
        await agregarColumna({
            esquema: 'general', tabla: 'gener_negocio', columna: 'pregunta_cobro_envio',
            definicion: 'BOOLEAN NOT NULL DEFAULT false', transaction: t,
        });

        console.log('2. Descuento de la orden...');
        await agregarColumna({
            esquema: 'restaurante', tabla: 'pedid_orden', columna: 'descuento',
            definicion: 'NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (descuento >= 0)', transaction: t,
        });

        // pedid_orden y gener_negocio ya llevan su trigger trg_audit desde
        // migrate_auditoria_*: una columna nueva entra sola en el snapshot JSONB.

        await t.commit();
        console.log('\n✓ Migración Descuento completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
