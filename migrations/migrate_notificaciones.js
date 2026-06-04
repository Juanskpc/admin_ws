/**
 * Migración: Sistema de notificaciones y control de avisos de plan
 *
 * Tablas creadas:
 *   general.gener_notificacion       → Notificaciones internas del usuario
 *   general.gener_aviso_plan_enviado → Control de avisos de vencimiento enviados
 *
 * Idempotente. Ejecutar con: npm run migrate:notificaciones
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: Sistema de notificaciones\n');

        // 1. Crear tabla gener_notificacion
        console.log('1. Creando tabla gener_notificacion...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS general.gener_notificacion (
                id_notificacion   SERIAL PRIMARY KEY,
                id_negocio        INTEGER NOT NULL,
                tipo              VARCHAR(50) NOT NULL,
                titulo            VARCHAR(255) NOT NULL,
                mensaje           TEXT NOT NULL,
                leida             BOOLEAN DEFAULT FALSE,
                fecha_creacion    TIMESTAMP DEFAULT NOW(),
                fecha_lectura     TIMESTAMP NULL,
                CONSTRAINT fk_notificacion_negocio
                    FOREIGN KEY (id_negocio)
                    REFERENCES general.gener_negocio(id_negocio)
                    ON DELETE CASCADE
            );
        `, { transaction: t });

        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_notificacion_negocio_leida
            ON general.gener_notificacion (id_negocio, leida);
        `, { transaction: t });

        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_notificacion_fecha
            ON general.gener_notificacion (fecha_creacion DESC);
        `, { transaction: t });

        console.log('   ✓ Tabla gener_notificacion creada.');

        // 2. Crear tabla gener_aviso_plan_enviado
        console.log('\n2. Creando tabla gener_aviso_plan_enviado...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS general.gener_aviso_plan_enviado (
                id_aviso              SERIAL PRIMARY KEY,
                id_negocio_plan       INTEGER NOT NULL,
                tipo_aviso            VARCHAR(20) NOT NULL,
                fecha_envio           TIMESTAMP DEFAULT NOW(),
                email_enviado         BOOLEAN DEFAULT FALSE,
                notificacion_creada   BOOLEAN DEFAULT FALSE,
                CONSTRAINT fk_aviso_negocio_plan
                    FOREIGN KEY (id_negocio_plan)
                    REFERENCES general.gener_negocio_plan(id_negocio_plan)
                    ON DELETE CASCADE,
                CONSTRAINT uq_aviso_plan_tipo
                    UNIQUE (id_negocio_plan, tipo_aviso),
                CONSTRAINT chk_tipo_aviso
                    CHECK (tipo_aviso IN ('5_DIAS', '1_DIA'))
            );
        `, { transaction: t });

        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_aviso_plan
            ON general.gener_aviso_plan_enviado (id_negocio_plan);
        `, { transaction: t });

        console.log('   ✓ Tabla gener_aviso_plan_enviado creada.');

        await t.commit();
        console.log('\n✓ Migración de notificaciones completada exitosamente.');
    } catch (err) {
        await t.rollback();
        console.error('\n✗ Error en migración:', err.message);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
