/**
 * Migración inicial del módulo Gimnasio (Fase 1).
 * Crea: tipo_negocio GIMNASIO + roles + esquema gym + 5 tablas + niveles + permisos.
 *
 * Idempotente. Ejecutar con: npm run migrate:gym
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Gimnasio (Fase 1)\n');

        // 1. Tipo de negocio GIMNASIO
        console.log('1. Insertando tipo de negocio GIMNASIO...');
        await sequelize.query(`
            INSERT INTO general.gener_tipo_negocio (nombre, descripcion, estado)
            VALUES ('GIMNASIO', 'Negocio de tipo gimnasio / fitness', 'A')
            ON CONFLICT (nombre) DO NOTHING;
        `, { transaction: t });

        const [[tipoGym]] = await sequelize.query(`
            SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre='GIMNASIO';
        `, { transaction: t });
        const idTipoGym = tipoGym.id_tipo_negocio;
        console.log(`   id_tipo_negocio = ${idTipoGym}\n`);

        // 2. Roles del gimnasio
        console.log('2. Insertando roles...');
        await sequelize.query(`
            INSERT INTO general.gener_rol (descripcion, id_tipo_negocio, estado) VALUES
                ('ADMINISTRADOR', :tipo, 'A'),
                ('ENTRENADOR',    :tipo, 'A'),
                ('RECEPCION',     :tipo, 'A'),
                ('CAJERO',        :tipo, 'A')
            ON CONFLICT DO NOTHING;
        `, { replacements: { tipo: idTipoGym }, transaction: t });

        const rolesGym = await sequelize.query(`
            SELECT id_rol, descripcion FROM general.gener_rol
            WHERE id_tipo_negocio = :tipo AND estado = 'A';
        `, { replacements: { tipo: idTipoGym }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const rolAdmin = rolesGym.find(r => r.descripcion === 'ADMINISTRADOR').id_rol;
        console.log('   ' + rolesGym.map(r => `${r.descripcion}=${r.id_rol}`).join(', ') + '\n');

        // 3. Esquema gym
        console.log('3. Creando esquema gym...');
        await sequelize.query(`CREATE SCHEMA IF NOT EXISTS gym;`, { transaction: t });
        console.log('   OK\n');

        // 4. gym_miembro
        console.log('4. Creando gym.gym_miembro...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS gym.gym_miembro (
                id_miembro        SERIAL PRIMARY KEY,
                id_negocio        INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                primer_nombre     VARCHAR(80)  NOT NULL,
                segundo_nombre    VARCHAR(80),
                primer_apellido   VARCHAR(80)  NOT NULL,
                segundo_apellido  VARCHAR(80),
                num_identificacion VARCHAR(40),
                email             VARCHAR(160),
                telefono          VARCHAR(40),
                fecha_nacimiento  DATE,
                sexo              CHAR(1) CHECK (sexo IN ('M','F','O') OR sexo IS NULL),
                peso_kg           NUMERIC(5,2),
                altura_cm         NUMERIC(5,2),
                porcentaje_grasa  NUMERIC(4,2),
                direccion         VARCHAR(255),
                ciudad            VARCHAR(120),
                codigo_postal     VARCHAR(20),
                alergias          TEXT,
                condiciones_medicas TEXT,
                contacto_emergencia_nombre   VARCHAR(160),
                contacto_emergencia_telefono VARCHAR(40),
                foto_url          VARCHAR(500),
                codigo_qr         VARCHAR(60) UNIQUE NOT NULL,
                estado            VARCHAR(20) NOT NULL DEFAULT 'ACTIVO'
                                  CHECK (estado IN ('ACTIVO','SUSPENDIDO','MOROSO','INACTIVO')),
                fecha_registro    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_gym_miembro_negocio ON gym.gym_miembro (id_negocio);
            CREATE INDEX IF NOT EXISTS ix_gym_miembro_estado  ON gym.gym_miembro (id_negocio, estado);
            CREATE INDEX IF NOT EXISTS ix_gym_miembro_busqueda
                ON gym.gym_miembro (id_negocio, primer_apellido, primer_nombre);
        `, { transaction: t });
        console.log('   OK\n');

        // 5. gym_plan
        console.log('5. Creando gym.gym_plan...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS gym.gym_plan (
                id_plan          SERIAL PRIMARY KEY,
                id_negocio       INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                nombre           VARCHAR(120) NOT NULL,
                descripcion      TEXT,
                precio           NUMERIC(12,2) NOT NULL CHECK (precio >= 0),
                duracion_meses   INTEGER NOT NULL CHECK (duracion_meses > 0),
                beneficios       TEXT,
                estado           CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_gym_plan_negocio ON gym.gym_plan (id_negocio, estado);
        `, { transaction: t });
        console.log('   OK\n');

        // 6. gym_membresia
        console.log('6. Creando gym.gym_membresia...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS gym.gym_membresia (
                id_membresia    SERIAL PRIMARY KEY,
                id_miembro      INTEGER NOT NULL REFERENCES gym.gym_miembro(id_miembro) ON DELETE CASCADE,
                id_plan         INTEGER NOT NULL REFERENCES gym.gym_plan(id_plan),
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                fecha_inicio    DATE NOT NULL,
                fecha_fin       DATE NOT NULL,
                precio_pagado   NUMERIC(12,2) NOT NULL,
                estado          VARCHAR(20) NOT NULL DEFAULT 'ACTIVA'
                                CHECK (estado IN ('ACTIVA','VENCIDA','PAUSADA','CANCELADA')),
                pausada_desde   DATE,
                pausada_hasta   DATE,
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_gym_membresia_miembro ON gym.gym_membresia (id_miembro, estado);
            CREATE INDEX IF NOT EXISTS ix_gym_membresia_negocio ON gym.gym_membresia (id_negocio, estado);
            CREATE INDEX IF NOT EXISTS ix_gym_membresia_vencimiento ON gym.gym_membresia (id_negocio, fecha_fin);
        `, { transaction: t });
        console.log('   OK\n');

        // 7. gym_pago
        console.log('7. Creando gym.gym_pago...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS gym.gym_pago (
                id_pago         SERIAL PRIMARY KEY,
                id_membresia    INTEGER REFERENCES gym.gym_membresia(id_membresia) ON DELETE SET NULL,
                id_miembro      INTEGER NOT NULL REFERENCES gym.gym_miembro(id_miembro),
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_usuario_cobro INTEGER REFERENCES general.gener_usuario(id_usuario),
                monto           NUMERIC(12,2) NOT NULL CHECK (monto >= 0),
                metodo          VARCHAR(20) NOT NULL CHECK (metodo IN ('EFECTIVO','TARJETA','TRANSFERENCIA','OTRO')),
                concepto        VARCHAR(255),
                estado          VARCHAR(20) NOT NULL DEFAULT 'PAGADO'
                                CHECK (estado IN ('PAGADO','PENDIENTE','ANULADO')),
                fecha_pago      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_gym_pago_negocio ON gym.gym_pago (id_negocio, fecha_pago DESC);
            CREATE INDEX IF NOT EXISTS ix_gym_pago_miembro ON gym.gym_pago (id_miembro, fecha_pago DESC);
        `, { transaction: t });
        console.log('   OK\n');

        // 8. gym_asistencia
        console.log('8. Creando gym.gym_asistencia...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS gym.gym_asistencia (
                id_asistencia   SERIAL PRIMARY KEY,
                id_miembro      INTEGER NOT NULL REFERENCES gym.gym_miembro(id_miembro) ON DELETE CASCADE,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                fecha_entrada   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_salida    TIMESTAMP,
                metodo          VARCHAR(20) NOT NULL DEFAULT 'MANUAL'
                                CHECK (metodo IN ('QR','MANUAL','HUELLA')),
                duracion_minutos INTEGER GENERATED ALWAYS AS (
                    CASE WHEN fecha_salida IS NOT NULL
                         THEN EXTRACT(EPOCH FROM (fecha_salida - fecha_entrada))::INTEGER / 60
                    END
                ) STORED
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_gym_asistencia_negocio_fecha
                ON gym.gym_asistencia (id_negocio, fecha_entrada DESC);
            CREATE INDEX IF NOT EXISTS ix_gym_asistencia_miembro
                ON gym.gym_asistencia (id_miembro, fecha_entrada DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_gym_asistencia_abierta_por_miembro
                ON gym.gym_asistencia (id_miembro)
                WHERE fecha_salida IS NULL;
        `, { transaction: t });
        console.log('   OK\n');

        // 9. Niveles de navegación
        console.log('9. Insertando niveles...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
            SELECT 'GIMNASIO', NULL, 'dumbbell', 'A', 1, '/gimnasio', :tipo
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/gimnasio'
            );
        `, { replacements: { tipo: idTipoGym }, transaction: t });

        const [[nivelRoot]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/gimnasio';
        `, { replacements: { tipo: idTipoGym }, transaction: t });
        const idNivelRoot = nivelRoot.id_nivel;

        const modulos = [
            ['DASHBOARD',    '/dashboard',    'layout-dashboard'],
            ['MIEMBROS',     '/miembros',     'users'],
            ['PLANES',       '/planes',       'badge-percent'],
            ['MEMBRESIAS',   '/membresias',   'id-card'],
            ['PAGOS',        '/pagos',        'banknote'],
            ['ASISTENCIAS',  '/asistencias',  'log-in'],
        ];
        for (const [desc, url, icono] of modulos) {
            await sequelize.query(`
                INSERT INTO general.gener_nivel
                    (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
                SELECT :desc, :padre, :icono, 'A', 1, :url, :tipo
                WHERE NOT EXISTS (
                    SELECT 1 FROM general.gener_nivel
                    WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = :url
                );
            `, { replacements: { desc, url, icono, padre: idNivelRoot, tipo: idTipoGym }, transaction: t });
        }
        console.log('   OK\n');

        // 10. Permisos por rol (matriz global)
        console.log('10. Asignando permisos a ADMINISTRADOR (acceso total)...');
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel, true, true, true, true, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo
              AND n.id_tipo_nivel = 1
              AND n.url IS NOT NULL
              AND n.url <> '/gimnasio'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolAdmin, tipo: idTipoGym }, transaction: t });

        // RECEPCION: dashboard, miembros, membresías, asistencias (sin pagos ni planes)
        const rolRecep = rolesGym.find(r => r.descripcion === 'RECEPCION').id_rol;
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel, true, true, true, false, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo
              AND n.id_tipo_nivel = 1
              AND n.url IN ('/dashboard','/miembros','/membresias','/asistencias')
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolRecep, tipo: idTipoGym }, transaction: t });

        // CAJERO: dashboard, miembros (lectura), pagos
        const rolCajero = rolesGym.find(r => r.descripcion === 'CAJERO').id_rol;
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel,
                   true,
                   CASE WHEN n.url = '/pagos' THEN true ELSE false END,
                   CASE WHEN n.url = '/pagos' THEN true ELSE false END,
                   false, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo
              AND n.id_tipo_nivel = 1
              AND n.url IN ('/dashboard','/miembros','/pagos')
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolCajero, tipo: idTipoGym }, transaction: t });

        // ENTRENADOR: dashboard, miembros (lectura), asistencias
        const rolEntr = rolesGym.find(r => r.descripcion === 'ENTRENADOR').id_rol;
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel, true,
                   CASE WHEN n.url = '/asistencias' THEN true ELSE false END,
                   false, false, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo
              AND n.id_tipo_nivel = 1
              AND n.url IN ('/dashboard','/miembros','/asistencias')
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolEntr, tipo: idTipoGym }, transaction: t });
        console.log('   OK\n');

        // 11. Backfill por-negocio (si ya existen negocios tipo GIMNASIO)
        console.log('11. Backfill gener_nivel_negocio para negocios GIMNASIO existentes...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT neg.id_negocio, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio neg
            JOIN general.gener_rol_nivel rn ON rn.id_rol IN (
                SELECT id_rol FROM general.gener_rol WHERE id_tipo_negocio = :tipo AND estado = 'A'
            )
            JOIN general.gener_nivel niv ON niv.id_nivel = rn.id_nivel
                                         AND niv.id_tipo_negocio = :tipo
                                         AND niv.id_tipo_nivel = 1
            WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
        `, { replacements: { tipo: idTipoGym }, transaction: t });
        console.log('   OK\n');

        await t.commit();
        console.log('✓ Migración Gimnasio completada');
        console.log(`  tipo_negocio = ${idTipoGym}, roles = ${rolesGym.map(r => r.descripcion).join(', ')}`);
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        console.error(error);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
