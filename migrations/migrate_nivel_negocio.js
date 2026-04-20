/**
 * Crea y parametriza general.gener_nivel_negocio.
 *
 * Uso:
 *   node migrations/migrate_nivel_negocio.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('=== Migracion gener_nivel_negocio ===');

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS general.gener_nivel_negocio (
                id_nivel_negocio SERIAL PRIMARY KEY,
                id_negocio INTEGER NOT NULL,
                id_rol INTEGER NOT NULL,
                id_nivel INTEGER NOT NULL,
                puede_ver BOOLEAN NOT NULL DEFAULT FALSE,
                estado CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_nneg_negocio FOREIGN KEY (id_negocio)
                    REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                CONSTRAINT fk_nneg_rol FOREIGN KEY (id_rol)
                    REFERENCES general.gener_rol(id_rol) ON DELETE CASCADE,
                CONSTRAINT fk_nneg_nivel FOREIGN KEY (id_nivel)
                    REFERENCES general.gener_nivel(id_nivel) ON DELETE CASCADE,
                CONSTRAINT uq_nivel_negocio UNIQUE (id_negocio, id_rol, id_nivel)
            );
        `, { transaction: t });

        // Backfill inicial por negocio/rol/modulo para que la UI cargue chequeos desde esta tabla.
        await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio (
                id_negocio,
                id_rol,
                id_nivel,
                puede_ver,
                estado,
                fecha_creacion,
                fecha_actualizacion
            )
            SELECT
                n.id_negocio,
                r.id_rol,
                nv.id_nivel,
                COALESCE(rn.puede_ver, FALSE) AS puede_ver,
                'A',
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            FROM general.gener_negocio n
            JOIN general.gener_rol r
              ON r.estado = 'A'
             AND r.id_tipo_negocio = n.id_tipo_negocio
            JOIN general.gener_nivel nv
              ON nv.estado = 'A'
             AND nv.id_tipo_nivel = 1
             AND nv.id_tipo_negocio = n.id_tipo_negocio
            LEFT JOIN general.gener_rol_nivel rn
              ON rn.id_rol = r.id_rol
             AND rn.id_nivel = nv.id_nivel
             AND rn.estado = 'A'
            WHERE n.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
        `, { transaction: t });

        await t.commit();
        console.log('OK: tabla y parametrizacion gener_nivel_negocio listas.');
    } catch (error) {
        await t.rollback();
        console.error('Error en migrate_nivel_negocio:', error);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
        process.exit();
    }
}

migrate();