/**
 * Auditoría de SOLO LECTURA del gasto en IA: lo que registra el Ledger (`intelligence.costo`,
 * una fila por llamada al modelo) frente a lo que factura OpenAI (Admin API, por concepto).
 *
 *   node scripts/auditoria_costo_ia.js [dias=10]
 *
 * No escribe nada. Necesita OPENAI_ADMIN_KEY para la parte oficial (si falta, la omite).
 */
'use strict';
require('dotenv').config();
const Models = require('../app_core/models/conection');

const dias = Number(process.argv[2] || 10);
const q = (sql, r = {}) =>
    Models.sequelize.query(sql, { replacements: { dias, ...r }, type: Models.sequelize.QueryTypes.SELECT, logging: false });
const n = (v, d = 4) => Number(Number(v || 0).toFixed(d));

(async () => {
    console.log(`\n=== Ledger: por día y negocio (últimos ${dias} días, hora Bogotá) ===`);
    console.table(
        (await q(`
            SELECT to_char(c.creado_en AT TIME ZONE 'America/Bogota', 'MM-DD') AS dia, c.id_negocio AS neg,
                   c.modelo, count(*)::int AS llamadas, count(DISTINCT c.id_turno)::int AS turnos_llm,
                   round(avg(c.tokens_entrada))::int AS entrada_media,
                   round(avg(c.tokens_cache_lectura))::int AS cache_media,
                   round(avg(c.tokens_salida))::int AS salida_media,
                   sum(c.costo_usd)::numeric(10,4) AS usd
              FROM intelligence.costo c
             WHERE c.creado_en >= now() - (:dias * interval '1 day')
             GROUP BY 1, 2, 3 ORDER BY 1, 2;`))
    );

    console.log('\n=== Turnos por nivel y día (todos los negocios) ===');
    console.table(
        await q(`
            SELECT to_char(t.creado_en AT TIME ZONE 'America/Bogota', 'MM-DD') AS dia, t.id_negocio AS neg,
                   count(*) FILTER (WHERE t.nivel = 'determinista')::int AS deterministas,
                   count(*) FILTER (WHERE t.nivel = 'llm')::int AS llm,
                   count(*)::int AS total
              FROM intelligence.turno t
             WHERE t.creado_en >= now() - (:dias * interval '1 day')
             GROUP BY 1, 2 ORDER BY 1, 2;`)
    );

    console.log('\n=== Llamadas al modelo por turno LLM (vueltas del bucle) ===');
    console.table(
        await q(`
            SELECT llamadas, count(*)::int AS turnos
              FROM (SELECT id_turno, count(*) AS llamadas FROM intelligence.costo
                     WHERE creado_en >= now() - (:dias * interval '1 day') GROUP BY id_turno) x
             GROUP BY 1 ORDER BY 1;`)
    );

    console.log('\n=== Tamaño del prompt por llamada (entrada + caché) ===');
    console.table(
        await q(`
            SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY tokens_entrada + tokens_cache_lectura) AS p50,
                   percentile_disc(0.9) WITHIN GROUP (ORDER BY tokens_entrada + tokens_cache_lectura) AS p90,
                   max(tokens_entrada + tokens_cache_lectura) AS max,
                   round(100.0 * sum(tokens_cache_lectura) / NULLIF(sum(tokens_entrada + tokens_cache_lectura), 0), 1) AS pct_cacheado,
                   round(avg(tokens_salida))::int AS salida_media
              FROM intelligence.costo
             WHERE creado_en >= now() - (:dias * interval '1 day');`)
    );

    console.log('\n=== Por negocio: gasto, conversaciones y pedidos del asistente (Ledger) ===');
    console.table(
        await q(`
            SELECT c.id_negocio AS neg, sum(c.costo_usd)::numeric(10,4) AS usd,
                   count(DISTINCT c.id_conversacion)::int AS conversaciones_con_llm,
                   (SELECT count(*) FROM intelligence.invocacion_capacidad i
                     WHERE i.id_negocio = c.id_negocio AND i.capacidad = 'tomar_pedido' AND i.resultado = 'ok'
                       AND NOT i.dry_run AND i.creado_en >= now() - (:dias * interval '1 day'))::int AS pedidos
              FROM intelligence.costo c
             WHERE c.creado_en >= now() - (:dias * interval '1 day')
             GROUP BY 1 ORDER BY 2 DESC;`)
    );

    console.log('\n=== Herramientas por llamada al modelo (qué pide el modelo) ===');
    console.table(
        await q(`
            SELECT capacidad, count(*)::int AS veces
              FROM intelligence.invocacion_capacidad
             WHERE creado_en >= now() - (:dias * interval '1 day')
             GROUP BY 1 ORDER BY 2 DESC LIMIT 12;`)
    );

    if (process.env.OPENAI_ADMIN_KEY) {
        try {
            const { consultarCostosOficiales } = require('../app_admin_api/services/consumoIaService');
            const desde = Math.floor(Date.now() / 1000) - dias * 86400;
            const r = await consultarCostosOficiales(desde, { forzar: true });
            console.log('=== OpenAI (oficial): por concepto ===');
            console.table(r.por_concepto.map((f) => ({ concepto: f.concepto, usd: n(f.usd) })));
            console.log('=== OpenAI (oficial): por día (UTC) ===');
            console.table(r.por_dia.map((f) => ({ fecha: f.fecha, usd: n(f.usd) })));
        } catch (error) {
            console.log('No se pudo leer el costo oficial:', error.message);
        }
    }
    await Models.sequelize.close();
})().catch((e) => { console.error(e); process.exit(1); });
