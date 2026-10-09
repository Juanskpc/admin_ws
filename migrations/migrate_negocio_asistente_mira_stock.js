/**
 * Migración: que el asistente tenga en cuenta el inventario es una decisión APARTE de controlarlo
 * en caja.
 *
 *  - general.gener_negocio.asistente_mira_stock   BOOLEAN NOT NULL DEFAULT TRUE
 *
 * Hasta hoy había un solo interruptor, `controla_inventario`, y hacía dos cosas a la vez: en caja
 * bloquea y descuenta, y hacia fuera esconde del asistente de WhatsApp lo que no tiene insumos.
 * Zona Burger lo apagó (2026-10) porque no quería que caja se bloqueara, y con eso el asistente
 * dejó de saber qué estaba agotado. Son dos decisiones, y valen las cuatro combinaciones: el
 * negocio puede controlar inventario en caja y decirle al asistente que no lo mire, o al revés.
 *
 * Solo habla de EXISTENCIAS. Lo que el negocio desactiva a mano en Productos (`disponible`) el
 * asistente no lo ofrece nunca, diga esto lo que diga. Y la carta digital no cambia: sigue al
 * control de caja.
 *
 * Al crearse, cada negocio queda como estaba: `asistente_mira_stock = controla_inventario`. Así
 * la migración no le cambia el comportamiento a nadie. Los negocios nuevos nacen con las dos
 * encendidas. Esa copia se hace UNA vez, al añadir la columna: volver a correr la migración no
 * pisa lo que el negocio haya decidido después.
 *
 * ⚠️ Con el control de caja apagado las existencias NO bajan solas con las ventas: el asistente
 * se guía por lo que esté escrito en Inventario. La pantalla lo avisa donde se enciende.
 *
 * Idempotente. Registrada como `npm run migrate:negocio-asistente-stock`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. general.gener_negocio.asistente_mira_stock ...');
        const [existe] = await Models.sequelize.query(
            `SELECT 1 AS hay FROM information_schema.columns
              WHERE table_schema = 'general' AND table_name = 'gener_negocio'
                AND column_name = 'asistente_mira_stock';`,
            { type: Models.sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!existe) {
            await Models.sequelize.query(
                `ALTER TABLE general.gener_negocio
                   ADD COLUMN asistente_mira_stock boolean NOT NULL DEFAULT true;`,
                { transaction: t }
            );
            const [, copiados] = await Models.sequelize.query(
                `UPDATE general.gener_negocio
                    SET asistente_mira_stock = false
                  WHERE controla_inventario = false;`,
                { transaction: t }
            );
            console.log(
                `   añadida. Cada negocio queda como estaba: ${copiados?.rowCount ?? 0} sin control ` +
                    'de inventario → el asistente tampoco lo mira.'
            );
        } else {
            console.log('   ya existía.');
        }
        await t.commit();
        console.log('✓ Migración asistente_mira_stock completada.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló la migración (revertida):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
}

migrate();
