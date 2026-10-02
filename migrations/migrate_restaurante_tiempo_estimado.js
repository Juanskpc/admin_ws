/**
 * Migración: tiempo estimado del pedido, por negocio.
 *
 *  - general.gener_negocio.tiempo_estimado_min   smallint NULL   (minutos; «de X a Y»)
 *  - general.gener_negocio.tiempo_estimado_max   smallint NULL   (opcional; sin él es «unos X»)
 *
 * Es lo que el asistente contesta cuando un cliente pregunta «¿cuánto se demora?»: cada local
 * escribe su estimado (p. ej. 40 a 60 minutos) y el bot lo dice primero, con el aviso de que se
 * le escribirá antes si el pedido sale antes. NULL = el negocio no lo ha configurado, y el bot se
 * comporta como hasta hoy (no inventa un tiempo).
 *
 * Son dos columnas y no un texto libre para poder validar (nada de «una eternidad») y para que
 * la frase salga siempre bien construida, venga el rango o el valor suelto.
 *
 * Idempotente: comprueba `information_schema` antes de cada ALTER.
 * Registrada como `npm run migrate:restaurante-tiempo-estimado`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function columnaExiste(esquema, tabla, columna, transaction) {
    const [fila] = await Models.sequelize.query(
        `SELECT 1 AS hay FROM information_schema.columns
          WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;`,
        {
            replacements: { esquema, tabla, columna },
            type: Models.sequelize.QueryTypes.SELECT,
            transaction,
        }
    );
    return Boolean(fila);
}

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. general.gener_negocio.tiempo_estimado_min ...');
        if (!(await columnaExiste('general', 'gener_negocio', 'tiempo_estimado_min', t))) {
            await Models.sequelize.query(
                `ALTER TABLE general.gener_negocio
                     ADD COLUMN tiempo_estimado_min smallint
                     CHECK (tiempo_estimado_min BETWEEN 1 AND 600);`,
                { transaction: t }
            );
            console.log('   añadida (NULL = sin configurar).');
        } else {
            console.log('   ya existía.');
        }

        console.log('2. general.gener_negocio.tiempo_estimado_max ...');
        if (!(await columnaExiste('general', 'gener_negocio', 'tiempo_estimado_max', t))) {
            await Models.sequelize.query(
                `ALTER TABLE general.gener_negocio
                     ADD COLUMN tiempo_estimado_max smallint
                     CHECK (tiempo_estimado_max BETWEEN 1 AND 600);`,
                { transaction: t }
            );
            console.log('   añadida.');
        } else {
            console.log('   ya existía.');
        }

        console.log('3. coherencia (max >= min, y max solo con min) ...');
        const [restriccion] = await Models.sequelize.query(
            `SELECT 1 AS hay FROM information_schema.table_constraints
              WHERE constraint_schema = 'general' AND table_name = 'gener_negocio'
                AND constraint_name = 'chk_negocio_tiempo_estimado';`,
            { type: Models.sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!restriccion) {
            await Models.sequelize.query(
                `ALTER TABLE general.gener_negocio
                     ADD CONSTRAINT chk_negocio_tiempo_estimado CHECK (
                         tiempo_estimado_max IS NULL
                         OR (tiempo_estimado_min IS NOT NULL AND tiempo_estimado_max >= tiempo_estimado_min));`,
                { transaction: t }
            );
            console.log('   añadida.');
        } else {
            console.log('   ya existía.');
        }

        await t.commit();
        console.log('✓ Migración tiempo estimado completada.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló la migración (revertida):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
}

migrate();
