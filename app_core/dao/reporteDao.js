/**
 * reporteDao.js
 * Acceso a datos para el módulo de reportes del parqueadero.
 * Usa el pool de pg directamente (consultas raw SQL) para máximo control
 * sobre la construcción de queries dinámicas y streaming de resultados.
 *
 * TIMEZONE: todos los timestamps se almacenan en UTC.
 *           Las conversiones a 'America/Bogota' se realizan DENTRO del SQL
 *           para garantizar agrupaciones correctas.
 */

const { pool } = require('../models/conection'); // ajustar si la exportación es diferente

const TZ = "America/Bogota";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Construye el truncado de fecha según granularidad.
 * @param {'hourly'|'daily'|'weekly'|'monthly'} granularidad
 * @param {string} columna  Expresión de columna timestamptz, ya convertida a tz local
 * @returns {string}
 */
function truncPorGranularidad(granularidad, columna) {
  const map = {
    hourly:  `date_trunc('hour',  ${columna})`,
    daily:   `date_trunc('day',   ${columna})`,
    weekly:  `date_trunc('week',  ${columna})`,
    monthly: `date_trunc('month', ${columna})`,
  };
  return map[granularidad] || map.daily;
}

/**
 * Expresión SQL para convertir un campo timestamptz a zona local.
 */
function toLocal(campo) {
  return `(${campo} AT TIME ZONE '${TZ}')`;
}

// ─────────────────────────────────────────────
// Consultas principales
// ─────────────────────────────────────────────

/**
 * R-01 / R-02: Ingresos agregados por granularidad.
 * @param {object} params
 * @param {number} params.idNegocio
 * @param {Date|string} params.fechaDesde
 * @param {Date|string} params.fechaHasta
 * @param {'hourly'|'daily'|'weekly'|'monthly'} params.granularidad
 * @returns {Promise<Array>}
 */
async function getIngresosAgregados({ idNegocio, fechaDesde, fechaHasta, granularidad = 'daily' }) {
  const localCol  = toLocal('f.fecha_cierre');
  const truncExpr = truncPorGranularidad(granularidad, localCol);

  const sql = `
    WITH base AS (
      SELECT
        ${truncExpr} AS periodo,
        COUNT(*)              AS num_transacciones,
        SUM(f.valor_total)    AS total_ingresos,
        AVG(f.valor_total)    AS ticket_promedio,
        AVG(
          EXTRACT(EPOCH FROM (f.fecha_cierre - f.fecha_entrada)) / 60.0
        )                     AS duracion_promedio_min
      FROM parqueadero.parq_factura f
      WHERE f.id_negocio = $1
        AND f.estado     = 'C'
        AND f.fecha_cierre >= ($2::date AT TIME ZONE '${TZ}')
        AND f.fecha_cierre <  (($3::date + 1) AT TIME ZONE '${TZ}')
      GROUP BY periodo
    )
    SELECT
      *,
      ROUND(
        (total_ingresos - LAG(total_ingresos) OVER (ORDER BY periodo))
        / NULLIF(LAG(total_ingresos) OVER (ORDER BY periodo), 0) * 100,
        2
      ) AS crecimiento_mom_pct
    FROM base
    ORDER BY periodo;
  `;

  const { rows } = await pool.query(sql, [idNegocio, fechaDesde, fechaHasta]);
  return rows;
}

/**
 * R-09: Transacciones paginadas con filtros opcionales.
 * @param {object} params
 * @returns {Promise<{ total: number, items: Array }>}
 */
