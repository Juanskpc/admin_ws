/**
 * Cobranza — pago automático OPCIONAL con tarjeta guardada en Wompi (2026-10-14).
 *
 * Decisión del dueño: el débito automático es opcional. Quien registra su tarjeta en «Mis pagos»
 * no vuelve a pensar en pagar; quien no, sigue pagando con el enlace (PSE, Nequi, tarjeta) como
 * hasta ahora.
 *
 * ## 1. La constancia de la autorización
 *
 * `cob_metodo_pago` guardaba la tarjeta pero no QUIÉN autorizó cobrarle cada mes, ni cuándo, ni
 * desde dónde. Si un cliente desconoce un cargo ante su banco, esa es la prueba de que lo pidió:
 *
 *   - `autorizado_por`  → el usuario que activó el pago automático.
 *   - `autorizado_en`   → cuándo (hora de Bogotá, como todo el esquema).
 *   - `ip_autorizacion` → desde dónde.
 *
 * ## 2. `proximo_cobro` solo para quien tiene tarjeta
 *
 * `aplicarPagoAprobado` le ponía fecha de próximo cobro a CUALQUIER suscripción de Wompi al pagar,
 * tuviera o no medio guardado (Zona Burger y El Callejero la tenían). Con el cron encendido, eso
 * era intentar cobrar cada mañana a negocios sin tarjeta. El código ya no lo hace; aquí se limpian
 * las que quedaron.
 *
 * Idempotente: comprueba `information_schema` antes de cada ALTER; el UPDATE solo toca lo que
 * todavía está mal.
 * Ejecutar con: npm run migrate:cobranza-pago-automatico
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function existeColumna(tabla, columna, t) {
    const filas = await sequelize.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'cobranza' AND table_name = :tabla AND column_name = :columna
          LIMIT 1;`,
        { replacements: { tabla, columna }, transaction: t, type: sequelize.QueryTypes.SELECT }
    );
    return filas.length > 0;
}

const COLUMNAS = [
    [
        'autorizado_por',
        'integer REFERENCES general.gener_usuario(id_usuario)',
        'Usuario que autorizó el débito automático con este medio de pago.',
    ],
    ['autorizado_en', 'timestamp', 'Cuándo se autorizó el débito automático (hora de Bogotá).'],
    ['ip_autorizacion', 'varchar(64)', 'Desde qué IP se autorizó el débito automático.'],
];

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: pago automático opcional\n');

        const [[infra]] = await sequelize.query(
            `SELECT to_regclass('cobranza.cob_metodo_pago') IS NOT NULL AS ok;`,
            { transaction: t }
        );
        if (!infra.ok) {
            throw new Error('Falta el esquema de cobranza. Ejecute primero: npm run migrate:cobranza');
        }

        console.log('1. Constancia de la autorización en cob_metodo_pago...');
        for (const [columna, tipo, comentario] of COLUMNAS) {
            if (await existeColumna('cob_metodo_pago', columna, t)) {
                console.log(`   ${columna}: ya existía.`);
                continue;
            }
            await sequelize.query(
                `ALTER TABLE cobranza.cob_metodo_pago ADD COLUMN ${columna} ${tipo};`,
                { transaction: t }
            );
            await sequelize.query(
                `COMMENT ON COLUMN cobranza.cob_metodo_pago.${columna} IS '${comentario}';`,
                { transaction: t }
            );
            console.log(`   ${columna}: añadida.`);
        }

        console.log('2. Próximo cobro solo para suscripciones con medio de pago guardado...');
        const limpiadas = await sequelize.query(
            `UPDATE cobranza.cob_suscripcion s
                SET proximo_cobro = NULL
              WHERE s.proximo_cobro IS NOT NULL
                AND (s.id_metodo_pago IS NULL
                     OR NOT EXISTS (SELECT 1 FROM cobranza.cob_metodo_pago m
                                     WHERE m.id_metodo_pago = s.id_metodo_pago AND m.estado = 'A'))
             RETURNING s.id_negocio;`,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        console.log(
            `   ${limpiadas.length} suscripción(es) sin tarjeta dejan de tener próximo cobro` +
                (limpiadas.length ? ` (negocios ${limpiadas.map((f) => f.id_negocio).join(', ')}).` : '.')
        );

        await t.commit();
        console.log('\n✅ Pago automático listo: constancia de autorización y próximo cobro saneado.');
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
