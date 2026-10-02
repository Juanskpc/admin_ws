/**
 * Migración: lo que el negocio le quiere contar a su asistente, en texto libre.
 *
 *  - general.gener_negocio.info_asistente   varchar(1500) NULL
 *
 * Es lo que el asistente no puede sacar de ninguna otra tabla: el número de Nequi para
 * transferir, «el domicilio vale $8.000 en el casco urbano», «no recibimos datáfono»… Lo escribe
 * el administrador en la configuración de la Bandeja y el asistente lo lee con la capacidad
 * `consultar_info_negocio`, junto con lo que sí está en tablas (horario, métodos de pago,
 * barrios, tiempo estimado).
 *
 * Producción, 2026-10-01 (Zona Burger): los clientes preguntaron el número de Nequi, si se podía
 * pagar en efectivo y cuánto valía el domicilio, y el bot contestó cada vez «no tengo esa
 * información»; el personal tuvo que entrar a mano en todas.
 *
 * Va en `gener_negocio` y no en una tabla de intelligence por lo mismo que
 * `reactivar_asistente_min` y `tiempo_estimado_min`: es una decisión del negocio.
 * Texto acotado a 1500 caracteres: es una ficha, no un documento (eso sería Knowledge, ADR-020).
 *
 * Idempotente. Registrada como `npm run migrate:negocio-info-asistente`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. general.gener_negocio.info_asistente ...');
        const [existe] = await Models.sequelize.query(
            `SELECT 1 AS hay FROM information_schema.columns
              WHERE table_schema = 'general' AND table_name = 'gener_negocio'
                AND column_name = 'info_asistente';`,
            { type: Models.sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!existe) {
            await Models.sequelize.query(
                `ALTER TABLE general.gener_negocio ADD COLUMN info_asistente varchar(1500);`,
                { transaction: t }
            );
            console.log('   añadida (NULL = sin información adicional).');
        } else {
            console.log('   ya existía.');
        }
        await t.commit();
        console.log('✓ Migración info_asistente completada.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló la migración (revertida):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
}

migrate();