async function getTransaccionesPaginadas({
  idNegocio,
  fechaDesde,
  fechaHasta,
  estadoFactura = null,
  placa = null,
  idTipoVehiculo = null,
  idUsuario = null,
  page = 1,
  pageSize = 50,
  sortCampo = 'fecha_cierre',
  sortDir = 'DESC',
}) {
  // Validar sort para evitar SQL injection
  const camposPermitidos = ['fecha_cierre', 'fecha_entrada', 'valor_total', 'placa', 'duracion_minutos'];
  const safeSort = camposPermitidos.includes(sortCampo) ? sortCampo : 'fecha_cierre';
  const safeDir  = sortDir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const offset   = (Math.max(1, page) - 1) * Math.min(pageSize, 500);
  const limit    = Math.min(pageSize, 500);

  const sqlData = `
    SELECT
      f.id_factura,
      f.numero_factura,
      f.placa,
      f.id_tipo_vehiculo,
      tv.nombre                                            AS nombre_tipo_vehiculo,
      ${toLocal('f.fecha_entrada')}                        AS fecha_entrada_local,
      ${toLocal('f.fecha_cierre')}                         AS fecha_cierre_local,
      ROUND(EXTRACT(EPOCH FROM (f.fecha_cierre - f.fecha_entrada)) / 60.0, 2)
                                                           AS duracion_minutos,
      f.valor_total,
      f.estado,
      f.tipo_cobro,
      f.id_negocio,
      u.nombre || ' ' || COALESCE(u.apellido, '')          AS nombre_cajero
    FROM parqueadero.parq_factura           f
    LEFT JOIN parqueadero.parq_tipo_vehiculo tv ON tv.id_tipo_vehiculo  = f.id_tipo_vehiculo
    LEFT JOIN parqueadero.parq_vehiculo      pv ON pv.id_vehiculo       = f.id_vehiculo
    LEFT JOIN general.gener_usuario          u  ON u.id_usuario         = pv.id_usuario_salida
    WHERE f.id_negocio = $1
      AND f.fecha_cierre >= ($2::date AT TIME ZONE '${TZ}')
      AND f.fecha_cierre <  (($3::date + 1) AT TIME ZONE '${TZ}')
      AND ($4::char IS NULL OR f.estado           = $4)
      AND ($5::text IS NULL OR f.placa ILIKE '%' || $5 || '%')
      AND ($6::int  IS NULL OR f.id_tipo_vehiculo  = $6)
      AND ($7::int  IS NULL OR pv.id_usuario_salida = $7)
    ORDER BY ${safeSort === 'duracion_minutos' ? 'EXTRACT(EPOCH FROM (f.fecha_cierre - f.fecha_entrada))' : 'f.' + safeSort} ${safeDir}
    LIMIT $8 OFFSET $9;
  `;

  const sqlCount = `
    SELECT COUNT(*) AS total
    FROM parqueadero.parq_factura f
    LEFT JOIN parqueadero.parq_vehiculo pv ON pv.id_vehiculo        = f.id_vehiculo
    LEFT JOIN general.gener_usuario     u  ON u.id_usuario          = pv.id_usuario_salida
    WHERE f.id_negocio = $1
      AND f.fecha_cierre >= ($2::date AT TIME ZONE '${TZ}')
      AND f.fecha_cierre <  (($3::date + 1) AT TIME ZONE '${TZ}')
      AND ($4::char IS NULL OR f.estado           = $4)
      AND ($5::text IS NULL OR f.placa ILIKE '%' || $5 || '%')
      AND ($6::int  IS NULL OR f.id_tipo_vehiculo  = $6)
      AND ($7::int  IS NULL OR pv.id_usuario_salida = $7);
  `;

  const args = [idNegocio, fechaDesde, fechaHasta, estadoFactura, placa, idTipoVehiculo, idUsuario];

  const [dataRes, countRes] = await Promise.all([
    pool.query(sqlData, [...args, limit, offset]),
    pool.query(sqlCount, args),
  ]);

  return {
    total: parseInt(countRes.rows[0].total, 10),
    items: dataRes.rows,
  };
}

/**
 * R-03: Ocupación y utilización.
 */
