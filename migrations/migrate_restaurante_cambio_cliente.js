/**
 * Migración: el negocio se entera cuando el cliente CAMBIA un pedido por WhatsApp.
 *
 *  - restaurante.pedid_orden.cambio_cliente_en  (TIMESTAMP NULL)
 *      Cuándo el cliente modificó la orden por el asistente (hoy: agregarle productos) por
 *      última vez. NULL = nunca.
 *
 * ## Por qué hace falta
 *
 * Despacho ya pide confirmar los pedidos que toma el asistente (`confirmado_en`). Pero una vez
 * confirmado, si el cliente escribe «¿puedes aumentar otras alitas?», el asistente las agrega y
 * el pedido cambia de total sin que nadie del negocio lo note: la tarjeta ya estaba confirmada.
 * Zona Burger, 2026-10-07 (ORD-7888): pasó de $31.500 a $47.000 quince minutos después.
 *
 * ## Por qué otra columna y no borrar `confirmado_en`
 *
 * Borrarla haría volver el botón, pero diría «pedido nuevo sin confirmar» de uno que el cajero
 * ya vio, y se perdería cuándo lo confirmó la primera vez. Con el instante del cambio aparte, la
 * regla se deduce (`pedidoService.estadoDeConfirmacion`): hay un cambio por confirmar si
 * `cambio_cliente_en` es posterior a `confirmado_en`, y confirmar de nuevo pone `confirmado_en`
 * al día. Vale también para una orden que tomó una persona y a la que el cliente le agregó algo
 * por WhatsApp.
 *
 * Sin backfill: lo que ya cambió antes de hoy no vuelve a pedir confirmación.
 *
 * Timestamp sin huso, hora de pared de Bogotá, como `confirmado_en`.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-cambio-cliente
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. restaurante.pedid_orden.cambio_cliente_en ...');
        const [existe] = await Models.sequelize.query(
            `SELECT 1 AS hay FROM information_schema.columns
              WHERE table_schema = 'restaurante' AND table_name = 'pedid_orden'
                AND column_name = 'cambio_cliente_en';`,
            { type: Models.sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!existe) {
            await Models.sequelize.query(
                `ALTER TABLE restaurante.pedid_orden ADD COLUMN cambio_cliente_en TIMESTAMP NULL;`,
                { transaction: t }
            );
            console.log('   añadida (NULL = el cliente no ha cambiado nada).');
        } else {
            console.log('   ya existía.');
        }
        await t.commit();
        console.log('✓ Migración cambio_cliente_en completada.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló la migración (revertida):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
}

migrate();
