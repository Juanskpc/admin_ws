/**
 * Migración: Auditoría de impersonación de super administrador
 *
 * Tabla creada:
 *   general.gener_impersonacion → Registro de cada vez que un super admin
 *                                 inicia sesión como otro usuario.
 *
 * Idempotente. Ejecutar con: npm run migrate:impersonacion
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: Auditoría de impersonación\n');

        console.log('1. Creando tabla gener_impersonacion...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS general.gener_impersonacion (
                id_impersonacion       SERIAL PRIMARY KEY,
                id_admin               INTEGER NOT NULL,
                id_usuario_objetivo    INTEGER NOT NULL,
                ip                     VARCHAR(64) NULL,
                user_agent             VARCHAR(512) NULL,
                fecha_inicio           TIMESTAMP DEFAULT NOW(),
                CONSTRAINT fk_impersonacion_admin
                    FOREIGN KEY (id_admin)
                    REFERENCES general.gener_usuario(id_usuario)
                    ON DELETE CASCADE,
                CONSTRAINT fk_impersonacion_objetivo
                    FOREIGN KEY (id_usuario_objetivo)
                    REFERENCES general.gener_usuario(id_usuario)
                    ON DELETE CASCADE
            );
        `, { transaction: t });

        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_impersonacion_admin
            ON general.gener_impersonacion (id_admin, fecha_inicio DESC);
        `, { transaction: t });

        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_impersonacion_objetivo
            ON general.gener_impersonacion (id_usuario_objetivo, fecha_inicio DESC);
        `, { transaction: t });

        console.log('   ✓ Tabla gener_impersonacion creada.');

        await t.commit();
        console.log('\n✓ Migración de impersonación completada exitosamente.');
    } catch (err) {
        await t.rollback();
        console.error('\n✗ Error en migración:', err.message);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
