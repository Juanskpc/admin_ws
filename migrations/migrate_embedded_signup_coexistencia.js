/**
 * Coexistencia de WhatsApp (el número sigue en la app WhatsApp Business del celular Y queda
 * conectado a la Cloud API) + registro de números nuevos. Ver `docs/embedded-signup.md` §10.
 *
 * Añade a `platform.numero_canal`:
 *   - `coexistencia` — si el número se conectó desde la app WhatsApp Business (coexistencia) o es
 *     un número dedicado a la API. Cambia lo que se puede y no se puede hacer con él: un número en
 *     coexistencia NO se registra (`/register`) y Meta lo desconecta si el dueño pasa ~14 días sin
 *     abrir la app; un número dedicado sí se registra, con un PIN de verificación en dos pasos.
 *   - `pin_cifrado` — el PIN de 6 dígitos con el que se registró un número dedicado. Hace falta
 *     para volver a registrarlo (cambio de servidor de Meta, reconexión) sin tener que resetear la
 *     verificación en dos pasos desde WhatsApp Manager. Cifrado con `credencialCifrada.js`, igual
 *     que `token_cifrado`. Siempre NULL en coexistencia.
 *
 * Idempotente. Registrada como `npm run migrate:embedded-signup-coexistencia`. Requiere que antes
 * se haya corrido `migrate:embedded-signup` (columnas origen/token_cifrado/waba_id/business_id).
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function existeColumna(esquema, tabla, columna, t) {
    const filas = await Models.sequelize.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna LIMIT 1;`,
        {
            replacements: { esquema, tabla, columna },
            transaction: t,
            type: Models.sequelize.QueryTypes.SELECT,
        }
    );
    return filas.length > 0;
}

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        if (!(await existeColumna('platform', 'numero_canal', 'origen', t))) {
            throw new Error(
                'Falta la columna platform.numero_canal.origen: corre antes `npm run migrate:embedded-signup`.'
            );
        }

        console.log('1. platform.numero_canal.coexistencia...');
        if (!(await existeColumna('platform', 'numero_canal', 'coexistencia', t))) {
            await Models.sequelize.query(
                `ALTER TABLE platform.numero_canal
                    ADD COLUMN coexistencia boolean NOT NULL DEFAULT false;`,
                { transaction: t }
            );
        }

        console.log('2. platform.numero_canal.pin_cifrado...');
        if (!(await existeColumna('platform', 'numero_canal', 'pin_cifrado', t))) {
            await Models.sequelize.query(
                `ALTER TABLE platform.numero_canal ADD COLUMN pin_cifrado text;`,
                { transaction: t }
            );
        }

        // El webhook `account_update` no trae `phone_number_id`: solo el id de la WABA (entry.id).
        // Con Embedded Signup cada negocio trae su propia WABA, así que se busca por ella.
        console.log('3. Índice por waba_id...');
        await Models.sequelize.query(
            `CREATE INDEX IF NOT EXISTS ix_numero_canal_waba
                 ON platform.numero_canal (waba_id) WHERE waba_id IS NOT NULL;`,
            { transaction: t }
        );

        await t.commit();
        console.log('✓ Listo.');
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

migrate()
    .then(() => Models.sequelize.close())
    .catch(async (error) => {
        console.error('Falló la migración:', error.message);
        await Models.sequelize.close();
        process.exit(1);
    });
