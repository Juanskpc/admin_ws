/**
 * Script de migración para la base de datos.
 * Ejecutar con: npm run migrate
 *
 * Cambios:
 * 1. Crea esquema 'general' si no existe
 * 2. Crea tabla gener_negocio_usuario (relación usuario-negocio)
 * 3. Crea tabla gener_usuario_rol (relación usuario-rol-negocio)
 * 4. Migra datos existentes de id_rol en gener_usuario a la nueva tabla
 * 5. Elimina columna id_rol de gener_usuario
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('Iniciando migración...\n');

        // 1. Crear esquema si no existe
        console.log('1. Verificando esquema general...');
        await sequelize.query('CREATE SCHEMA IF NOT EXISTS general;', { transaction: t });
        console.log('   Esquema OK\n');

        // 2. Crear tabla gener_negocio_usuario
        console.log('2. Creando tabla gener_negocio_usuario...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS general.gener_negocio_usuario (
                id_negocio_usuario SERIAL PRIMARY KEY,
                id_usuario INTEGER NOT NULL,
                id_negocio INTEGER NOT NULL,
                estado CHAR(1) DEFAULT 'A',
                fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_nu_usuario FOREIGN KEY (id_usuario)
                    REFERENCES general.gener_usuario(id_usuario) ON DELETE CASCADE,
                CONSTRAINT fk_nu_negocio FOREIGN KEY (id_negocio)
                    REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                CONSTRAINT uq_negocio_usuario UNIQUE (id_usuario, id_negocio)
            );
        `, { transaction: t });
        console.log('   Tabla gener_negocio_usuario creada\n');

        // 3. Crear tabla gener_usuario_rol
        console.log('3. Creando tabla gener_usuario_rol...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS general.gener_usuario_rol (
                id_usuario_rol SERIAL PRIMARY KEY,
                id_usuario INTEGER NOT NULL,
                id_rol INTEGER NOT NULL,
                id_negocio INTEGER,
                estado CHAR(1) DEFAULT 'A',
                fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_ur_usuario FOREIGN KEY (id_usuario)
                    REFERENCES general.gener_usuario(id_usuario) ON DELETE CASCADE,
                CONSTRAINT fk_ur_rol FOREIGN KEY (id_rol)
                    REFERENCES general.gener_rol(id_rol) ON DELETE CASCADE,
                CONSTRAINT fk_ur_negocio FOREIGN KEY (id_negocio)
                    REFERENCES general.gener_negocio(id_negocio) ON DELETE SET NULL,
                CONSTRAINT uq_usuario_rol_negocio UNIQUE (id_usuario, id_rol, id_negocio)
            );
        `, { transaction: t });
        console.log('   Tabla gener_usuario_rol creada\n');

        // 4. Migrar datos existentes (si la columna id_rol existe en gener_usuario)
        console.log('4. Migrando roles existentes...');
        const [colExists] = await sequelize.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'general'
              AND table_name = 'gener_usuario'
              AND column_name = 'id_rol';
        `, { transaction: t });

        if (colExists.length > 0) {
            await sequelize.query(`
                INSERT INTO general.gener_usuario_rol (id_usuario, id_rol, id_negocio, estado)
                SELECT u.id_usuario, u.id_rol, nu.id_negocio, 'A'
                FROM general.gener_usuario u
                LEFT JOIN general.gener_negocio_usuario nu ON nu.id_usuario = u.id_usuario
                WHERE u.id_rol IS NOT NULL
                ON CONFLICT DO NOTHING;
            `, { transaction: t });

            // 5. Eliminar columna id_rol de gener_usuario
            console.log('5. Eliminando columna id_rol de gener_usuario...');
            await sequelize.query(`
                ALTER TABLE general.gener_usuario DROP COLUMN IF EXISTS id_rol;
            `, { transaction: t });
            console.log('   Columna eliminada\n');
        } else {
            console.log('   La columna id_rol ya no existe, omitiendo migración de datos\n');
        }

        await t.commit();
        console.log('Migración completada exitosamente');
    } catch (error) {
        await t.rollback();
        console.error('Error en migración:', error.message);
        console.error(error);
    } finally {
        await sequelize.close();
        process.exit(0);
    }
}

migrate();
