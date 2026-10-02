/**
 * Migración: empaque automático por producto.
 *
 *  - restaurante.carta_producto.id_producto_empaque   integer NULL  → otro producto del negocio
 *  - restaurante.carta_producto.cantidad_empaque      smallint NOT NULL DEFAULT 1 (por unidad)
 *
 * El empaque ya es un producto más (categoría oculta «EMPAQUES»: pequeño, mediano) que el personal
 * agrega a mano a los pedidos para llevar y a domicilio. Esto solo liga cada producto con el suyo,
 * para que el asistente lo agregue solo y no cotice por debajo de lo que el negocio cobra.
 *
 * NULL = sin empaque. Un negocio que no usa empaques no tiene ninguna fila ligada y nada cambia.
 *
 * Idempotente: comprueba `information_schema` antes de cada ALTER.
 * Registrada como `npm run migrate:restaurante-empaque-producto`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function existe(sql, replacements, transaction) {
    const [fila] = await Models.sequelize.query(sql, {
        replacements,
        type: Models.sequelize.QueryTypes.SELECT,
        transaction,
    });
    return Boolean(fila);
}

const columnaExiste = (columna, t) =>
    existe(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'restaurante' AND table_name = 'carta_producto' AND column_name = :columna;`,
        { columna },
        t
    );

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. carta_producto.id_producto_empaque ...');
        if (!(await columnaExiste('id_producto_empaque', t))) {
            await Models.sequelize.query(
                `ALTER TABLE restaurante.carta_producto
                     ADD COLUMN id_producto_empaque integer
                     REFERENCES restaurante.carta_producto (id_producto) ON DELETE SET NULL;`,
                { transaction: t }
            );
            console.log('   añadida (NULL = sin empaque).');
        } else {
            console.log('   ya existía.');
        }

        console.log('2. carta_producto.cantidad_empaque ...');
        if (!(await columnaExiste('cantidad_empaque', t))) {
            await Models.sequelize.query(
                `ALTER TABLE restaurante.carta_producto
                     ADD COLUMN cantidad_empaque smallint NOT NULL DEFAULT 1
                     CHECK (cantidad_empaque BETWEEN 1 AND 20);`,
                { transaction: t }
            );
            console.log('   añadida.');
        } else {
            console.log('   ya existía.');
        }

        await t.commit();
        console.log('✓ Migración empaque por producto completada.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló la migración (revertida):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
}

migrate();
