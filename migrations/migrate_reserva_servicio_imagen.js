/**
 * `reserva.reserva_servicio_imagen` — varias fotos por servicio.
 *
 * Hasta ahora un servicio tenía **una** foto (`reserva_servicio.imagen_url`), que es la que
 * sigue saliendo en la tarjeta del catálogo público — cambiar eso ahí sería alargar cada tarjeta
 * sin necesidad, y esa columna la siguen usando `servicioService`, `vitrinaService` y el
 * catálogo de ejemplos, así que se conserva tal cual. Lo que faltaba era el **detalle**: al abrir
 * un servicio («Tatuaje de línea fina») el cliente quiere ver varios trabajos, no solo la
 * portada, y eso es exactamente lo que ya resuelve el portafolio de un profesional
 * (`reserva_profesional_imagen`, `migrate_reserva_perfiles.js` paso 8). Esta tabla es la misma
 * idea aplicada al servicio en vez de a la persona.
 *
 * Idempotente.
 *
 *   npm run migrate:reserva-servicio-imagen
 */
'use strict';
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: fotos por servicio (reserva) ===\n');

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_servicio_imagen (
                id_imagen           SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_servicio         INTEGER NOT NULL REFERENCES reserva.reserva_servicio(id_servicio) ON DELETE CASCADE,
                url                 VARCHAR(500) NOT NULL,
                descripcion         VARCHAR(200),
                orden               SMALLINT NOT NULL DEFAULT 0,
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_servicio_imagen
                ON reserva.reserva_servicio_imagen (id_servicio, orden);
        `, { transaction: t });
        console.log('   OK\n');

        await t.commit();
        console.log('Migración completada.\n');
    } catch (err) {
        await t.rollback();
        console.error('\nERROR — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
