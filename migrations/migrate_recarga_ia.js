/**
 * Migración: recargas del saldo de IA (vista «Consumo IA» del super admin).
 *
 *  - general.gener_recarga_ia (+ gasto_dia_previo_usd, 2026-10-05)
 *
 * ## Por qué hace falta una tabla
 *
 * OpenAI enseña el gasto por API (`/v1/organization/costs`, con la clave de administrador),
 * pero **no el saldo prepagado**: ese número solo vive en su panel. Para saber «cuánto me
 * queda» sin entrar al panel, el saldo se reconstruye:
 *
 *     saldo = último SALDO registrado + RECARGAS posteriores − gasto oficial desde ese SALDO
 *
 * Un SALDO es el punto de partida: lo que el panel de OpenAI dice que queda en una fecha. Se
 * puede volver a registrar cuando se quiera para recalibrar, y el cálculo arranca del más
 * reciente. Una RECARGA es plata que se le metió después.
 *
 * Borrar es `estado = 'E'`: una recarga es dinero, y que desaparezca sin rastro es justo lo que
 * no tiene que poder pasar. Cada alta y cada baja se audita además en `auditoria.audit_evento`.
 *
 * `fecha` es `timestamp without time zone` en hora de Bogotá, como el resto de la base.
 *
 * Idempotente. Registrada como `npm run migrate:recarga-ia`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. general.gener_recarga_ia ...');
        await Models.sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS general.gener_recarga_ia (
                id_recarga      serial PRIMARY KEY,
                proveedor       varchar(20)   NOT NULL DEFAULT 'openai',
                tipo            varchar(10)   NOT NULL,
                monto_usd       numeric(12,2) NOT NULL,
                fecha           timestamp     NOT NULL DEFAULT now(),
                nota            varchar(200),
                estado          char(1)       NOT NULL DEFAULT 'A',
                id_usuario      integer,
                creado_en       timestamp     NOT NULL DEFAULT now(),
                CONSTRAINT chk_recarga_ia_tipo   CHECK (tipo IN ('SALDO', 'RECARGA')),
                CONSTRAINT chk_recarga_ia_monto  CHECK (monto_usd >= 0),
                CONSTRAINT chk_recarga_ia_estado CHECK (estado IN ('A', 'E'))
            );
            `,
            { transaction: t }
        );
        await Models.sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_recarga_ia_proveedor_fecha
                 ON general.gener_recarga_ia (proveedor, fecha DESC) WHERE estado = 'A';`,
            { transaction: t }
        );
        await Models.sequelize.query(
            `COMMENT ON TABLE general.gener_recarga_ia IS
             'Saldo de partida y recargas del proveedor de IA. OpenAI no expone el saldo por API: '
             'se reconstruye como último SALDO + RECARGAS posteriores − gasto oficial.';`,
            { transaction: t }
        );

        // 2026-10-05: cuánto llevaba gastado OpenAI ese día UTC al registrar un SALDO. Sin esto
        // se restaba el día entero, incluido lo gastado antes del registro, que el saldo que se
        // ve en OpenAI ya tiene descontado (ver `calcularSaldo` en consumoIaService).
        console.log('2. general.gener_recarga_ia.gasto_dia_previo_usd ...');
        const [hay] = await Models.sequelize.query(
            `SELECT 1 AS hay FROM information_schema.columns
              WHERE table_schema = 'general' AND table_name = 'gener_recarga_ia'
                AND column_name = 'gasto_dia_previo_usd';`,
            { type: Models.sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!hay) {
            await Models.sequelize.query(
                `ALTER TABLE general.gener_recarga_ia ADD COLUMN gasto_dia_previo_usd numeric(14,6);`,
                { transaction: t }
            );
            console.log('   añadida (NULL en los registros anteriores: usan la cuenta interna).');
        } else {
            console.log('   ya existía.');
        }

        await t.commit();
        console.log('✓ Migración de recargas de IA completada.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló la migración (revertida):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
}

migrate();
