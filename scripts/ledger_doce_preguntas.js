/**
 * Las doce preguntas del Ledger (ADR-022).
 *
 * Uso:
 *   node scripts/ledger_doce_preguntas.js [--negocio <id>] [--dias 30]
 *
 * ## Qué es esto
 *
 * ADR-022 no describe el esquema del Ledger: describe **lo que tiene que poder responder**,
 * y añade una regla dura — «si el esquema no responde a las doce, está mal diseñado».
 *
 * Este archivo es esa especificación, escrita como SQL ejecutable en vez de como prosa. Es
 * la definición única: `__tests__/intelligence/ledger.test.js` importa estas mismas
 * consultas y comprueba sus resultados contra datos sintéticos. Una pregunta que aquí no
 * corre es un esquema roto, y se entera uno hoy en vez de dentro de un año, cuando los datos
 * que faltan ya no se pueden recuperar.
 *
 * ## Por qué también sirve como herramienta
 *
 * Es la consulta cruda que hay detrás de la Intelligence Console (F5-E). Tener el SQL
 * primero y la UI después es deliberado: ADR-022 prohíbe construir la consola con datos
 * simulados, y esto demuestra qué datos existen de verdad antes de dibujar nada.
 */
require('dotenv').config();
const Models = require('../app_core/models/conection');

/**
 * Las doce. El orden es el de ADR-022.
 *
 * Todas aceptan `:idNegocio` (o `NULL` para todos los negocios) y `:dias`.
 */
