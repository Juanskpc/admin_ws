/**
 * Habilita `consultar_info_negocio` en los restaurantes que ya toman pedidos por el asistente.
 *
 *   npm run migrate:intelligence-info-negocio
 *
 * ## Por qué hace falta
 *
 * El Policy Gate deniega toda capacidad sin fila en `platform.capacidad_habilitada`. La
 * capacidad `consultar_info_negocio` (Nequi, métodos de pago, valor del domicilio, horario,
 * tiempo estimado) se desplegó el 2026-10-01 pero **nadie la habilitó**: el modelo nunca la vio.
 * Auditoría del 2026-10-03 (Zona Burger): cero invocaciones, y cada pregunta de pago o de «cuánto
 * es con el domicilio» acabó en `pasar_a_persona` aunque el dato estaba cargado.
 *
 * ## A quién se le habilita
 *
 * Solo a los negocios que ya tienen `consultar_estado_pedido` habilitada (los restaurantes que
 * usan el asistente). Es una consulta de solo lectura. Idempotente (`ON CONFLICT DO NOTHING`) y
 * respeta una decisión previa: si alguien la deshabilitó a propósito, no se vuelve a encender.
 */
'use strict';
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

const NUEVAS = ['consultar_info_negocio'];
const REFERENCIA = 'consultar_estado_pedido';

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: consultar_info_negocio en restaurantes ===\n');

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
