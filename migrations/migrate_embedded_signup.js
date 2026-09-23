/**
 * Añade a `platform.numero_canal` lo que le falta para que un negocio pueda traer su propio
 * token de WhatsApp (Embedded Signup) en vez de depender siempre del token global de la WABA
 * nuestra. Hasta hoy esa columna no existía a propósito: `migrate_platform_numeros_canal.js` la
 * dejó pendiente citando ADR-013 (no construir para un caso que todavía no existe). Ese caso ya
 * existe — el App Review se aprobó el 2026-09-17 y hay un cliente real que lo necesita — así que
 * este es el momento de escribirla, no antes. Ver `docs/embedded-signup.md` §7.
 *
 * El cifrado de `token_cifrado` usa `app_core/helpers/credencialCifrada.js` (AES-256-GCM, clave
 * en `WHATSAPP_TOKEN_KEY`) — ver `docs/embedded-signup.md` §2.
 *
 * Registrada como `npm run migrate:embedded-signup`.
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
        console.log('1. Columnas nuevas en platform.numero_canal...');

        // Cuáles filas siguen con el token compartido (alta manual) y cuáles ya traen el suyo
        // (Embedded Signup). Sin esto, `numeros.js` no puede decidir por fila qué token usar en
        // el período de transición en que conviven las dos formas.
        if (!(await existeColumna('platform', 'numero_canal', 'origen', t))) {
            await Models.sequelize.query(
                `ALTER TABLE platform.numero_canal
                    ADD COLUMN origen varchar(20) NOT NULL DEFAULT 'manual';`,
                { transaction: t }
            );
            await Models.sequelize.query(
                `ALTER TABLE platform.numero_canal
                    ADD CONSTRAINT chk_numero_canal_origen
                    CHECK (origen IN ('manual', 'embedded_signup'));`,
                { transaction: t }
            );
        }

        // El token de larga duración del cliente. Cifrado, nunca en claro — igual de sensible que
        // el WHATSAPP_APP_SECRET de hoy, con la diferencia de que este vive en la base y no en el
        // .env porque hay uno por fila, no uno para todo el proceso.
        if (!(await existeColumna('platform', 'numero_canal', 'token_cifrado', t))) {
            await Models.sequelize.query(
                `ALTER TABLE platform.numero_canal ADD COLUMN token_cifrado text;`,
                { transaction: t }
            );
        }

        // waba_id y business_id: identifican la cuenta de WhatsApp Business y la empresa de Meta
        // del cliente. Hacen falta para las llamadas de suscripción (POST /{waba_id}/subscribed_apps)
        // y para saber a quién pertenece el token si hay que rotarlo o revocarlo.
        if (!(await existeColumna('platform', 'numero_canal', 'waba_id', t))) {
            await Models.sequelize.query(
                `ALTER TABLE platform.numero_canal ADD COLUMN waba_id varchar(100);`,
                { transaction: t }
            );
        }
        if (!(await existeColumna('platform', 'numero_canal', 'business_id', t))) {
            await Models.sequelize.query(
                `ALTER TABLE platform.numero_canal ADD COLUMN business_id varchar(100);`,
                { transaction: t }
            );
        }

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
