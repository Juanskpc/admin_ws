/**
 * Mide la calidad de los teléfonos de `restaurante` — prerequisito de F0.
 *
 * En `restaurante` no existe una tabla de clientes: el único teléfono de cliente
 * final es `pedid_orden.contacto_telefono`, capturado al tomar una orden. Esa
 * columna es la ÚNICA fuente real del backfill de `platform.persona_identificador`
 * (roadmap §6). Si su calidad es mala, la Ficha 360 nace coja y F0 debe reducirse.
 *
 * SOLO LECTURA Y SOLO AGREGADOS. No selecciona ni imprime ningún teléfono, nombre
 * ni dirección: únicamente conteos y porcentajes. Es deliberado — bajar PII de
 * clientes a una máquina de desarrollo tiene implicaciones de Ley 1581 (ADR-024).
 *
 * Ejecutar contra produccion (lectura):
 *   node scripts/medir_calidad_telefonos.js --env .env.produccion.bak
 *
 * Ejecutar contra local:
 *   node scripts/medir_calidad_telefonos.js
 */
const path = require('path');
const { Client } = require('pg');

const STATEMENT_TIMEOUT_MS = 60000;

function cargarEntorno() {
    const i = process.argv.indexOf('--env');
    const archivo = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : '.env';
    require('dotenv').config({ path: path.resolve(__dirname, '..', archivo) });
    return archivo;
}

/**
 * Normalización a número nacional colombiano de 10 dígitos:
 * quita todo lo que no sea dígito, y descarta prefijo país (57) o troncal (0).
 * Clasificación alineada con el formato E.164 que exige ADR-006 para
 * `persona_identificador`.
 */
const CTE_BASE = `
WITH base AS (
    SELECT
        o.id_negocio,
        o.tipo_pedido,
        o.fecha_creacion,
        NULLIF(regexp_replace(COALESCE(o.contacto_telefono, ''), '[^0-9]', '', 'g'), '') AS digitos,
        NULLIF(BTRIM(COALESCE(o.contacto_nombre, '')), '') AS nombre
    FROM restaurante.pedid_orden o
),
norm AS (
    SELECT
        b.*,
        CASE
            WHEN b.digitos IS NULL THEN NULL
            WHEN length(b.digitos) = 12 AND left(b.digitos, 2) = '57' THEN right(b.digitos, 10)
            WHEN length(b.digitos) = 11 AND left(b.digitos, 1) = '0'  THEN right(b.digitos, 10)
            ELSE b.digitos
        END AS nacional
    FROM base b
),
clasif AS (
    SELECT
        n.*,
        CASE
            WHEN n.nacional IS NULL                                    THEN 'sin_telefono'
            WHEN n.nacional ~ '^(.)\\1+$'                              THEN 'basura_digito_repetido'
            WHEN length(n.nacional) < 7                                THEN 'muy_corto'
            WHEN length(n.nacional) = 10 AND left(n.nacional, 1) = '3' THEN 'movil_valido'
            WHEN length(n.nacional) = 10 AND left(n.nacional, 1) = '6' THEN 'fijo_10d'
            WHEN length(n.nacional) = 7                                THEN 'fijo_legacy_7d'
            ELSE 'otro_invalido'
        END AS clase
    FROM norm n
)`;

