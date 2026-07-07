/**
 * Migración: Multipago del restaurante.
 *  - Agrega general.gener_negocio.permite_multipago (BOOLEAN, default false).
 *    Flag que el administrador activa en Configuración.
 *  - Crea restaurante.rest_pago_orden: desglose de N formas de pago por orden
 *    (cuando el cobro se hace con Multipago). Para pago simple se sigue usando
 *    pedid_orden.id_metodo_pago.
 *  - Registra el trigger trg_audit sobre rest_pago_orden (tabla con dinero →
 *    regla fija de auditoría).
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-multipago
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - Multipago\n');

        // 1. Flag permite_multipago en el negocio (activable por el admin)
        console.log('1. Agregando columna general.gener_negocio.permite_multipago...');
        const [flagCol] = await sequelize.query(`
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='general' AND table_name='gener_negocio'
              AND column_name='permite_multipago';
        `, { transaction: t });
        if (flagCol.length === 0) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio
                ADD COLUMN permite_multipago BOOLEAN NOT NULL DEFAULT false;
            `, { transaction: t });
            console.log('   ✓ columna creada');
        } else {
            console.log('   • ya existía, se omite');
        }

        // 2. Tabla de desglose de pagos por orden
        console.log('2. Creando restaurante.rest_pago_orden...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_pago_orden (
                id_pago        SERIAL PRIMARY KEY,
                id_orden       INTEGER NOT NULL
                    REFERENCES restaurante.pedid_orden(id_orden) ON DELETE CASCADE,
                id_metodo_pago INTEGER NOT NULL
                    REFERENCES restaurante.rest_metodo_pago(id_metodo_pago) ON DELETE RESTRICT,
                valor          NUMERIC(12,2) NOT NULL CHECK (valor > 0),
                fecha          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS ix_rest_pago_orden_orden
                ON restaurante.rest_pago_orden (id_orden);
            CREATE INDEX IF NOT EXISTS ix_rest_pago_orden_metodo
                ON restaurante.rest_pago_orden (id_metodo_pago);
        `, { transaction: t });

        // 3. Trigger de auditoría (solo si la infraestructura de auditoría existe)
        console.log('3. Registrando trigger trg_audit sobre rest_pago_orden...');
        const [fnAudit] = await sequelize.query(`
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname='auditoria' AND p.proname='fn_audit';
        `, { transaction: t });
        if (fnAudit.length > 0) {
            await sequelize.query(
                `DROP TRIGGER IF EXISTS trg_audit ON restaurante.rest_pago_orden;`,
                { transaction: t }
            );
            await sequelize.query(
                `CREATE TRIGGER trg_audit
                     AFTER INSERT OR UPDATE OR DELETE ON restaurante.rest_pago_orden
                     FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('id_pago');`,
                { transaction: t }
            );
            console.log('   ✓ trigger creado');
        } else {
            console.log('   ! auditoria.fn_audit no existe; se omite el trigger (ejecuta migrate:auditoria-base)');
        }

        await t.commit();
        console.log('\n✓ Migración Multipago completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