async function getOcupacion({ idNegocio, fechaDesde, fechaHasta, granularidad = 'daily', idTipoVehiculo = null }) {
  const localCol  = toLocal('v.fecha_entrada');
  const truncExpr = truncPorGranularidad(granularidad, localCol);

  const sql = `
    SELECT
      ${truncExpr}                                           AS periodo,
      COUNT(*)                                               AS entradas,
      COUNT(v.fecha_salida)                                  AS salidas,
      (
        SELECT COALESCE(SUM(c.espacios_total), 0)
        FROM parqueadero.parq_capacidad c
        WHERE c.id_negocio       = $1
          AND ($4::int IS NULL OR c.id_tipo_vehiculo = $4)
      )                                                      AS capacidad_total
    FROM parqueadero.parq_vehiculo v
    WHERE v.id_negocio = $1
      AND v.estado    != 'X'
      AND v.fecha_entrada >= ($2::date AT TIME ZONE '${TZ}')
      AND v.fecha_entrada <  (($3::date + 1) AT TIME ZONE '${TZ}')
      AND ($4::int IS NULL OR v.id_tipo_vehiculo = $4)
    GROUP BY periodo
    ORDER BY periodo;
  `;

  const { rows } = await pool.query(sql, [idNegocio, fechaDesde, fechaHasta, idTipoVehiculo]);
  return rows;
}

/**
 * R-04: Throughput (entradas/salidas por período).
 */
async function getThroughput({ idNegocio, fechaDesde, fechaHasta, granularidad = 'hourly' }) {
  const localCol  = toLocal('v.fecha_entrada');
  const truncExpr = truncPorGranularidad(granularidad, localCol);

  const sql = `
    SELECT
      ${truncExpr}               AS periodo,
      COUNT(*)                   AS entradas,
      COUNT(v.fecha_salida)      AS salidas,
      COUNT(*) - COUNT(v.fecha_salida) AS presentes_neto,
      AVG(
        CASE WHEN f.fecha_cierre IS NOT NULL
          THEN EXTRACT(EPOCH FROM (f.fecha_cierre - f.fecha_entrada))
          ELSE NULL
        END
      )                          AS tiempo_procesamiento_seg
    FROM parqueadero.parq_vehiculo   v
    LEFT JOIN parqueadero.parq_factura f ON f.id_vehiculo = v.id_vehiculo
    WHERE v.id_negocio = $1
      AND v.estado    != 'X'
      AND v.fecha_entrada >= ($2::date AT TIME ZONE '${TZ}')
      AND v.fecha_entrada <  (($3::date + 1) AT TIME ZONE '${TZ}')
    GROUP BY periodo
    ORDER BY periodo;
  `;

  const { rows } = await pool.query(sql, [idNegocio, fechaDesde, fechaHasta]);
  return rows;
}

/**
 * R-05: Duración promedio de estancia.
 */
