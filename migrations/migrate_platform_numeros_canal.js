/**
 * `platform.numero_canal` — qué número atiende a qué negocio (F8-C, punto 4).
 *
 * ## Lo que sustituye
 *
 * Hoy esto son **dos variables de entorno**: `WHATSAPP_PHONE_NUMBER_ID` y `WHATSAPP_NEGOCIO_ID`.
 * Con un cliente funcionaba; con dos deja de haber dónde escribir el segundo par, y apuntar el
 * número a otro negocio deja al anterior sin bot.
 *
 * ## Dónde viven los secretos — la decisión que quedaba abierta
 *
 * El log de arranque llevaba meses diciendo *«para el segundo hace falta una tabla y decidir dónde
 * viven los secretos»*. Decidido: **el token sigue siendo global y no se guarda aquí.**
 *
 * El motivo es que un token de usuario de sistema **cubre la WABA entera**, no un número. Mientras
 * todos los números cuelguen de *nuestra* WABA —que es el modelo de alta manual— el mismo token
 * sirve para todos y lo único que cambia es el `phone_number_id`. Guardar un token por negocio
 * sería guardar el mismo secreto N veces, con N sitios desde los que filtrarse y N sitios que
 * rotar.
 *
 * El día que se haga *Embedded Signup* —cada cliente con su propia WABA— eso cambia, y entonces
 * hará falta una columna cifrada aquí. **No antes**: ADR-013 pide no construir para un caso que
 * todavía no existe.
 *
 * ## Un número activo por negocio, y es a propósito
 *
 * El índice único parcial impide que un negocio tenga dos números activos en el mismo canal. No es
 * una limitación de la tabla: es que `entregar()` tiene que poder responder **desde cuál**, y con
 * dos la respuesta sería ambigua. El día que un negocio necesite dos, la conversación tendrá que
 * recordar por cuál entró — otro cambio, y más grande.
 *
 * Y en el otro sentido el único es total: un `phone_number_id` pertenece **a un solo negocio**.
 * Esa es la propiedad que impide que un webhook mal enrutado escriba en la conversación de otro
 * inquilino, que es la fuga que cerró F2.
 *
 * Idempotente. Siembra el par que hoy está en el `.env`, si lo hay, para que el cambio no tenga
 * corte: producción sigue funcionando desde el primer arranque sin tocar nada a mano.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. Esquema platform...');
        await Models.sequelize.query('CREATE SCHEMA IF NOT EXISTS platform;', { transaction: t });

        console.log('2. Tabla platform.numero_canal...');
        await Models.sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS platform.numero_canal (
                id_numero_canal uuid PRIMARY KEY DEFAULT gen_random_uuid(),

                -- 'whatsapp' hoy. La columna existe porque el día que haya voz o Instagram, la
                -- pregunta «¿de quién es este identificador?» es la misma con otro nombre.
                canal           varchar(30) NOT NULL,

                -- El identificador DEL CANAL. En WhatsApp es el phone_number_id de Meta, que no
                -- es el número de teléfono: son cosas distintas y confundirlas cuesta una tarde.
                id_externo      varchar(100) NOT NULL,

                id_negocio      integer NOT NULL
                                REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,

                -- Solo para que un humano reconozca la fila en el panel y en los logs. No se
                -- enruta por aquí.
                numero_e164     varchar(20),

                estado          char(1) NOT NULL DEFAULT 'A',
                creado_en       timestamptz NOT NULL DEFAULT now(),

                CONSTRAINT chk_numero_canal_estado CHECK (estado IN ('A', 'I'))
            );
            `,
            { transaction: t }
        );

        // Un id_externo pertenece a UN negocio. Sin esto, dos filas contradictorias harían que
        // el enrutado dependiera del orden de lectura — y el error sería escribir en la
        // conversación de otro inquilino.
        console.log('3. Únicos...');
        await Models.sequelize.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_numero_canal_externo
                 ON platform.numero_canal (canal, id_externo);`,
            { transaction: t }
        );

        // Y un negocio tiene un número activo por canal: `entregar()` no puede elegir entre dos.
        await Models.sequelize.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_numero_canal_negocio_activo
                 ON platform.numero_canal (canal, id_negocio)
              WHERE estado = 'A';`,
            { transaction: t }
        );

        console.log('4. Sembrando el número que hoy está en el .env...');
        const idExterno = process.env.WHATSAPP_PHONE_NUMBER_ID;
        const idNegocio = process.env.WHATSAPP_NEGOCIO_ID;

        if (!idExterno || !idNegocio) {
            console.log('   No hay par en el .env — nada que sembrar (normal en desarrollo).');
        } else {
            const [, meta] = await Models.sequelize.query(
                `
                INSERT INTO platform.numero_canal (canal, id_externo, id_negocio, numero_e164)
                SELECT 'whatsapp', :idExterno, :idNegocio, :numero
                 WHERE NOT EXISTS (
                     SELECT 1 FROM platform.numero_canal
                      WHERE canal = 'whatsapp' AND id_externo = :idExterno
                 );
                `,
                {
                    replacements: {
                        idExterno,
                        idNegocio: Number(idNegocio),
                        numero: process.env.WHATSAPP_NUMBER || null,
                    },
                    transaction: t,
                }
            );
            console.log(
                meta?.rowCount
                    ? `   Sembrado: ${idExterno} → negocio ${idNegocio}`
                    : '   Ya estaba.'
            );
        }

        const filas = await Models.sequelize.query(
            `SELECT canal, id_externo, id_negocio, estado FROM platform.numero_canal ORDER BY canal, id_negocio;`,
            { transaction: t, type: Models.sequelize.QueryTypes.SELECT }
        );

        await t.commit();

        console.log('\n=== Números registrados ===');
        if (filas.length === 0) console.log('   (ninguno)');
        for (const f of filas) {
            console.log(`   ${f.canal}  ${f.id_externo} → negocio ${f.id_negocio}  [${f.estado}]`);
        }
        console.log('\n✓ Listo.');
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
