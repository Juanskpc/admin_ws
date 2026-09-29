/**
 * El *hold* recuerda qué variante se apartó.
 *
 *   npm run migrate:reserva-hold-variantes
 *
 * ## El desajuste que esto cierra
 *
 * `citaService.crearCita` acepta `variantes` desde los perfiles de rubro (2026-09-17), pero
 * `holdService.tomar` **no**: compone la duración con el precio y el tiempo de lista. Mientras el
 * único consumidor del hold fue el asistente —que tampoco sabía de variantes— nadie lo notó.
 *
 * En cuanto el asistente pregunta la variante (salón: largo del cabello; mascotas: tamaño), el
 * desajuste se vuelve real y silencioso: el hold apartaría **40 minutos** para una cita que va a
 * ocupar **90**. La confirmación no falla —la cita se crea igual— pero el hueco que se estaba
 * protegiendo era más corto que la cita, así que otra persona puede colarse en la segunda mitad
 * y el choque aparece en la agenda del profesional, no aquí.
 *
 * ## Por qué solo `variantes` y no también la mascota
 *
 * El hold aparta **tiempo**. Lo único que cambia cuánto tiempo hay que apartar es la variante
 * (una coloración de pelo largo dura el doble; un baño de perro gigante, más que el de uno
 * pequeño). La mascota, el nombre y las notas son datos de la cita, no del hueco: viajan como
 * argumentos al confirmar, igual que el nombre del cliente ya hace hoy.
 *
 * ## Forma del dato
 *
 * `{"<id_servicio>": <id_variante>}` — el mismo formato que `composicionCita.normalizarVariantes`
 * ya acepta del portal, para que al confirmar se pase tal cual sin traducir nada. `NULL` es «sin
 * variantes», que es el caso de la barbería y de todo hold anterior a esta migración.
 *
 * Aditivo y con guarda: la columna nace nullable, así que los holds vivos siguen valiendo y
 * volver a correrla no hace nada.
 */
'use strict';
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: variantes en el hold (reserva) ===\n');

        const [tabla] = await sequelize.query(
            `SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'reserva' AND table_name = 'reserva_hold'`,
            { transaction: t },
        );
        if (tabla.length === 0) {
            throw new Error('No existe reserva.reserva_hold. Corre antes: npm run migrate:reserva-hold');
        }

        console.log('1. reserva_hold.variantes...');
        await sequelize.query(
            `ALTER TABLE reserva.reserva_hold ADD COLUMN IF NOT EXISTS variantes JSONB NULL`,
            { transaction: t },
        );
        await sequelize.query(
            `COMMENT ON COLUMN reserva.reserva_hold.variantes IS
             'Variante elegida por servicio: {"id_servicio": id_variante}. NULL = precio y duración de lista.'`,
            { transaction: t },
        );
        console.log('   OK');

        await t.commit();
        console.log('\n✓ Migración completada.\n');
    } catch (err) {
        await t.rollback();
        console.error('\n✗ Error — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
