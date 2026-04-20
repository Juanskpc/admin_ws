/**
 * Migracion — fecha_inicio_servicio para restaurante.rest_mesa
 *
 * Objetivo:
 * - Persistir el tiempo de servicio de la mesa entre cobros.
 * - Reiniciar el tiempo solo cuando la mesa se libera.
 *
 * Ejecutar: node migrations/migrate_mesa_inicio_servicio.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
  const t = await sequelize.transaction();
  try {
    console.log('Iniciando migracion de fecha_inicio_servicio en rest_mesa...');

    await sequelize.query(`
      ALTER TABLE restaurante.rest_mesa
      ADD COLUMN IF NOT EXISTS fecha_inicio_servicio TIMESTAMP NULL;
    `, { transaction: t });

    // Si una mesa esta disponible, no debe conservar reloj activo.
    await sequelize.query(`
      UPDATE restaurante.rest_mesa
      SET fecha_inicio_servicio = NULL
      WHERE estado_servicio = 'DISPONIBLE';
    `, { transaction: t });

    // Backfill para mesas activas en servicio sin fecha de inicio:
    // usa la orden abierta mas antigua; si no existe, toma CURRENT_TIMESTAMP.
    await sequelize.query(`
      UPDATE restaurante.rest_mesa m
      SET fecha_inicio_servicio = COALESCE(
        (
          SELECT MIN(o.fecha_creacion)
          FROM restaurante.pedid_orden o
          WHERE o.id_mesa = m.id_mesa
            AND o.estado = 'ABIERTA'
        ),
        CURRENT_TIMESTAMP
      )
      WHERE m.estado = 'A'
        AND m.estado_servicio IN ('OCUPADA', 'POR_COBRAR')
        AND m.fecha_inicio_servicio IS NULL;
    `, { transaction: t });

    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_rest_mesa_inicio_servicio
      ON restaurante.rest_mesa(id_negocio, estado_servicio, fecha_inicio_servicio);
    `, { transaction: t });

    await t.commit();
    console.log('Migracion completada correctamente.');
  } catch (err) {
    await t.rollback();
    console.error('Error en migracion:', err.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

migrate();
