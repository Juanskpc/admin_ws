/**
 * Habilita las dos consultas nuevas del asistente de reserva donde ya se agenda por WhatsApp.
 *
 *   npm run migrate:intelligence-consultas-reserva
 *
 * ## Por qué hace falta una migración para esto
 *
 * El Policy Gate deniega toda capacidad sin fila en `platform.capacidad_habilitada` («la
 * ausencia de una decisión no autoriza nada»). Las capacidades se habilitan a mano, negocio por
 * negocio, con `scripts/capacidad.js habilitar`. Así que un negocio que ya agenda por WhatsApp
 * **no recibe** una capacidad nueva por el hecho de desplegarla.
 *
 * Y en este caso eso importa mucho, porque el flujo está escrito para degradarse sin ellas:
 *
 *   · Sin `consultar_dias_con_horas`, el bot vuelve a proponer el día siguiente **a ciegas** —
 *     el bucle «no hay horas el 29, ¿el 30? no hay, ¿el 1?…» que un cliente de D'ALEX sufrió
 *     en producción el 2026-09-28 y que es la razón de esta capacidad.
 *   · Sin `consultar_mis_mascotas`, una peluquería canina no reconoce las mascotas de quien ya
 *     vino y le pregunta el nombre de su perro cada vez.
 *
 * O sea: desplegar el código sin correr esto deja el fallo exactamente donde estaba, y sin un
 * solo error que lo delate.
 *
 * ## A quién se le habilita
 *
 * Solo a los negocios que **ya tienen `consultar_disponibilidad` habilitada**: son los que ya
 * agendan por el asistente. No se le da nada a un negocio que no usa el bot. Las dos son
 * consultas de solo lectura, así que habilitarlas no permite hacer nada que no se pudiera ya.
 *
 * Idempotente: `ON CONFLICT DO NOTHING`, y respeta una decisión previa — si alguien la
 * deshabilitó a propósito en un negocio, no se vuelve a encender.
 */
'use strict';
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

const NUEVAS = ['consultar_dias_con_horas', 'consultar_mis_mascotas'];
const REFERENCIA = 'consultar_disponibilidad';

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: consultas nuevas del asistente de reserva ===\n');

        const [tabla] = await sequelize.query(
            `SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'platform' AND table_name = 'capacidad_habilitada'`,
            { transaction: t },
        );
        if (tabla.length === 0) {
            throw new Error('No existe platform.capacidad_habilitada. Corre antes: npm run migrate:platform-capacidades');
        }

        for (const capacidad of NUEVAS) {
            const [, meta] = await sequelize.query(
                `INSERT INTO platform.capacidad_habilitada
                     (id_negocio, capacidad, habilitada, habilitada_en, habilitada_por)
                 SELECT ch.id_negocio, :capacidad, true, now(), NULL
                   FROM platform.capacidad_habilitada ch
                  WHERE ch.capacidad = :referencia AND ch.habilitada = true
                 ON CONFLICT (id_negocio, capacidad) DO NOTHING`,
                { replacements: { capacidad, referencia: REFERENCIA }, transaction: t },
            );
            console.log(`  ${capacidad}: ${meta?.rowCount ?? 0} negocio(s) nuevo(s)`);
        }

        await t.commit();
        console.log('\n✓ Migración completada.\n');
    } catch (err) {
        await t.rollback();
        console.error('\n✗ Error — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
