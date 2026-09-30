/**
 * Paso de slots de 30 minutos por defecto para los negocios de reserva NUEVOS (2026-09-29).
 *
 * Solo cambia el DEFAULT de la columna, para las filas que se crean por SQL crudo (fixtures,
 * scripts). La aplicación ya crea la configuración con 30 (modelo `reserva.reserva_config` y
 * `config_inicial` de los perfiles). Los negocios que ya tienen configuración NO se tocan: su
 * paso lo eligió alguien, o lo usan con clientes reales.
 *
 * Idempotente.
 *
 *   npm run migrate:reserva-paso-slot-30
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: paso de slots de 30 min por defecto (reserva) ===\n');

        const [[columna]] = await sequelize.query(`
            SELECT column_default
              FROM information_schema.columns
             WHERE table_schema = 'reserva' AND table_name = 'reserva_config' AND column_name = 'paso_slot_min';
        `, { transaction: t });
        if (!columna) throw new Error('No existe reserva.reserva_config.paso_slot_min. Ejecuta antes `npm run migrate:reserva`.');

        if (String(columna.column_default).trim() === '30') {
            console.log('Ya aplicada: el default es 30.');
        } else {
            await sequelize.query(
                'ALTER TABLE reserva.reserva_config ALTER COLUMN paso_slot_min SET DEFAULT 30;',
                { transaction: t },
            );
            console.log(`Default cambiado: ${columna.column_default} → 30.`);
        }

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
