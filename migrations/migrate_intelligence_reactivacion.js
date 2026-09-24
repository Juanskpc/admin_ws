/**
 * Migración: reactivación del asistente tras la intervención de una persona (ADR-023, Enmienda 2).
 *
 *  - general.gener_negocio.reactivar_asistente_min   integer NOT NULL DEFAULT 0, 0 = «nunca»
 *  - intelligence.conversacion.humano_ultimo_en      timestamptz  (última intervención humana)
 *
 * ## Qué guarda cada columna, y dónde vive
 *
 * `reactivar_asistente_min` es una decisión del NEGOCIO, no de una conversación ni del motor, así
 * que va donde ya viven sus demás interruptores (`permite_multipago`, `controla_inventario`…): en
 * `general.gener_negocio`. Meterla en una tabla de intelligence obligaba a crear una tabla solo
 * para una cifra, y el motor la lee igual con un `JOIN` en el mismo `UPDATE`.
 *
 *   · **0 significa «nunca»** y no NULL. Con NULL habría tres estados (sin configurar / nunca /
 *     N minutos) y «sin configurar» no es una decisión que el negocio haya tomado. Con 0 hay dos:
 *     un número de minutos, o ninguno. El CHECK lo acota a 0..10080 (una semana).
 *   · **Nace en 0 (nunca)**, decisión del usuario del 2026-09-23: hasta que cada negocio lo active,
 *     el comportamiento es exactamente el de la Enmienda 1 —el asistente no vuelve solo—. Ninguna
 *     conversación existente cambia de comportamiento por correr esta migración. La pantalla
 *     propone 30 minutos al activarlo, pero eso es un valor sugerido, no el que hay guardado.
 *
 * `humano_ultimo_en` es el reloj del plazo: se fija con cada mensaje que escribe una persona del
 * negocio —desde la Bandeja o desde su propio WhatsApp— y cuando marca la conversación como
 * atendida. Es una columna y no «el último mensaje humano de `mensaje`» porque la regla se evalúa
 * en el mismo UPDATE que recibe el mensaje del cliente, y ahí una lectura O(1) importa; y porque
 * atender sin escribir no deja ningún mensaje que mirar.
 *
 * Idempotente: comprueba `information_schema` antes de cada ALTER.
 * Registrada como `npm run migrate:intelligence-reactivacion`.
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
        console.log('1. general.gener_negocio.reactivar_asistente_min ...');
        if (!(await columnaExiste('general', 'gener_negocio', 'reactivar_asistente_min', t))) {
            await Models.sequelize.query(
                `ALTER TABLE general.gener_negocio
                     ADD COLUMN reactivar_asistente_min integer NOT NULL DEFAULT 0
                     CHECK (reactivar_asistente_min BETWEEN 0 AND 10080);`,
                { transaction: t }
            );
            console.log('   añadida (default 0 = nunca).');
        } else {
            console.log('   ya existía.');
        }

        console.log('2. intelligence.conversacion.humano_ultimo_en ...');
        const hayEsquema = await Models.sequelize.query(
            `SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'intelligence' AND table_name = 'conversacion';`,
            { type: Models.sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (hayEsquema.length === 0) {
            console.log('   el esquema intelligence no está migrado en este entorno: se omite.');
        } else if (!(await columnaExiste('intelligence', 'conversacion', 'humano_ultimo_en', t))) {
            await Models.sequelize.query(
                `ALTER TABLE intelligence.conversacion ADD COLUMN humano_ultimo_en timestamptz;`,
                { transaction: t }
            );

            // Las que ya están en manos de una persona: su última intervención conocida es su
            // último mensaje escrito a mano (`crudo.origen = 'humano'`) o, si se marcó atendida
            // sin escribir, cuando se marcó. Sin esto arrancarían con el reloj en NULL, o sea,
            // «no vuelve hasta que alguien haga algo»: conservador, pero inconsistente con las
            // nuevas.
            const [, meta] = await Models.sequelize.query(
                `UPDATE intelligence.conversacion c
                    SET humano_ultimo_en = GREATEST(
                          (SELECT max(m.creado_en) FROM intelligence.mensaje m
                            WHERE m.id_conversacion = c.id_conversacion
                              AND m.direccion = 'saliente'
                              AND m.crudo ->> 'origen' = 'humano'),
                          c.atendida_en)
                  WHERE c.estado = 'handoff_humano';`,
                { transaction: t }
            );
            console.log(`   añadida; ${meta?.rowCount ?? 0} conversación(es) en manos de una persona con su reloj inicial.`);
        } else {
            console.log('   ya existía.');
        }

        await t.commit();
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
