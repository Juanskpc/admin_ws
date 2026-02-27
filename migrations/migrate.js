/**
 * Script de migración para la base de datos.
 * Ejecutar con: npm run migrate
 *
 * Cambios:
 * 1.  Crea esquema 'general' si no existe
 * 2.  Crea tabla gener_tipo_negocio (tipos de negocio)
 * 3.  Inserta tipos de negocio por defecto
 * 4.  Agrega columna id_tipo_negocio a gener_negocio con FK
 * 5.  Agrega columnas id_tipo_negocio, fecha_creacion, fecha_actualizacion a gener_rol con FK
 * 6.  Inserta roles por defecto según tipo de negocio
 * 7.  Crea tabla gener_rol_nivel (permisos de rol por nivel/vista)
 * 8.  Crea tabla gener_negocio_usuario (relación usuario-negocio)
 * 9.  Crea tabla gener_usuario_rol (relación usuario-rol-negocio)
 * 10. Migra datos existentes de id_rol en gener_usuario a la nueva tabla
 * 11. Elimina columna id_rol de gener_usuario
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

        // 2. Crear tabla gener_tipo_negocio
        console.log('2. Creando tabla gener_tipo_negocio...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS general.gener_tipo_negocio (
                id_tipo_negocio SERIAL PRIMARY KEY,
                nombre VARCHAR(100) NOT NULL UNIQUE,
                descripcion VARCHAR(255),
                estado CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        console.log('   Tabla gener_tipo_negocio creada\n');

        // 3. Insertar tipos de negocio por defecto
        console.log('3. Insertando tipos de negocio...');
        await sequelize.query(`
            INSERT INTO general.gener_tipo_negocio (nombre, descripcion, estado)
            VALUES 
                ('RESTAURANTE', 'Negocio de tipo restaurante', 'A'),
                ('PARQUEADERO', 'Negocio de tipo parqueadero', 'A'),
                ('BARBERIA', 'Negocio de tipo barbería', 'A'),
                ('SUPERMERCADO', 'Negocio de tipo supermercado', 'A'),
                ('GESTION DE TALLER AUTOMOTRIZ', 'Negocio de gestión de taller automotriz', 'A'),
                ('FONDO DE AHORROS', 'Negocio de tipo fondo de ahorros', 'A'),
                ('FINANCIERA DE PRESTAMOS', 'Negocio de tipo financiera de préstamos', 'A')
            ON CONFLICT (nombre) DO NOTHING;
        `, { transaction: t });
        console.log('   Tipos de negocio insertados\n');

        // 4. Agregar columna id_tipo_negocio a gener_negocio
        console.log('4. Verificando columna id_tipo_negocio en gener_negocio...');
        const [colTipoNeg] = await sequelize.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'general'
              AND table_name = 'gener_negocio'
              AND column_name = 'id_tipo_negocio';
        `, { transaction: t });

        if (colTipoNeg.length === 0) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio
                ADD COLUMN id_tipo_negocio INTEGER,
                ADD CONSTRAINT fk_negocio_tipo_negocio
                    FOREIGN KEY (id_tipo_negocio) REFERENCES general.gener_tipo_negocio(id_tipo_negocio);
            `, { transaction: t });
            console.log('   Columna id_tipo_negocio agregada con FK\n');
        } else {
            console.log('   Columna id_tipo_negocio ya existe, omitiendo\n');
        }

        // 5. Agregar columnas a gener_rol (id_tipo_negocio + fechas + FK)
        console.log('5. Verificando columnas en gener_rol...');
        const [colRolTipo] = await sequelize.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'general'
              AND table_name = 'gener_rol'
              AND column_name = 'id_tipo_negocio';
        `, { transaction: t });

        if (colRolTipo.length === 0) {
            await sequelize.query(`
                ALTER TABLE general.gener_rol
                ADD COLUMN id_tipo_negocio INTEGER,
                ADD COLUMN fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                ADD COLUMN fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                ADD CONSTRAINT fk_rol_tipo_negocio
                    FOREIGN KEY (id_tipo_negocio) REFERENCES general.gener_tipo_negocio(id_tipo_negocio);
            `, { transaction: t });
            console.log('   Columnas agregadas a gener_rol\n');
        } else {
            console.log('   gener_rol ya tiene id_tipo_negocio, omitiendo\n');
        }

        // 6. Insertar roles por defecto según tipo de negocio
        console.log('6. Insertando roles por defecto...');
        await sequelize.query(`
            INSERT INTO general.gener_rol (descripcion, id_tipo_negocio, estado) VALUES
            ('SUPER ADMINISTRADOR', NULL, 'A'),
            ('ADMINISTRADOR', 1, 'A'), ('CAJERO', 1, 'A'), ('MESERO', 1, 'A'), ('COCINERO', 1, 'A'), ('DOMICILIARIO', 1, 'A'),
            ('ADMINISTRADOR', 2, 'A'), ('OPERADOR', 2, 'A'), ('VIGILANTE', 2, 'A'),
            ('ADMINISTRADOR', 3, 'A'), ('BARBERO', 3, 'A'), ('RECEPCIONISTA', 3, 'A'),
            ('ADMINISTRADOR', 4, 'A'), ('CAJERO', 4, 'A'), ('BODEGUERO', 4, 'A'), ('SUPERVISOR', 4, 'A'),
            ('ADMINISTRADOR', 5, 'A'), ('MECANICO', 5, 'A'), ('RECEPCIONISTA', 5, 'A'), ('ASESOR DE SERVICIO', 5, 'A'),
            ('ADMINISTRADOR', 6, 'A'), ('TESORERO', 6, 'A'), ('ASESOR', 6, 'A'), ('AUDITOR', 6, 'A'),
            ('ADMINISTRADOR', 7, 'A'), ('ASESOR DE CREDITO', 7, 'A'), ('COBRADOR', 7, 'A'), ('ANALISTA DE RIESGO', 7, 'A'), ('CAJERO', 7, 'A')
            ON CONFLICT DO NOTHING;
        `, { transaction: t });
        console.log('   Roles insertados\n');

        // 7. Crear tabla gener_rol_nivel (permisos de rol por nivel/vista)
        console.log('7. Creando tabla gener_rol_nivel...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS general.gener_rol_nivel (
                id_rol_nivel SERIAL PRIMARY KEY,
                id_rol INTEGER NOT NULL,
                id_nivel INTEGER NOT NULL,
                puede_ver BOOLEAN NOT NULL DEFAULT true,
                puede_crear BOOLEAN NOT NULL DEFAULT false,
                puede_editar BOOLEAN NOT NULL DEFAULT false,
                puede_eliminar BOOLEAN NOT NULL DEFAULT false,
                estado CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_rn_rol FOREIGN KEY (id_rol)
                    REFERENCES general.gener_rol(id_rol) ON DELETE CASCADE,
                CONSTRAINT fk_rn_nivel FOREIGN KEY (id_nivel)
                    REFERENCES general.gener_nivel(id_nivel) ON DELETE CASCADE,
                CONSTRAINT uq_rol_nivel UNIQUE (id_rol, id_nivel)
            );
        `, { transaction: t });
        console.log('   Tabla gener_rol_nivel creada\n');

        // 8. Crear tabla gener_negocio_usuario
        console.log('8. Creando tabla gener_negocio_usuario...');
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

        // 9. Crear tabla gener_usuario_rol
        console.log('9. Creando tabla gener_usuario_rol...');
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

        // 10. Migrar datos existentes (si la columna id_rol existe en gener_usuario)
        console.log('10. Migrando roles existentes...');
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

            // 11. Eliminar columna id_rol de gener_usuario
            console.log('11. Eliminando columna id_rol de gener_usuario...');
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