const CONSULTAS = [
    {
        titulo: '1. Panorama de ordenes',
        sql: `${CTE_BASE}
        SELECT
            count(*)                                                   AS ordenes,
            count(DISTINCT id_negocio)                                 AS negocios,
            count(*) FILTER (WHERE digitos IS NOT NULL)                AS con_telefono,
            round(100.0 * count(*) FILTER (WHERE digitos IS NOT NULL)
                  / NULLIF(count(*), 0), 1)                            AS pct_con_telefono,
            count(*) FILTER (WHERE nombre IS NOT NULL)                 AS con_nombre,
            min(fecha_creacion)::date                                  AS primera,
            max(fecha_creacion)::date                                  AS ultima
        FROM clasif;`,
    },
    {
        titulo: '2. Cobertura de telefono por tipo de pedido',
        sql: `${CTE_BASE}
        SELECT
            tipo_pedido,
            count(*)                                                   AS ordenes,
            count(*) FILTER (WHERE digitos IS NOT NULL)                AS con_telefono,
            round(100.0 * count(*) FILTER (WHERE digitos IS NOT NULL)
                  / NULLIF(count(*), 0), 1)                            AS pct
        FROM clasif
        GROUP BY tipo_pedido
        ORDER BY ordenes DESC;`,
    },
    {
        titulo: '3. Calidad del dato capturado (solo ordenes con telefono)',
        sql: `${CTE_BASE}
        SELECT
            clase,
            count(*)                                                   AS ordenes,
            round(100.0 * count(*) / NULLIF(SUM(count(*)) OVER (), 0), 1) AS pct
        FROM clasif
        WHERE digitos IS NOT NULL
        GROUP BY clase
        ORDER BY ordenes DESC;`,
    },
    {
        titulo: '4. Personas potenciales (telefonos moviles distintos)',
        sql: `${CTE_BASE}
        SELECT
            count(DISTINCT nacional)                                   AS moviles_distintos,
            count(*)                                                   AS ordenes_con_movil,
            round(1.0 * count(*) / NULLIF(count(DISTINCT nacional), 0), 2) AS ordenes_por_persona
        FROM clasif
        WHERE clase = 'movil_valido';`,
    },
    {
        titulo: '5. Recurrencia: cuantas ordenes acumula cada movil',
        sql: `${CTE_BASE},
        por_tel AS (
            SELECT nacional, count(*) AS n
            FROM clasif WHERE clase = 'movil_valido'
            GROUP BY nacional
        )
        SELECT
            CASE WHEN n = 1 THEN 'a) 1 orden'
                 WHEN n BETWEEN 2 AND 3  THEN 'b) 2-3 ordenes'
                 WHEN n BETWEEN 4 AND 10 THEN 'c) 4-10 ordenes'
                 ELSE 'd) 11+ ordenes' END                             AS recurrencia,
            count(*)                                                   AS telefonos,
            round(100.0 * count(*) / NULLIF(SUM(count(*)) OVER (), 0), 1) AS pct
        FROM por_tel
        GROUP BY 1
        ORDER BY 1;`,
    },
    {
        titulo: '6. Misma persona en varios negocios (valida el modelo persona de 2 niveles)',
        sql: `${CTE_BASE},
        por_tel AS (
            SELECT nacional, count(DISTINCT id_negocio) AS negocios
            FROM clasif WHERE clase = 'movil_valido'
            GROUP BY nacional
        )
        SELECT
            negocios                                                   AS negocios_distintos,
            count(*)                                                   AS telefonos,
            round(100.0 * count(*) / NULLIF(SUM(count(*)) OVER (), 0), 2) AS pct
        FROM por_tel
        GROUP BY negocios
        ORDER BY negocios;`,
    },
    {
        titulo: '7. Concentracion por negocio (top 10 por moviles distintos)',
        sql: `${CTE_BASE}
        SELECT
            id_negocio,
            count(*)                                                   AS ordenes,
            count(DISTINCT nacional) FILTER (WHERE clase = 'movil_valido') AS moviles_distintos,
            round(100.0 * count(*) FILTER (WHERE clase = 'movil_valido')
                  / NULLIF(count(*), 0), 1)                            AS pct_ordenes_con_movil
        FROM clasif
        GROUP BY id_negocio
        ORDER BY moviles_distintos DESC NULLS LAST
        LIMIT 10;`,
    },
    {
        titulo: '8. Vigencia del dato (moviles distintos por antiguedad de su ultima orden)',
        sql: `${CTE_BASE},
        por_tel AS (
            SELECT nacional, max(fecha_creacion) AS ultima
            FROM clasif WHERE clase = 'movil_valido'
            GROUP BY nacional
        )
        SELECT
            CASE WHEN ultima >= now() - interval '90 days'  THEN 'a) ultimos 90 dias'
                 WHEN ultima >= now() - interval '365 days' THEN 'b) 90 dias - 1 anio'
                 ELSE 'c) mas de 1 anio' END                            AS antiguedad,
            count(*)                                                   AS telefonos,
            round(100.0 * count(*) / NULLIF(SUM(count(*)) OVER (), 0), 1) AS pct
        FROM por_tel
        GROUP BY 1
        ORDER BY 1;`,
    },
    {
        // Importa para persona_negocio.nombre_mostrado (ADR-006): el telefono vive en la
        // ORDEN, no en una entidad cliente, asi que el nombre puede variar entre ordenes
        // del mismo telefono. Si varia mucho, el backfill necesita una regla de eleccion.
        titulo: '9. Estabilidad del nombre asociado a cada movil',
        sql: `${CTE_BASE},
        por_tel AS (
            SELECT nacional, count(DISTINCT lower(BTRIM(nombre))) AS nombres
            FROM clasif WHERE clase = 'movil_valido'
            GROUP BY nacional
        )
        SELECT
            CASE WHEN nombres = 0 THEN 'a) sin nombre'
                 WHEN nombres = 1 THEN 'b) 1 nombre consistente'
                 WHEN nombres = 2 THEN 'c) 2 nombres distintos'
                 ELSE 'd) 3+ nombres distintos' END                    AS estabilidad,
            count(*)                                                   AS telefonos,
            round(100.0 * count(*) / NULLIF(SUM(count(*)) OVER (), 0), 1) AS pct
        FROM por_tel
        GROUP BY 1
        ORDER BY 1;`,
    },
    {
        // Verifica la premisa del roadmap: "backfill solo de restaurante porque
        // gym/parqueadero/tienda no tienen datos". Si dejo de ser cierto, F0 cambia.
        titulo: '10. Telefonos en las otras verticales (premisa del roadmap)',
        sql: `
        SELECT 'restaurante.pedid_orden'   AS origen, count(*) AS filas,
               count(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(contacto_telefono,'')),'') IS NOT NULL) AS con_telefono
          FROM restaurante.pedid_orden
        UNION ALL
        SELECT 'reserva.reserva_cita', count(*),
               count(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(cliente_telefono,'')),'') IS NOT NULL)
          FROM reserva.reserva_cita
        UNION ALL
        SELECT 'gym.gym_miembro', count(*),
               count(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(telefono,'')),'') IS NOT NULL)
          FROM gym.gym_miembro
        UNION ALL
        SELECT 'tienda.tienda_cliente', count(*),
               count(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(telefono,'')),'') IS NOT NULL)
          FROM tienda.tienda_cliente
        UNION ALL
        SELECT 'parqueadero.parq_abonado', count(*),
               count(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(telefono,'')),'') IS NOT NULL)
          FROM parqueadero.parq_abonado
        ORDER BY filas DESC;`,
    },
];

