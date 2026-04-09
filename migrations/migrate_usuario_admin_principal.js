/**
 * Agrega bandera de administrador principal y garantiza existencia de uno activo.
 *
 * Ejecutar con:
 *   node migrations/migrate_usuario_admin_principal.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();

    try {
        console.log('Iniciando migracion de administrador principal...');

        await sequelize.query(
            `
            ALTER TABLE general.gener_usuario
            ADD COLUMN IF NOT EXISTS es_admin_principal BOOLEAN NOT NULL DEFAULT FALSE;
            `,
            { transaction: t }
        );

        await sequelize.query(
            `
            WITH candidato AS (
                SELECT u.id_usuario
                FROM general.gener_usuario u
                JOIN general.gener_usuario_rol ur
                  ON ur.id_usuario = u.id_usuario
                 AND ur.estado = 'A'
                JOIN general.gener_rol r
                  ON r.id_rol = ur.id_rol
                 AND r.estado = 'A'
                WHERE u.estado = 'A'
                  AND UPPER(r.descripcion) LIKE '%ADMINISTRADOR%'
                ORDER BY u.fecha_creacion ASC
                LIMIT 1
            )
            UPDATE general.gener_usuario u
            SET es_admin_principal = TRUE
            FROM candidato
            WHERE u.id_usuario = candidato.id_usuario
              AND NOT EXISTS (
                SELECT 1
                FROM general.gener_usuario
                WHERE es_admin_principal = TRUE
              );
            `,
            { transaction: t }
        );

        await t.commit();
        console.log('Migracion completada correctamente.');
    } catch (error) {
        await t.rollback();
        console.error('Error en migracion:', error.message);
        console.error(error);
    } finally {
        await sequelize.close();
        process.exit(0);
    }
}

migrate();
