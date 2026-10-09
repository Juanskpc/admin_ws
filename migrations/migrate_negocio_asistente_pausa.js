/**
 * Migración: pausa de emergencia del asistente, por negocio.
 *
 *  - general.gener_negocio.asistente_pausado      boolean NOT NULL DEFAULT false
 *  - general.gener_negocio.asistente_pausado_en   timestamp NULL   (hora Bogotá, como el resto)
 *
 * Zona Burger (2026-10-04, ~20:45): se quedaron sin papas en plena noche y pidieron que el bot
 * dejara de contestar YA. No había forma: se apagó desactivando su número en
 * `platform.numero_canal`, lo que además sacaba los mensajes de la Bandeja. Con esto el negocio lo
 * pausa desde la Bandeja: los mensajes siguen entrando y quedan en «Esperan respuesta», pero el
 * asistente no contesta ni ejecuta nada hasta que lo reanuden.
 *
 * Idempotente. Registrada como `npm run migrate:negocio-asistente-pausa`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function existe(t, columna) {
    const [fila] = await Models.sequelize.query(
        `SELECT 1 AS hay FROM information_schema.columns
          WHERE table_schema = 'general' AND table_name = 'gener_negocio' AND column_name = :columna;`,
        { replacements: { columna }, type: Models.sequelize.QueryTypes.SELECT, transaction: t }
    );
    return Boolean(fila);
}

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. general.gener_negocio.asistente_pausado ...');
        if (await existe(t, 'asistente_pausado')) {
            console.log('   ya existía.');
        } else {
            await Models.sequelize.query(
                `ALTER TABLE general.gener_negocio
                   ADD COLUMN asistente_pausado boolean NOT NULL DEFAULT false;`,
                { transaction: t }
            );
            console.log('   añadida (false = el asistente contesta).');
        }

        console.log('2. general.gener_negocio.asistente_pausado_en ...');
        if (await existe(t, 'asistente_pausado_en')) {
            console.log('   ya existía.');
        } else {
            await Models.sequelize.query(
                `ALTER TABLE general.gener_negocio ADD COLUMN asistente_pausado_en timestamp;`,
                { transaction: t }
            );
            console.log('   añadida.');
        }

        await t.commit();
        console.log('✓ Migración pausa del asistente completada.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló la migración (revertida):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
}

migrate();