async function getDuracionPromedio({ idNegocio, fechaDesde, fechaHasta }) {
  const sql = `
    SELECT
      ${toLocal('f.fecha_cierre')}::date                                AS periodo,
      AVG(EXTRACT(EPOCH FROM (f.fecha_cierre - f.fecha_entrada)) / 60.0)   AS duracion_promedio_min,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (f.fecha_cierre - f.fecha_entrada)) / 60.0
      )                                                                    AS duracion_mediana_min,
      PERCENTILE_CONT(0.9) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (f.fecha_cierre - f.fecha_entrada)) / 60.0
      )                                                                    AS duracion_p90_min,
      COUNT(*)                                                             AS muestras
    FROM parqueadero.parq_factura f
    WHERE f.id_negocio = $1
      AND f.estado     = 'C'
      AND f.fecha_cierre IS NOT NULL
      AND f.fecha_cierre >= ($2::date AT TIME ZONE '${TZ}')
      AND f.fecha_cierre <  (($3::date + 1) AT TIME ZONE '${TZ}')
    GROUP BY periodo
    ORDER BY periodo;
  `;

  // Desglose por tipo de vehículo
  const sqlPorTipo = `
    SELECT
      f.id_tipo_vehiculo,
      tv.nombre                                                            AS nombre_tipo,
      AVG(EXTRACT(EPOCH FROM (f.fecha_cierre - f.fecha_entrada)) / 60.0)  AS avg_min
    FROM parqueadero.parq_factura            f
    JOIN parqueadero.parq_tipo_vehiculo      tv ON tv.id_tipo_vehiculo = f.id_tipo_vehiculo
    WHERE f.id_negocio = $1
      AND f.estado     = 'C'
      AND f.fecha_cierre >= ($2::date AT TIME ZONE '${TZ}')
      AND f.fecha_cierre <  (($3::date + 1) AT TIME ZONE '${TZ}')
    GROUP BY f.id_tipo_vehiculo, tv.nombre
    ORDER BY f.id_tipo_vehiculo;
  `;

  const args = [idNegocio, fechaDesde, fechaHasta];
  const [resMain, resTipo] = await Promise.all([
    pool.query(sql, args),
    pool.query(sqlPorTipo, args),
  ]);

  return { series: resMain.rows, porTipoVehiculo: resTipo.rows };
}

/**
 * R-06: Horas pico históricas.
 */
async function getHorasPico({ idNegocio, fechaDesde, fechaHasta }) {
  const sql = `
    SELECT
      EXTRACT(HOUR FROM ${toLocal('v.fecha_entrada')})::integer AS hora_local,
      COUNT(*)                                                    AS total_entradas,
      ROUND(COUNT(*) * 1.0 / NULLIF(COUNT(DISTINCT
        ${toLocal('v.fecha_entrada')}::date
      ), 0), 2)                                                   AS promedio_entradas_por_dia,
      COUNT(v.fecha_salida)                                       AS total_salidas,
      ROUND(COUNT(v.fecha_salida) * 1.0 / NULLIF(COUNT(DISTINCT
        ${toLocal('v.fecha_entrada')}::date
      ), 0), 2)                                                   AS promedio_salidas_por_dia
    FROM parqueadero.parq_vehiculo v
    WHERE v.id_negocio = $1
      AND v.estado    != 'X'
      AND v.fecha_entrada >= ($2::date AT TIME ZONE '${TZ}')
      AND v.fecha_entrada <  (($3::date + 1) AT TIME ZONE '${TZ}')
    GROUP BY hora_local
    ORDER BY hora_local;
  `;

  const { rows } = await pool.query(sql, [idNegocio, fechaDesde, fechaHasta]);

  // Calcular top 3 horas
  const sorted = [...rows].sort(
    (a, b) => parseFloat(b.promedio_entradas_por_dia) - parseFloat(a.promedio_entradas_por_dia),
  );
  const top3 = sorted.slice(0, 3).map(r => r.hora_local);

  return { horas: rows, top3HorasPico: top3 };
}

/**
 * R-07: Distribución por tipo de vehículo.
 */
async function getDistribucionTipoVehiculo({ idNegocio, fechaDesde, fechaHasta }) {
  const sql = `
    SELECT
      f.id_tipo_vehiculo,
      tv.nombre                                                             AS nombre_tipo,
      COUNT(*)                                                              AS cantidad,
      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2)                   AS porcentaje,
      AVG(EXTRACT(EPOCH FROM (f.fecha_cierre - f.fecha_entrada)) / 60.0)   AS duracion_promedio_min,
      AVG(f.valor_total)                                                    AS ingreso_promedio
    FROM parqueadero.parq_factura            f
    JOIN parqueadero.parq_tipo_vehiculo      tv ON tv.id_tipo_vehiculo = f.id_tipo_vehiculo
    WHERE f.id_negocio = $1
      AND f.estado     = 'C'
      AND f.fecha_cierre >= ($2::date AT TIME ZONE '${TZ}')
      AND f.fecha_cierre <  (($3::date + 1) AT TIME ZONE '${TZ}')
    GROUP BY f.id_tipo_vehiculo, tv.nombre
    ORDER BY cantidad DESC;
  `;

  const { rows } = await pool.query(sql, [idNegocio, fechaDesde, fechaHasta]);
  return rows;
}

