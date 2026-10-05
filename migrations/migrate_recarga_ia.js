/**
 * Migración: recargas del saldo de IA (vista «Consumo IA» del super admin).
 *
 *  - general.gener_recarga_ia
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