const PREGUNTAS = [
    {
        n: 1,
        pregunta: '¿Cuánto costó cada conversación?',
        // Subconsultas escalares y NO dos LEFT JOIN. Unir `turno` y `costo` en el mismo
        // GROUP BY produce el producto cartesiano de ambos: una conversación con 3 turnos y
        // 1 costo suma ese costo TRES veces. Un `count(DISTINCT ...)` arregla el conteo de
        // turnos y deja el dinero inflado, que es la mitad peor del bug — y el que factura.
        // Lo cazó `__tests__/intelligence/ledger.test.js`.
        sql: `
            SELECT c.id_conversacion,
                   c.canal,
                   (SELECT count(*) FROM intelligence.turno t
                     WHERE t.id_conversacion = c.id_conversacion)          AS turnos,
                   COALESCE((SELECT sum(co.costo_usd) FROM intelligence.costo co
                              WHERE co.id_conversacion = c.id_conversacion), 0)::numeric(14,8)
                                                                           AS costo_usd
              FROM intelligence.conversacion c
             WHERE (:idNegocio::integer IS NULL OR c.id_negocio = :idNegocio)
               AND c.creado_en > now() - (:dias || ' days')::interval
             ORDER BY costo_usd DESC;
        `,
    },
    {
        n: 2,
        pregunta: '¿Cuánto costó cada negocio? (el margen por inquilino)',
        // Mismo cuidado que en la 1: cada agregado en su propia subconsulta. Aquí el
        // cartesiano era conversaciones × costos, y el importe salía multiplicado por el
        // número de conversaciones del inquilino — el error crece justo con los clientes
        // que más usan el producto.
        sql: `
            SELECT n.id_negocio,
                   n.nombre,
                   (SELECT count(*) FROM intelligence.conversacion c
                     WHERE c.id_negocio = n.id_negocio
                       AND c.creado_en > now() - (:dias || ' days')::interval) AS conversaciones,
                   COALESCE((SELECT sum(co.costo_usd) FROM intelligence.costo co
                              WHERE co.id_negocio = n.id_negocio
                                AND co.creado_en > now() - (:dias || ' days')::interval), 0)::numeric(14,8)
                                                                               AS costo_usd
              FROM general.gener_negocio n
             WHERE (:idNegocio::integer IS NULL OR n.id_negocio = :idNegocio)
               AND EXISTS (SELECT 1 FROM intelligence.conversacion c
                            WHERE c.id_negocio = n.id_negocio
                              AND c.creado_en > now() - (:dias || ' days')::interval)
             ORDER BY costo_usd DESC;
        `,
    },
    {
        n: 3,
        pregunta: '¿Qué modelos se usaron y cuánto costó cada uno?',
        sql: `
            SELECT proveedor, modelo,
                   count(*)                                AS llamadas,
                   sum(costo_usd)::numeric(14,8)           AS costo_usd
              FROM intelligence.costo
             WHERE (:idNegocio::integer IS NULL OR id_negocio = :idNegocio)
               AND creado_en > now() - (:dias || ' days')::interval
             GROUP BY proveedor, modelo
             ORDER BY costo_usd DESC;
        `,
    },
    {
        n: 4,
        pregunta: '¿Cuántos tokens se consumieron, y qué proporción salió de caché?',
        sql: `
            SELECT COALESCE(sum(tokens_entrada), 0)          AS entrada,
                   COALESCE(sum(tokens_salida), 0)           AS salida,
                   COALESCE(sum(tokens_cache_lectura), 0)    AS cache_lectura,
                   COALESCE(sum(tokens_cache_escritura), 0)  AS cache_escritura,
                   -- La métrica que más dinero mueve (ADR-019). Sin las dos columnas de
                   -- caché en el esquema, esta pregunta no tendría respuesta posible.
                   CASE WHEN COALESCE(sum(tokens_entrada), 0) + COALESCE(sum(tokens_cache_lectura), 0) = 0
                        THEN NULL
                        ELSE round(
                            100.0 * sum(tokens_cache_lectura)
                            / (sum(tokens_entrada) + sum(tokens_cache_lectura)), 1)
                   END                                       AS pct_acierto_cache
              FROM intelligence.costo
             WHERE (:idNegocio::integer IS NULL OR id_negocio = :idNegocio)
               AND creado_en > now() - (:dias || ' days')::interval;
        `,
    },
    {
        n: 5,
        pregunta: '¿Cuánto tarda un turno? (p50 / p95 / máximo)',
        sql: `
            SELECT nivel,
                   count(*)                                              AS turnos,
                   percentile_disc(0.5) WITHIN GROUP (ORDER BY latencia_ms) AS p50_ms,
                   percentile_disc(0.95) WITHIN GROUP (ORDER BY latencia_ms) AS p95_ms,
                   max(latencia_ms)                                      AS max_ms
              FROM intelligence.turno
             WHERE (:idNegocio::integer IS NULL OR id_negocio = :idNegocio)
               AND creado_en > now() - (:dias || ' days')::interval
               AND latencia_ms IS NOT NULL
             GROUP BY nivel;
        `,
    },
    {
        n: 6,
        pregunta: '¿Cuántas invocaciones de capacidad hubo, y cuántas por turno?',
        sql: `
            SELECT count(*)                                       AS invocaciones,
                   count(DISTINCT id_turno)                        AS turnos_con_invocacion,
                   round(count(*)::numeric / NULLIF(count(DISTINCT id_turno), 0), 2)
                                                                   AS por_turno
              FROM intelligence.invocacion_capacidad
             WHERE (:idNegocio::integer IS NULL OR id_negocio = :idNegocio)
               AND creado_en > now() - (:dias || ' days')::interval;
        `,
    },
    {
        n: 7,
        pregunta: '¿Qué capacidades se ejecutaron, y con qué éxito?',
        sql: `
            SELECT vertical, capacidad, resultado, count(*) AS veces
              FROM intelligence.invocacion_capacidad
             WHERE (:idNegocio::integer IS NULL OR id_negocio = :idNegocio)
               AND creado_en > now() - (:dias || ' days')::interval
             GROUP BY vertical, capacidad, resultado
             ORDER BY veces DESC;
        `,
    },
    {
        n: 8,
        pregunta: '¿Qué errores hubo y de qué tipo?',
        sql: `
            SELECT 'turno' AS origen, error_codigo, count(*) AS veces
              FROM intelligence.turno
             WHERE (:idNegocio::integer IS NULL OR id_negocio = :idNegocio)
               AND creado_en > now() - (:dias || ' days')::interval
               AND resultado = 'error'
             GROUP BY error_codigo
             UNION ALL
            SELECT 'capacidad', error_codigo, count(*)
              FROM intelligence.invocacion_capacidad
             WHERE (:idNegocio::integer IS NULL OR id_negocio = :idNegocio)
               AND creado_en > now() - (:dias || ' days')::interval
               AND resultado <> 'ok'
             GROUP BY error_codigo
             ORDER BY veces DESC;
        `,
    },
    {
        n: 9,
        pregunta: '¿Cuántos reintentos hubo? (turnos reprocesados y entregas repetidas)',
        sql: `
            SELECT (SELECT count(*) FROM intelligence.turno
                     WHERE (:idNegocio::integer IS NULL OR id_negocio = :idNegocio)
                       AND creado_en > now() - (:dias || ' days')::interval
                       AND intentos > 1)                      AS turnos_reintentados,
                   (SELECT COALESCE(sum(intentos_entrega - 1), 0) FROM intelligence.mensaje
                     WHERE (:idNegocio::integer IS NULL OR id_negocio = :idNegocio)
                       AND creado_en > now() - (:dias || ' days')::interval
                       AND direccion = 'saliente'
                       AND intentos_entrega > 1)              AS reintentos_de_entrega;
        `,
    },
    {
        n: 10,
        pregunta: '¿Qué conversaciones se quedaron rotas?',
        sql: `
            SELECT c.id_conversacion,
                   c.estado,
                   count(*) FILTER (WHERE t.resultado = 'error')            AS turnos_con_error,
                   count(*) FILTER (WHERE t.estado = 'procesando')          AS turnos_colgados,
                   max(t.creado_en)                                         AS ultimo_turno
              FROM intelligence.conversacion c
              JOIN intelligence.turno t ON t.id_conversacion = c.id_conversacion
             WHERE (:idNegocio::integer IS NULL OR c.id_negocio = :idNegocio)
               AND t.creado_en > now() - (:dias || ' days')::interval
             GROUP BY c.id_conversacion, c.estado
            HAVING count(*) FILTER (WHERE t.resultado = 'error') > 0
                OR count(*) FILTER (WHERE t.estado = 'procesando') > 0
             ORDER BY ultimo_turno DESC;
        `,
    },
    {
        n: 11,
        pregunta: '¿Qué proporción de turnos se resolvió sin ayuda humana?',
        sql: `
            SELECT count(*)                                                AS turnos,
                   count(*) FILTER (WHERE resultado = 'resuelto')          AS resueltos,
                   count(*) FILTER (WHERE resultado = 'handoff')           AS derivados,
                   count(*) FILTER (WHERE resultado = 'error')             AS con_error,
                   round(100.0 * count(*) FILTER (WHERE resultado = 'resuelto')
                         / NULLIF(count(*) FILTER (WHERE resultado IS NOT NULL), 0), 1)
                                                                           AS pct_resolucion
              FROM intelligence.turno
             WHERE (:idNegocio::integer IS NULL OR id_negocio = :idNegocio)
               AND creado_en > now() - (:dias || ' days')::interval;
        `,
    },
    {
        n: 12,
        pregunta: '¿Qué proporción resolvió el motor determinista y cuál necesitó IA?',
        sql: `
            SELECT nivel,
                   count(*)                                                AS turnos,
                   round(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1) AS pct
              FROM intelligence.turno
             WHERE (:idNegocio::integer IS NULL OR id_negocio = :idNegocio)
               AND creado_en > now() - (:dias || ' days')::interval
             GROUP BY nivel
             ORDER BY turnos DESC;
        `,
    },
];

