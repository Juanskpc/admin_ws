/**
 * Migración v2 del módulo Gimnasio:
 *   - Tablas de productos y ventas (POS).
 *   - Renombra módulo "Asistencias" → "Ingreso" (URL `/asistencias` → `/ingreso`).
 *   - Agrega módulos /productos, /ventas, /configuracion.
 *   - Permisos por rol + backfill por-negocio para gimnasios existentes.
 *
 * Idempotente. Ejecutar con: npm run migrate:gym-v2
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

const TIPO_GYM_NOMBRE = 'GIMNASIO';

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Gimnasio v2 (productos, ventas, ingreso, configuración)\n');

        const [[tipoGym]] = await sequelize.query(`
            SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = :nombre;
        `, { replacements: { nombre: TIPO_GYM_NOMBRE }, transaction: t });
        if (!tipoGym) throw new Error('No existe tipo_negocio GIMNASIO. Corré primero npm run migrate:gym');
        const idTipoGym = tipoGym.id_tipo_negocio;

        // 1. gym_producto
        console.log('1. Creando gym.gym_producto...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS gym.gym_producto (
                id_producto      SERIAL PRIMARY KEY,
                id_negocio       INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                nombre           VARCHAR(160) NOT NULL,
                sku              VARCHAR(60),
                descripcion      TEXT,
                categoria        VARCHAR(80),
                precio           NUMERIC(12,2) NOT NULL CHECK (precio >= 0),
                costo            NUMERIC(12,2),
                stock_actual     NUMERIC(12,2) NOT NULL DEFAULT 0,
                stock_minimo     NUMERIC(12,2) NOT NULL DEFAULT 0,
                foto_url         VARCHAR(500),
                estado           CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS ix_gym_producto_neg ON gym.gym_producto (id_negocio, estado);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_gym_producto_sku
                ON gym.gym_producto (id_negocio, LOWER(sku))
                WHERE sku IS NOT NULL;
        `, { transaction: t });

        // 2. gym_venta + detalle
        console.log('2. Creando gym.gym_venta y gym_venta_detalle...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS gym.gym_venta (
                id_venta          SERIAL PRIMARY KEY,
                id_negocio        INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_miembro        INTEGER REFERENCES gym.gym_miembro(id_miembro) ON DELETE SET NULL,
                id_usuario_cobro  INTEGER REFERENCES general.gener_usuario(id_usuario),
                total             NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
                metodo            VARCHAR(20) NOT NULL DEFAULT 'EFECTIVO'
                                  CHECK (metodo IN ('EFECTIVO','TARJETA','TRANSFERENCIA','OTRO')),
                estado            VARCHAR(20) NOT NULL DEFAULT 'PAGADA'
                                  CHECK (estado IN ('PAGADA','ANULADA')),
                fecha_venta       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_creacion    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS ix_gym_venta_neg_fecha ON gym.gym_venta (id_negocio, fecha_venta DESC);
            CREATE INDEX IF NOT EXISTS ix_gym_venta_miembro   ON gym.gym_venta (id_miembro);

            CREATE TABLE IF NOT EXISTS gym.gym_venta_detalle (
                id_detalle      SERIAL PRIMARY KEY,
                id_venta        INTEGER NOT NULL REFERENCES gym.gym_venta(id_venta) ON DELETE CASCADE,
                id_producto     INTEGER NOT NULL REFERENCES gym.gym_producto(id_producto),
                cantidad        NUMERIC(12,2) NOT NULL CHECK (cantidad > 0),
                precio_unitario NUMERIC(12,2) NOT NULL CHECK (precio_unitario >= 0),
                subtotal        NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0)
            );
            CREATE INDEX IF NOT EXISTS ix_gym_venta_detalle_venta ON gym.gym_venta_detalle (id_venta);
        `, { transaction: t });

        // 3. Renombrar /asistencias → /ingreso (descripción + url)
        console.log('3. Renombrando módulo /asistencias → /ingreso...');
        await sequelize.query(`
            UPDATE general.gener_nivel
               SET descripcion = 'INGRESO',
                   url         = '/ingreso',
                   icono       = 'log-in'
             WHERE id_tipo_negocio = :tipo
               AND id_tipo_nivel = 1
               AND url IN ('/asistencias','/ingreso');
        `, { replacements: { tipo: idTipoGym }, transaction: t });

        // 4. Nuevos módulos: /productos, /ventas, /configuracion
        console.log('4. Insertando módulos /productos, /ventas, /configuracion...');
        const [[nivelRoot]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/gimnasio';
        `, { replacements: { tipo: idTipoGym }, transaction: t });
        const idNivelRoot = nivelRoot.id_nivel;

        const nuevos = [
            ['PRODUCTOS',     '/productos',     'package'],
            ['VENTAS',        '/ventas',        'shopping-cart'],
            ['CONFIGURACION', '/configuracion', 'settings'],
        ];
        for (const [desc, url, icono] of nuevos) {
            await sequelize.query(`
                INSERT INTO general.gener_nivel
                    (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
                SELECT :desc, :padre, :icono, 'A', 1, :url, :tipo
                WHERE NOT EXISTS (
                    SELECT 1 FROM general.gener_nivel
                    WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = :url
                );
            `, { replacements: { desc, padre: idNivelRoot, icono, url, tipo: idTipoGym }, transaction: t });
        }

        // 5. Permisos por rol (matriz global)
        console.log('5. Asignando permisos a roles del gym...');
        const rolesGym = await sequelize.query(`
            SELECT id_rol, descripcion FROM general.gener_rol
            WHERE id_tipo_negocio = :tipo AND estado = 'A';
        `, { replacements: { tipo: idTipoGym }, transaction: t, type: sequelize.QueryTypes.SELECT });

        const rolAdmin   = rolesGym.find(r => r.descripcion === 'ADMINISTRADOR').id_rol;
        const rolRecep   = rolesGym.find(r => r.descripcion === 'RECEPCION').id_rol;
        const rolCajero  = rolesGym.find(r => r.descripcion === 'CAJERO').id_rol;
        const rolEntr    = rolesGym.find(r => r.descripcion === 'ENTRENADOR').id_rol;

        // ADMIN: full
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel, true, true, true, true, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo AND n.id_tipo_nivel = 1
              AND n.url IN ('/productos','/ventas','/configuracion','/ingreso')
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolAdmin, tipo: idTipoGym }, transaction: t });

        // CAJERO: ventas + productos (lectura) + ingreso
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel,
                   true,
                   CASE WHEN n.url IN ('/ventas','/ingreso') THEN true ELSE false END,
                   CASE WHEN n.url IN ('/ventas') THEN true ELSE false END,
                   false, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo AND n.id_tipo_nivel = 1
              AND n.url IN ('/productos','/ventas','/ingreso')
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolCajero, tipo: idTipoGym }, transaction: t });

        // RECEPCION: ingreso (CRUD) + productos (lectura)
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel, true,
                   CASE WHEN n.url = '/ingreso' THEN true ELSE false END,
                   false, false, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo AND n.id_tipo_nivel = 1
              AND n.url IN ('/productos','/ingreso')
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolRecep, tipo: idTipoGym }, transaction: t });

        // ENTRENADOR: ingreso (registro)
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel, true, true, false, false, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo AND n.id_tipo_nivel = 1
              AND n.url = '/ingreso'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolEntr, tipo: idTipoGym }, transaction: t });

        // 6. Backfill por-negocio
        console.log('6. Backfill gener_nivel_negocio para negocios GIMNASIO...');
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
                                         AND niv.url IN ('/productos','/ventas','/configuracion','/ingreso')
            WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
        `, { replacements: { tipo: idTipoGym }, transaction: t });

        await t.commit();
        console.log('\n✓ Migración Gimnasio v2 completada');
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
