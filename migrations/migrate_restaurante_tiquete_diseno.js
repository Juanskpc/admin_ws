/**
 * Migración: diseño del tiquete impreso del restaurante.
 *
 * ## restaurante.tiquete_diseno
 *
 * Una fila por negocio con dos diseños: `comun` (el tiquete de siempre, el que también va a
 * cocina) y `electronica` (la representación gráfica de la factura electrónica). Cada uno guarda
 * solo lo que el negocio cambió; los valores por defecto viven en el frontend
 * (`shared/tiquete-diseno/tiquete-diseno.ts`), igual que en `carta_diseno`.
 *
 * **No se siembra ninguna fila.** Un negocio sin diseño imprime el tiquete por defecto, que
 * es el de siempre: el despliegue no le cambia el papel a nadie.
 *
 * `trg_audit` como en `carta_diseno`: conviene saber quién quitó el NIT del tiquete.
 *
 * Idempotente. npm run migrate:restaurante-tiquete-diseno
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('1. restaurante.tiquete_diseno...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.tiquete_diseno (
                id_tiquete_diseno SERIAL PRIMARY KEY,
                id_negocio        INTEGER   NOT NULL
                                  REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                comun             JSONB     NOT NULL DEFAULT '{}'::jsonb,
                electronica       JSONB     NOT NULL DEFAULT '{}'::jsonb,
                actualizado_en    TIMESTAMP NULL,
                id_usuario        INTEGER   NULL REFERENCES general.gener_usuario(id_usuario),
                fecha_creacion    TIMESTAMP NOT NULL DEFAULT now()
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS ux_tiquete_diseno_negocio
                ON restaurante.tiquete_diseno (id_negocio);
        `, { transaction: t });
        console.log('   OK\n');

        console.log('2. Trigger de auditoría...');
        const [[fnAudit]] = await sequelize.query(`
            SELECT 1 AS ok FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'auditoria' AND p.proname = 'fn_audit';
        `, { transaction: t });

        if (!fnAudit) {
            console.log('   ⚠️  auditoria.fn_audit no existe — se omite el trigger.');
        } else {
            await sequelize.query(
                'DROP TRIGGER IF EXISTS trg_audit ON restaurante.tiquete_diseno;',
                { transaction: t },
            );
            await sequelize.query(`
                CREATE TRIGGER trg_audit
                    AFTER INSERT OR UPDATE OR DELETE ON restaurante.tiquete_diseno
                    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('id_tiquete_diseno');
            `, { transaction: t });
            console.log('   ✓ tiquete_diseno');
        }
        console.log('   OK\n');

        await t.commit();
        console.log('✅ Migración de diseño de tiquete completada.');
    } catch (err) {
        await t.rollback();
        console.error('❌ Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