async function responder(pregunta, { idNegocio = null, dias = 30 } = {}) {
    const [filas] = await Models.sequelize.query(pregunta.sql, {
        replacements: { idNegocio, dias: String(dias) },
        logging: false,
    });
    return filas;
}

async function main() {
    const argv = process.argv.slice(2);
    const opcion = (nombre) => {
        const i = argv.indexOf(`--${nombre}`);
        return i >= 0 ? argv[i + 1] : null;
    };
    const idNegocio = opcion('negocio') ? Number(opcion('negocio')) : null;
    const dias = Number(opcion('dias') || 30);

    console.log(
        `\nLedger — últimos ${dias} días · ${idNegocio ? `negocio ${idNegocio}` : 'todos los negocios'}\n`
    );

    for (const p of PREGUNTAS) {
        console.log(`\n${String(p.n).padStart(2)}. ${p.pregunta}`);
        const filas = await responder(p, { idNegocio, dias });
        if (filas.length === 0) {
            console.log('    (sin datos)');
        } else {
            console.table(filas);
        }
    }
    console.log();
}

if (require.main === module) {
    main()
        .catch((e) => {
            console.error('\n✗', e.message, '\n');
            process.exitCode = 1;
        })
        .finally(() => Models.sequelize.close());
}

module.exports = { PREGUNTAS, responder };
