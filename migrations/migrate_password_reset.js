/**
 * migrate_password_reset.js
 * Crea la tabla general.password_reset_tokens para el flujo OTP.
 *
 * Uso: node migrations/migrate_password_reset.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('Iniciando migración: password_reset_tokens...\n');

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS general.password_reset_tokens (
                id          BIGSERIAL PRIMARY KEY,
                id_usuario  INTEGER   NOT NULL
                            REFERENCES general.gener_usuario(id_usuario) ON DELETE CASCADE,
                token_hash  TEXT      NOT NULL,
                expires_at  TIMESTAMPTZ NOT NULL,
                used        BOOLEAN   NOT NULL DEFAULT FALSE,
                attempts    INTEGER   NOT NULL DEFAULT 0,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `, { transaction: t });

        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_prt_id_usuario
                ON general.password_reset_tokens(id_usuario);
        `, { transaction: t });

        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_prt_expires_used
                ON general.password_reset_tokens(expires_at, used);
        `, { transaction: t });

        await t.commit();
        console.log('✅ Tabla general.password_reset_tokens creada correctamente');
        console.log('   Índices creados: idx_prt_id_usuario, idx_prt_expires_used');
    } catch (err) {
        await t.rollback();
        console.error('❌ Error en migración:', err.message);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