function imprimirTabla(filas) {
    if (!filas.length) {
        console.log('   (sin filas)');
        return;
    }
    const cols = Object.keys(filas[0]);
    const ancho = cols.map((c) =>
        Math.max(c.length, ...filas.map((f) => String(f[c] ?? '—').length))
    );
    console.log('   ' + cols.map((c, i) => c.padEnd(ancho[i])).join('  '));
    console.log('   ' + ancho.map((a) => '-'.repeat(a)).join('  '));
    for (const f of filas) {
        console.log('   ' + cols.map((c, i) => String(f[c] ?? '—').padEnd(ancho[i])).join('  '));
    }
}

async function main() {
    const archivo = cargarEntorno();
    const client = new Client({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        ssl: String(process.env.DB_SSL) === 'true' ? { rejectUnauthorized: false } : false,
        statement_timeout: STATEMENT_TIMEOUT_MS,
    });

    await client.connect();
    console.log(`\nCalidad de telefonos en restaurante.pedid_orden`);
    console.log(`Entorno: ${archivo}  →  ${process.env.DB_HOST}/${process.env.DB_NAME}`);
    console.log('Modo: transaccion de SOLO LECTURA, unicamente agregados.\n');

    try {
        // Garantia dura: dentro de esta transaccion Postgres rechaza cualquier escritura.
        await client.query('BEGIN TRANSACTION READ ONLY');
        for (const { titulo, sql } of CONSULTAS) {
            console.log(`\n${titulo}`);
            const { rows } = await client.query(sql);
            imprimirTabla(rows);
        }
        await client.query('COMMIT');
        console.log('');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('\nError en la medicion:', error.message);
        process.exitCode = 1;
    } finally {
        await client.end();
    }
}

main();
