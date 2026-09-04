/**
 * Migración: Pago a domiciliario (valor del domicilio).
 *  - Agrega general.gener_negocio.permite_pago_domicilio (BOOLEAN, default false).
 *    Flag OPT-IN que el administrador activa en Configuración. Nace en false para
 *    TODOS los negocios: quien ya opera hoy no ve ningún cambio.
 *  - Agrega restaurante.pedid_orden.valor_domicilio (NUMERIC(12,2), default 0).
 *    El valor se suma al total de la orden (lo paga el cliente) y al cobrarse
 *    genera un EGRESO en la caja por el pago al domiciliario (neto cero).
 *
 * No crea tablas nuevas: pedid_orden ya tiene su trigger trg_audit, así que el
 * cambio de valor_domicilio queda auditado sin trabajo extra.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-pago-domicilio
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function columnaExiste({ schema, table, column, transaction }) {
    const [rows] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = :schema AND table_name = :table AND column_name = :column;
    `, { replacements: { schema, table, column }, transaction });
    return rows.length > 0;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - Pago a domiciliario\n');

        // 1. Flag del negocio (opt-in desde Configuración)
        console.log('1. Agregando general.gener_negocio.permite_pago_domicilio...');
        const yaFlag = await columnaExiste({
            schema: 'general', table: 'gener_negocio', column: 'permite_pago_domicilio', transaction: t,
        });
        if (!yaFlag) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio
                ADD COLUMN permite_pago_domicilio BOOLEAN NOT NULL DEFAULT false;
            `, { transaction: t });
            console.log('   ✓ columna creada (default false para todos los negocios)');
        } else {
            console.log('   • ya existía, se omite');
        }

        // 2. Valor del domicilio por orden
        console.log('2. Agregando restaurante.pedid_orden.valor_domicilio...');
        const yaValor = await columnaExiste({
            schema: 'restaurante', table: 'pedid_orden', column: 'valor_domicilio', transaction: t,
        });
        if (!yaValor) {
            await sequelize.query(`
                ALTER TABLE restaurante.pedid_orden
                ADD COLUMN valor_domicilio NUMERIC(12,2) NOT NULL DEFAULT 0
                    CHECK (valor_domicilio >= 0);
            `, { transaction: t });
            console.log('   ✓ columna creada (0 en todas las órdenes existentes)');
        } else {
            console.log('   • ya existía, se omite');
        }

        await t.commit();
        console.log('\n✓ Migración Pago a domiciliario completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
