/**
 * Migración: el tiempo de un pedido PARA RECOGER, aparte del de domicilio.
 *
 *  - general.gener_negocio.tiempo_recoger_min   integer NULL
 *  - general.gener_negocio.tiempo_recoger_max   integer NULL
 *
 * `tiempo_estimado_min/max` es lo que tarda un domicilio —cocina más camino—. El asistente se lo
 * decía también a quien pasa por el local: «40 a 60 minutos» a pedidos que estuvieron listos en
 * 9 y 23 minutos (Zona Burger, 2026-10-07), y el cajero tenía que entrar al chat a aclarar «no es
 * tanto, es la IA». Con el tiempo de recoger aparte, el resumen que espera el «sí» ya puede decir
 * de una vez cuánto falta, que es además lo que ahorra el mensaje de «¿cuánto se demora?».
 *
 * NULL = el negocio no lo ha dicho: para recoger se sigue diciendo el tiempo estimado de
 * siempre. Así la migración no le cambia nada a nadie.
 *
 * Idempotente. Registrada como `npm run migrate:negocio-tiempo-recoger`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        for (const columna of ['tiempo_recoger_min', 'tiempo_recoger_max']) {
            console.log(`· general.gener_negocio.${columna} ...`);
            const [existe] = await Models.sequelize.query(
                `SELECT 1 AS hay FROM information_schema.columns
                  WHERE table_schema = 'general' AND table_name = 'gener_negocio'
                    AND column_name = :columna;`,
                { replacements: { columna }, type: Models.sequelize.QueryTypes.SELECT, transaction: t }
            );
            if (!existe) {
                await Models.sequelize.query(
                    `ALTER TABLE general.gener_negocio ADD COLUMN ${columna} integer;`,
                    { transaction: t }
                );
                console.log('   añadida (NULL = el tiempo estimado de siempre).');
            } else {
                console.log('   ya existía.');
            }
        }
        await t.commit();
        console.log('✓ Migración tiempo_recoger completada.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló la migración (revertida):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
}

migrate();
