/**
 * Migración: pedidos «para servir» que llegan por WhatsApp.
 *
 *  - restaurante.pedid_orden.para_servir   boolean NOT NULL DEFAULT false
 *
 * ## Por qué (2026-10-02, Zona Burger)
 *
 * «Dos salchilimón para servir, veci, ya vamos»: en Pasto «para servir» es comer en el local. El
 * cliente todavía no está sentado, así que no hay número de mesa que decir, y el asistente se
 * atascó preguntando «¿en qué mesa están?» hasta convertirlo en «para recoger». Oscar lo arregló a
 * mano poniéndolo en una mesa cualquiera.
 *
 * Ahora lo hace el asistente: le asigna una mesa libre. Pero un pedido en una mesa donde todavía
 * no hay nadie sentado se tiene que distinguir de los demás —el mesero no puede ir a esa mesa a
 * buscar a nadie—, y eso es esta columna: Mesas y Cocina muestran «Para servir · <nombre>».
 *
 * Idempotente: comprueba `information_schema` antes del ALTER.
 * Registrada como `npm run migrate:restaurante-para-servir`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. restaurante.pedid_orden.para_servir ...');
        const [hay] = await Models.sequelize.query(
            `SELECT 1 AS hay FROM information_schema.columns
              WHERE table_schema = 'restaurante' AND table_name = 'pedid_orden'
                AND column_name = 'para_servir';`,
            { type: Models.sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!hay) {
            await Models.sequelize.query(
                `ALTER TABLE restaurante.pedid_orden
                     ADD COLUMN para_servir boolean NOT NULL DEFAULT false;`,
                { transaction: t }
            );
            console.log('   añadida (false para todos los pedidos existentes).');
        } else {
            console.log('   ya existía.');
        }

        await t.commit();
        console.log('✓ Migración «para servir» completada.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló la migración (revertida):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
}

migrate();