/**
 * R-08: Movimientos de caja agrupados por concepto/tipo.
 */
async function getMovimientosCaja({ idNegocio, fechaDesde, fechaHasta }) {
  const sql = `
    SELECT
      m.tipo,
      m.concepto,
      COUNT(*)          AS cantidad_movimientos,
      SUM(m.monto)      AS monto_total
    FROM parqueadero.parq_movimiento_caja  m
    JOIN parqueadero.parq_caja             c ON c.id_caja = m.id_caja
    WHERE c.id_negocio = $1
      AND m.fecha >= ($2::date AT TIME ZONE '${TZ}')
      AND m.fecha <  (($3::date + 1) AT TIME ZONE '${TZ}')
    GROUP BY m.tipo, m.concepto
    ORDER BY m.tipo, monto_total DESC;
  `;

  const { rows } = await pool.query(sql, [idNegocio, fechaDesde, fechaHasta]);
  return rows;
}

/**
 * R-10: Reconciliación de caja.
 */
async function getReconciliacionCaja({ idNegocio, idCaja }) {
  const sqlCaja = `
    SELECT
      c.id_caja,
      c.id_negocio,
      u.nombre || ' ' || COALESCE(u.apellido, '') AS nombre_cajero,
      ${toLocal('c.fecha_apertura')} AS fecha_apertura_local,
      ${toLocal('c.fecha_cierre')}   AS fecha_cierre_local,
      c.monto_apertura,
      c.monto_cierre,
      c.estado,
      SUM(CASE WHEN m.tipo = 'INGRESO' THEN m.monto ELSE 0 END) AS total_ingresos_caja,
      SUM(CASE WHEN m.tipo = 'EGRESO'  THEN m.monto ELSE 0 END) AS total_egresos_caja,
      c.monto_cierre - (
        c.monto_apertura
        + SUM(CASE WHEN m.tipo = 'INGRESO' THEN m.monto ELSE 0 END)
        - SUM(CASE WHEN m.tipo = 'EGRESO'  THEN m.monto ELSE 0 END)
      ) AS diferencia
    FROM parqueadero.parq_caja            c
    JOIN general.gener_usuario            u ON u.id_usuario = c.id_usuario
    LEFT JOIN parqueadero.parq_movimiento_caja m ON m.id_caja = c.id_caja
    WHERE c.id_negocio = $1
      AND c.id_caja    = $2
    GROUP BY c.id_caja, u.nombre, u.apellido;
  `;

  const sqlMovimientos = `
    SELECT
      m.id_movimiento,
      m.tipo,
      m.monto,
      m.concepto,
      ${toLocal('m.fecha')} AS fecha_local
    FROM parqueadero.parq_movimiento_caja m
    WHERE m.id_caja = $1
    ORDER BY m.fecha ASC;
  `;

  const [cajaRes, movsRes] = await Promise.all([
    pool.query(sqlCaja, [idNegocio, idCaja]),
    pool.query(sqlMovimientos, [idCaja]),
  ]);

  if (!cajaRes.rows.length) return null;
  return { ...cajaRes.rows[0], movimientos: movsRes.rows };
}

/**
 * R-11: Excepciones y anomalías (facturas y vehículos anulados).
 */
