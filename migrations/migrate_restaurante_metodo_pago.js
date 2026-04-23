/**
 * Migración: métodos de pago del restaurante.
 *  - Crea restaurante.rest_metodo_pago (catálogo por negocio).
 *  - Agrega columna pedid_orden.id_metodo_pago (nullable, FK opcional).
 *
 * Idempotente. Ejecutar con: npm run migrate:restaurante-metodo-pago
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - Métodos de pago\n');

        console.log('1. Creando restaurante.rest_metodo_pago...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_metodo_pago (
                id_metodo_pago  SERIAL PRIMARY KEY,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                nombre          VARCHAR(80) NOT NULL,
                estado          CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_rest_metodo_pago_nombre
                ON restaurante.rest_metodo_pago (id_negocio, LOWER(nombre))
                WHERE estado = 'A';
            CREATE INDEX IF NOT EXISTS ix_rest_metodo_pago_neg
                ON restaurante.rest_metodo_pago (id_negocio, estado);
        `, { transaction: t });

        console.log('2. Agregando columna pedid_orden.id_metodo_pago...');
        const [cols] = await sequelize.query(`
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='restaurante' AND table_name='pedid_orden'
              AND column_name='id_metodo_pago';
        `, { transaction: t });
        if (cols.length === 0) {
            await sequelize.query(`
                ALTER TABLE restaurante.pedid_orden
                ADD COLUMN id_metodo_pago INTEGER
                    REFERENCES restaurante.rest_metodo_pago(id_metodo_pago) ON DELETE SET NULL;
            `, { transaction: t });
        }

        console.log('3. Sembrando métodos por defecto para restaurantes activos sin métodos...');
        await sequelize.query(`
            INSERT INTO restaurante.rest_metodo_pago (id_negocio, nombre, estado)
            SELECT n.id_negocio, m.nombre, 'A'
            FROM general.gener_negocio n
            CROSS JOIN (VALUES ('Efectivo'), ('Tarjeta'), ('Transferencia')) AS m(nombre)
            WHERE n.id_tipo_negocio = 1 AND n.estado = 'A'
              AND NOT EXISTS (
                  SELECT 1 FROM restaurante.rest_metodo_pago mp
                  WHERE mp.id_negocio = n.id_negocio AND mp.estado = 'A'
              );
        `, { transaction: t });

        await t.commit();
        console.log('\n✓ Migración Métodos de Pago completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
