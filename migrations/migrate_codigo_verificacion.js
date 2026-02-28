/**
 * migrate_codigo_verificacion.js
 * 
 * Migración que:
 *   1. Renombra la tabla general.password_reset_tokens → general.gener_codigo_verificacion
 *   2. Agrega columnas: email, tipo, id_plan
 *   3. Hace id_usuario nullable (para registro sin cuenta)
 *   4. Recrea índices con nombres adecuados
 *
 * Uso: node migrations/migrate_codigo_verificacion.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('Iniciando migración: gener_codigo_verificacion...\n');

        // ─── 1. Renombrar tabla ─────────────────────────────────────────
        await sequelize.query(`
            ALTER TABLE IF EXISTS general.password_reset_tokens
            RENAME TO gener_codigo_verificacion;
        `, { transaction: t });
        console.log('  ✔ Tabla renombrada a general.gener_codigo_verificacion');

        // ─── 2. Agregar columna "email" ─────────────────────────────────
        await sequelize.query(`
            ALTER TABLE general.gener_codigo_verificacion
            ADD COLUMN IF NOT EXISTS email VARCHAR(255);
        `, { transaction: t });
        console.log('  ✔ Columna "email" agregada');

        // ─── 3. Agregar columna "tipo" ──────────────────────────────────
        // Tipos: RESET_PASSWORD, REGISTRO
        await sequelize.query(`
            ALTER TABLE general.gener_codigo_verificacion
            ADD COLUMN IF NOT EXISTS tipo VARCHAR(30) NOT NULL DEFAULT 'RESET_PASSWORD';
        `, { transaction: t });
        console.log('  ✔ Columna "tipo" agregada');

        // ─── 4. Agregar columna "id_plan" (opcional, para registro) ─────
        await sequelize.query(`
            ALTER TABLE general.gener_codigo_verificacion
            ADD COLUMN IF NOT EXISTS id_plan INTEGER
            REFERENCES general.gener_plan(id_plan) ON DELETE SET NULL;
        `, { transaction: t });
        console.log('  ✔ Columna "id_plan" agregada');

        // ─── 5. Hacer id_usuario nullable ───────────────────────────────
        await sequelize.query(`
            ALTER TABLE general.gener_codigo_verificacion
            ALTER COLUMN id_usuario DROP NOT NULL;
        `, { transaction: t });
        console.log('  ✔ Columna "id_usuario" ahora es nullable');

        // ─── 6. Poblar email para registros existentes ──────────────────
        await sequelize.query(`
            UPDATE general.gener_codigo_verificacion cv
            SET email = u.email
            FROM general.gener_usuario u
            WHERE cv.id_usuario = u.id_usuario
              AND cv.email IS NULL;
        `, { transaction: t });
        console.log('  ✔ Emails poblados desde gener_usuario para registros existentes');

        // ─── 7. Renombrar índices existentes ────────────────────────────
        await sequelize.query(`
            ALTER INDEX IF EXISTS general.idx_prt_id_usuario
            RENAME TO idx_gcv_id_usuario;
        `, { transaction: t });

        await sequelize.query(`
            ALTER INDEX IF EXISTS general.idx_prt_expires_used
            RENAME TO idx_gcv_expires_used;
        `, { transaction: t });
        console.log('  ✔ Índices existentes renombrados');

        // ─── 8. Crear nuevos índices ────────────────────────────────────
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_gcv_email
                ON general.gener_codigo_verificacion(email);
        `, { transaction: t });

        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_gcv_tipo
                ON general.gener_codigo_verificacion(tipo);
        `, { transaction: t });

        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_gcv_email_tipo
                ON general.gener_codigo_verificacion(email, tipo, used);
        `, { transaction: t });

        console.log('  ✔ Nuevos índices creados');

        await t.commit();
        console.log('\n✅ Migración general.gener_codigo_verificacion completada correctamente');
        console.log('   Tabla: general.gener_codigo_verificacion');
        console.log('   Columnas nuevas: email, tipo, id_plan');
        console.log('   id_usuario ahora es nullable');
    } catch (err) {
        await t.rollback();
        console.error('❌ Error en migración:', err.message);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