async function getAnomalias({ idNegocio, fechaDesde, fechaHasta }) {
  const sql = `
    SELECT
      'FACTURA_ANULADA'                         AS tipo_evento,
      f.id_factura                              AS id_referencia,
      'Factura anulada: ' || f.numero_factura   AS descripcion,
      ${toLocal('f.fecha_creacion')}            AS detectado_en,
      f.id_negocio,
      u.nombre || ' ' || COALESCE(u.apellido,'') AS usuario
    FROM parqueadero.parq_factura f
    LEFT JOIN general.gener_usuario u ON u.id_usuario = f.id_usuario_cierre
    WHERE f.id_negocio = $1
      AND f.estado     = 'X'
      AND f.fecha_creacion >= ($2::date AT TIME ZONE '${TZ}')
      AND f.fecha_creacion <  (($3::date + 1) AT TIME ZONE '${TZ}')

    UNION ALL

    SELECT
      'VEHICULO_ANULADO',
      v.id_vehiculo,
      'Vehículo anulado: ' || v.placa,
      ${toLocal('v.fecha_creacion')},
      v.id_negocio,
      u.nombre || ' ' || COALESCE(u.apellido,'')
    FROM parqueadero.parq_vehiculo v
    LEFT JOIN general.gener_usuario u ON u.id_usuario = v.id_usuario_entrada
    WHERE v.id_negocio = $1
      AND v.estado     = 'X'
      AND v.fecha_creacion >= ($2::date AT TIME ZONE '${TZ}')
      AND v.fecha_creacion <  (($3::date + 1) AT TIME ZONE '${TZ}')

    ORDER BY detectado_en DESC;
  `;

  const { rows } = await pool.query(sql, [idNegocio, fechaDesde, fechaHasta]);
  return rows;
}

/**
 * R-12: Historial por placa.
 */
async function getHistorialPorPlaca({ idNegocio, placa }) {
  const sql = `
    SELECT
      f.placa,
      f.id_negocio,
      COUNT(*)                           AS total_visitas,
      MIN(${toLocal('f.fecha_entrada')})::date AS primera_visita,
      MAX(${toLocal('f.fecha_cierre')})::date  AS ultima_visita,
      AVG(f.valor_total)                 AS gasto_promedio,
      SUM(f.valor_total)                 AS gasto_total,
      AVG(EXTRACT(EPOCH FROM (f.fecha_cierre - f.fecha_entrada)) / 60.0) AS duracion_promedio_min
    FROM parqueadero.parq_factura f
    WHERE f.id_negocio = $1
      AND f.estado     = 'C'
      AND f.placa      ILIKE $2
    GROUP BY f.placa, f.id_negocio;
  `;

  const { rows } = await pool.query(sql, [idNegocio, placa]);
  return rows[0] || null;
}

/**
 * Devuelve resumen de totales del período (para KPI cards).
 */
async function getResumenPeriodo({ idNegocio, fechaDesde, fechaHasta }) {
  const sql = `
    SELECT
      COUNT(*)                  AS total_transacciones,
      COALESCE(SUM(valor_total), 0)  AS total_ingresos,
      COALESCE(AVG(valor_total), 0)  AS ticket_promedio,
      COALESCE(AVG(
        EXTRACT(EPOCH FROM (fecha_cierre - fecha_entrada)) / 60.0
      ), 0)                     AS duracion_promedio_min
    FROM parqueadero.parq_factura
    WHERE id_negocio  = $1
      AND estado      = 'C'
      AND fecha_cierre >= ($2::date AT TIME ZONE '${TZ}')
      AND fecha_cierre <  (($3::date + 1) AT TIME ZONE '${TZ}');
  `;

  const { rows } = await pool.query(sql, [idNegocio, fechaDesde, fechaHasta]);
  return rows[0];
}

module.exports = {
  getIngresosAgregados,
  getTransaccionesPaginadas,
  getOcupacion,
  getThroughput,
  getDuracionPromedio,
  getHorasPico,
  getDistribucionTipoVehiculo,
  getMovimientosCaja,
  getReconciliacionCaja,
  getAnomalias,
  getHistorialPorPlaca,
  getResumenPeriodo,
};
