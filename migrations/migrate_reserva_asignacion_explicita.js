/**
 * Asignación **explícita** de servicios a profesionales (vertical `reserva`).
 *
 * Hasta ahora un profesional sin ninguna fila en `reserva_profesional_servicio` ofrecía el
 * catálogo entero: el portal lo listaba en todos los servicios y `citaService` le dejaba agendar
 * cualquiera. Eso hacía que un profesional recién creado apareciera haciendo servicios que nadie
 * le había dado. La regla nueva es la literal: **sin asignaciones, no ofrece nada**.
 *
 * Esta migración conserva lo que ya funcionaba en producción: a cada profesional que hoy no
 * tiene ninguna asignación le escribe, una a una, los servicios **activos** de su negocio — que
 * es exactamente lo que ofrecía hasta ahora. Sin esto desaparecerían del portal y de la agenda
 * el día del despliegue.
 *
 * ## Se aplica una sola vez
 *
 * Después del despliegue, «sin asignaciones» pasa a ser una elección legítima del dueño. Volver
 * a rellenar esos profesionales en una segunda ejecución desharía esa elección, así que la
 * migración deja una marca en el comentario de la tabla y, si la encuentra, no hace nada.
 *
 * Debe correr ANTES de desplegar el backend con la regla nueva.
 *
 *   npm run migrate:reserva-asignacion-explicita
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

const MARCA = 'asignacion_explicita_v1';

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: asignación explícita de servicios a profesionales ===\n');

        const [[tabla]] = await sequelize.query(`
            SELECT obj_description('reserva.reserva_profesional_servicio'::regclass, 'pg_class') AS comentario;
        `, { transaction: t });
        if (String(tabla?.comentario ?? '').includes(MARCA)) {
            console.log('Ya aplicada (marca encontrada). No se toca nada.');
            await t.rollback();
            return;
        }

        const [filas] = await sequelize.query(`
            INSERT INTO reserva.reserva_profesional_servicio (id_profesional, id_servicio)
            SELECT p.id_profesional, s.id_servicio
            FROM reserva.reserva_profesional p
            JOIN reserva.reserva_servicio s
              ON s.id_negocio = p.id_negocio AND s.estado = 'A'
            WHERE NOT EXISTS (
                SELECT 1 FROM reserva.reserva_profesional_servicio ps
                WHERE ps.id_profesional = p.id_profesional
            )
            ON CONFLICT DO NOTHING
            RETURNING id_profesional;
        `, { transaction: t });
        const profesionales = new Set(filas.map(f => f.id_profesional));
        console.log(`1. ${filas.length} asignaciones creadas para ${profesionales.size} profesional(es).`);

        await sequelize.query(`
            COMMENT ON TABLE reserva.reserva_profesional_servicio IS
            'Servicios que ofrece cada profesional. Sin filas no ofrece ninguno. [${MARCA}]';
        `, { transaction: t });
        console.log('2. Marca registrada.');

        await t.commit();
        console.log('\nListo.\n');
    } catch (err) {
        await t.rollback();
        console.error('\nError, se revirtió todo:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
