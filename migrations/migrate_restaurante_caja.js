/**
 * Migración: módulo de Caja para restaurante.
 * Idempotente: usa CREATE TABLE IF NOT EXISTS, ALTER ... ADD COLUMN IF NOT EXISTS,
 * INSERT ... ON CONFLICT DO NOTHING.
 *
 * Ejecutar con: npm run migrate:restaurante-caja
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante Caja\n');

        // 1. rest_caja
        console.log('1. Creando restaurante.rest_caja...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_caja (
                id_caja          SERIAL PRIMARY KEY,
                id_negocio       INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_usuario       INTEGER NOT NULL REFERENCES general.gener_usuario(id_usuario),
                monto_apertura   NUMERIC(12,2) NOT NULL DEFAULT 0,
                monto_cierre     NUMERIC(12,2),
                monto_reportado  NUMERIC(12,2),
                diferencia       NUMERIC(12,2),
                fecha_apertura   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_cierre     TIMESTAMP,
                estado           CHAR(1) NOT NULL DEFAULT 'A',
                observaciones    TEXT
            );
        `, { transaction: t });

        // Garantiza una sola caja abierta por negocio (índice único parcial).
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_rest_caja_abierta_por_negocio
            ON restaurante.rest_caja (id_negocio)
            WHERE estado = 'A';
        `, { transaction: t });
        console.log('   OK\n');

        // 2. rest_movimiento_caja
        console.log('2. Creando restaurante.rest_movimiento_caja...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_movimiento_caja (
                id_movimiento  SERIAL PRIMARY KEY,
                id_caja        INTEGER NOT NULL REFERENCES restaurante.rest_caja(id_caja) ON DELETE CASCADE,
                tipo           VARCHAR(10) NOT NULL CHECK (tipo IN ('INGRESO','EGRESO')),
                monto          NUMERIC(12,2) NOT NULL,
                concepto       VARCHAR(255),
                id_orden       INTEGER REFERENCES restaurante.pedid_orden(id_orden) ON DELETE SET NULL,
                id_usuario     INTEGER NOT NULL REFERENCES general.gener_usuario(id_usuario),
                fecha          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_rest_movimiento_caja_id_caja
            ON restaurante.rest_movimiento_caja (id_caja);
        `, { transaction: t });
        console.log('   OK\n');

        // 3. pedid_orden.id_caja (auditoría: en qué turno se cobró cada orden)
        console.log('3. Agregando columna pedid_orden.id_caja...');
        const [colCaja] = await sequelize.query(`
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='restaurante' AND table_name='pedid_orden' AND column_name='id_caja';
        `, { transaction: t });
        if (colCaja.length === 0) {
            await sequelize.query(`
                ALTER TABLE restaurante.pedid_orden
                ADD COLUMN id_caja INTEGER REFERENCES restaurante.rest_caja(id_caja) ON DELETE SET NULL;
            `, { transaction: t });
            console.log('   columna agregada\n');
        } else {
            console.log('   ya existía, omito\n');
        }

        // 4. Niveles (módulo CAJA + 3 subniveles)
        console.log('4. Insertando niveles de navegación...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
            SELECT 'CAJA', 786, 'wallet', 'A', 1, '/caja', 1
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = 1 AND id_tipo_nivel = 1 AND url = '/caja'
            );
        `, { transaction: t });

        const [[nivelCaja]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = 1 AND id_tipo_nivel = 1 AND url = '/caja';
        `, { transaction: t });
        const idNivelCaja = nivelCaja.id_nivel;
        console.log(`   módulo CAJA = id_nivel ${idNivelCaja}`);

        const subniveles = [
            ['CAJA - ABRIR',           'caja_abrir'],
            ['CAJA - CERRAR',          'caja_cerrar'],
            ['CAJA - REGISTRAR MOVIMIENTO', 'caja_movimiento'],
        ];
        for (const [desc, codigo] of subniveles) {
            await sequelize.query(`
                INSERT INTO general.gener_nivel
                    (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
                SELECT :desc, :padre, NULL, 'A', 4, :codigo, 1
                WHERE NOT EXISTS (
                    SELECT 1 FROM general.gener_nivel
                    WHERE id_tipo_negocio = 1 AND id_tipo_nivel = 4 AND url = :codigo
                );
            `, { replacements: { desc, codigo, padre: idNivelCaja }, transaction: t });
        }
        console.log('   subniveles insertados\n');

        // 5. Permisos por rol (matriz global gener_rol_nivel)
        // ADMINISTRADOR (id_rol=2): todo. CAJERO (id_rol=3): todo.
        console.log('5. Asignando permisos a roles ADMINISTRADOR y CAJERO...');
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT r.id_rol, n.id_nivel, true, true, true, false, 'A'
            FROM (VALUES (2), (3)) AS r(id_rol)
            CROSS JOIN general.gener_nivel n
            WHERE n.id_tipo_negocio = 1
              AND (
                (n.id_tipo_nivel = 1 AND n.url = '/caja') OR
                (n.id_tipo_nivel = 4 AND n.url IN ('caja_abrir','caja_cerrar','caja_movimiento'))
              )
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { transaction: t });
        console.log('   OK\n');

        // 6. Backfill por-negocio (gener_nivel_negocio).
        // El sistema prioriza estos overrides sobre la matriz global; sin filas
        // aquí, los negocios existentes no verán Caja aunque el rol lo permita.
        console.log('6. Backfill de permisos en gener_nivel_negocio para restaurantes activos...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT neg.id_negocio, r.id_rol, niv.id_nivel, true, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio neg
            CROSS JOIN (VALUES (2), (3)) AS r(id_rol)
            CROSS JOIN general.gener_nivel niv
            WHERE neg.id_tipo_negocio = 1
              AND neg.estado = 'A'
              AND niv.id_tipo_negocio = 1
              AND (
                (niv.id_tipo_nivel = 1 AND niv.url = '/caja') OR
                (niv.id_tipo_nivel = 4 AND niv.url IN ('caja_abrir','caja_cerrar','caja_movimiento'))
              )
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
        `, { transaction: t });
        console.log('   OK\n');

        await t.commit();
        console.log('✓ Migración Restaurante Caja completada');
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
