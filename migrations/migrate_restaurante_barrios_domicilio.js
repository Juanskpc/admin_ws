/**
 * Migración: barrios con precio de domicilio (restaurante).
 *  - Crea restaurante.rest_barrio_domicilio: la lista de barrios que atiende cada negocio y lo
 *    que cuesta llevarle el pedido a cada uno.
 *
 * Solo aplica si el negocio tiene `permite_pago_domicilio` encendido (ese flag ya existe y sigue
 * mandando: apagado, no se cobra domicilio ni se pregunta el barrio). Sin filas, todo se
 * comporta como hasta hoy.
 *
 * Borrado lógico (`estado = 'E'`): los pedidos ya creados no cuelgan de esta tabla (guardan su
 * `valor_domicilio`), pero conservar la fila deja rastro de qué se cobraba.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-barrios-domicilio
 */
'use strict';
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante — Barrios con precio de domicilio\n');

        console.log('1. Creando restaurante.rest_barrio_domicilio...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_barrio_domicilio (
                id_barrio      SERIAL PRIMARY KEY,
                id_negocio     INTEGER NOT NULL
                    REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                nombre         VARCHAR(100) NOT NULL,
                valor          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (valor >= 0),
                estado         CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS ix_rest_barrio_domicilio_negocio
                ON restaurante.rest_barrio_domicilio (id_negocio, estado);
            -- Un nombre por negocio entre los activos: dos «Centro» en la lista del cliente
            -- serían una pregunta sin respuesta.
            CREATE UNIQUE INDEX IF NOT EXISTS ux_rest_barrio_domicilio_nombre
                ON restaurante.rest_barrio_domicilio (id_negocio, lower(nombre))
                WHERE estado = 'A';
        `, { transaction: t });
        console.log('   ✓');

        await t.commit();
        console.log('\n✓ Migración de barrios completada.');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
