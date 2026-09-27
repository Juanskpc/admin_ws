/**
 * `reserva.reserva_servicio.precio_min` / `precio_max` — el rango de referencia de un servicio
 * «a cotizar» (tatuajes, estética a medida).
 *
 * Hasta ahora un servicio con `a_cotizar = true` no mostraba ningún precio en el portal: solo
 * «Cotizar por WhatsApp». Es correcto cuando de verdad no hay forma de dar una cifra, pero la
 * mayoría de los casos sí tienen un rango conocido de antemano («un tatuaje pequeño cuesta entre
 * $80.000 y $150.000») y no enseñarlo hace que el cliente escriba a ciegas. El precio exacto
 * sigue sin fijarse aquí — se acuerda al atender y se guarda en `reserva_cita_servicio.
 * precio_snapshot`, que `cobroService.completarYCobrar` ahora exige que no sea cero.
 *
 * Ambas columnas quedan NULL en los servicios existentes: sin rango, el portal sigue mostrando
 * «A cotizar» exactamente como antes. Idempotente.
 *
 *   npm run migrate:reserva-servicio-rango-precio
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

async function columnaExiste(esquema, tabla, columna, t) {
    const [filas] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;
    `, { replacements: { esquema, tabla, columna }, transaction: t });
    return filas.length > 0;
}

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: reserva_servicio.precio_min / precio_max ===\n');

        for (const columna of ['precio_min', 'precio_max']) {
            if (!await columnaExiste('reserva', 'reserva_servicio', columna, t)) {
                await sequelize.query(`
                    ALTER TABLE reserva.reserva_servicio ADD COLUMN ${columna} DECIMAL(14, 2);
                `, { transaction: t });
                console.log(`   + ${columna}`);
            } else {
                console.log(`   = ${columna} ya existía`);
            }
        }

        await t.commit();
        console.log('\nMigración completada.\n');
    } catch (err) {
        await t.rollback();
        console.error('\nERROR — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
