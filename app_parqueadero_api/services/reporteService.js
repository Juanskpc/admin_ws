/**
 * reporteService.js
 * Capa de negocio para el módulo de reportes del parqueadero.
 * Orquesta DAO, caché Redis (si disponible) y encolamiento BullMQ.
 */

'use strict';

const reporteDao = require('../../app_core/dao/reporteDao');

// ── Cache (opcional — solo si REDIS_URL está configurado) ──
let redis = null;
if (process.env.REDIS_URL) {
  try {
    const ioredis = require('ioredis');
    redis = new ioredis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    redis.on('error', () => { redis = null; });
  } catch (_) {
    console.warn('[reporteService] Redis no disponible — caché deshabilitada.');
  }
} else {
  console.warn('[reporteService] Redis no configurado — caché deshabilitada.');
}

// ── Cola BullMQ (opcional — solo si REDIS_URL está configurado) ──
let reportQueue = null;
if (process.env.REDIS_URL) {
  try {
    const { Queue } = require('bullmq');
    reportQueue = new Queue('reportes', { connection: { url: process.env.REDIS_URL } });
    reportQueue.on('error', () => { reportQueue = null; });
  } catch (_) {
    console.warn('[reporteService] BullMQ no disponible — generación asíncrona deshabilitada.');
  }
} else {
  console.warn('[reporteService] BullMQ no configurado — generación asíncrona deshabilitada.');
}

/** TTL de caché en segundos */
const CACHE_TTL = 300;

/** Umbral de filas para pasar a procesamiento asíncrono */
const ASYNC_THRESHOLD_ROWS = 5000;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function buildCacheKey(tipo, idNegocio, params) {
  const suffix = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `rpt:${idNegocio}:${tipo}:${suffix}`;
}

async function fromCache(key) {
  if (!redis) return null;
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch (_) {
    return null;
  }
}

async function setCache(key, data) {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(data), 'EX', CACHE_TTL);
  } catch (_) { /* silencio */ }
}

/**
 * Invalida caché de un tenant al ocurrir eventos transaccionales.
 * Llamar desde el servicio de facturas al cerrar una factura.
 * @param {number} idNegocio
 */
async function invalidarCacheTenant(idNegocio) {
  if (!redis) return;
  try {
    const keys = await redis.keys(`rpt:${idNegocio}:*`);
    if (keys.length) await redis.del(...keys);
  } catch (_) { /* silencio */ }
}

// ─────────────────────────────────────────────
// Servicios de reportes
// ─────────────────────────────────────────────

/**
 * Genera o encola un reporte según tipo y parámetros.
 * @param {object} opciones
 * @param {string} opciones.tipoReporte
 * @param {number} opciones.idNegocio
 * @param {string} opciones.fechaDesde  YYYY-MM-DD
 * @param {string} opciones.fechaHasta  YYYY-MM-DD
 * @param {string} opciones.granularidad
 * @param {object} opciones.filtros
 * @param {'json'|'csv'|'xlsx'|'pdf'} opciones.formato
 * @param {number} opciones.idUsuario   Para auditoría
 * @returns {Promise<{ reporteId: string, status: 'ready'|'queued', datos?: any }>}
 */
async function generarReporte(opciones) {
  const {
    tipoReporte,
    idNegocio,
    fechaDesde,
    fechaHasta,
    granularidad = 'daily',
    filtros = {},
    formato = 'json',
    idUsuario,
  } = opciones;

  const cacheKey = buildCacheKey(tipoReporte, idNegocio, { fechaDesde, fechaHasta, granularidad, formato, ...filtros });
  const cached   = formato === 'json' ? await fromCache(cacheKey) : null;
  if (cached) return { reporteId: cached.reporteId, status: 'ready', datos: cached.datos };

  // Para formatos pesados o rangos grandes → encolar
  const esFormatoHeavy = ['pdf', 'xlsx'].includes(formato);
  if (esFormatoHeavy && reportQueue) {
    const job = await reportQueue.add('generar', { ...opciones, idUsuario });
    return {
      reporteId: `rpt_${job.id}`,
      status: 'queued',
      estimatedReadyAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    };
  }

  // Generación síncrona
  const datos = await ejecutarConsulta(tipoReporte, { idNegocio, fechaDesde, fechaHasta, granularidad, filtros });

  if (formato === 'json') {
    const reporteId = `rpt_${Date.now()}_${idNegocio}`;
    await setCache(cacheKey, { reporteId, datos });
    return { reporteId, status: 'ready', datos };
  }

  // Para CSV síncrono: encolar igualmente si hay demasiadas filas
  if (datos.length > ASYNC_THRESHOLD_ROWS && reportQueue) {
    const job = await reportQueue.add('generar', { ...opciones, idUsuario });
    return {
      reporteId: `rpt_${job.id}`,
      status: 'queued',
    };
  }

  return { reporteId: `rpt_${Date.now()}_${idNegocio}`, status: 'ready', datos };
}

/**
 * Delega al DAO correcto según tipo de reporte.
 */
async function ejecutarConsulta(tipoReporte, params) {
  const { idNegocio, fechaDesde, fechaHasta, granularidad, filtros = {} } = params;
  const base = { idNegocio, fechaDesde, fechaHasta };

  switch (tipoReporte) {
    case 'daily_revenue':
    case 'monthly_revenue':
      return reporteDao.getIngresosAgregados({ ...base, granularidad });

    case 'transactions':
      return (await reporteDao.getTransaccionesPaginadas({
        ...base,
        ...filtros,
        page: 1,
        pageSize: 500,
      })).items;

    case 'occupancy':
      return reporteDao.getOcupacion({ ...base, granularidad, ...filtros });

    case 'throughput':
      return reporteDao.getThroughput({ ...base, granularidad });

    case 'stay_duration':
      return (await reporteDao.getDuracionPromedio(base)).series;

    case 'peak_hours':
      return (await reporteDao.getHorasPico(base)).horas;

    case 'vehicle_type_mix':
      return reporteDao.getDistribucionTipoVehiculo(base);

    case 'payment_methods':
      return reporteDao.getMovimientosCaja(base);

    case 'anomalies':
      return reporteDao.getAnomalias(base);

    case 'plate_history':
      return [await reporteDao.getHistorialPorPlaca({ idNegocio, placa: filtros.placa })];

    default:
      throw new Error(`Tipo de reporte desconocido: ${tipoReporte}`);
  }
}

/**
 * Obtiene transacciones paginadas con filtros.
 */
async function getTransacciones(params) {
  return reporteDao.getTransaccionesPaginadas(params);
}

/**
 * Serie de ingresos para el gráfico de la UI.
 */
async function getIngresosAgregados(params) {
  const cacheKey = buildCacheKey('ingresos_agg', params.idNegocio, params);
  const cached   = await fromCache(cacheKey);
  if (cached) return cached;

  const serie = await reporteDao.getIngresosAgregados(params);
  // Calcular totales del período
  const totalPeriodo     = serie.reduce((s, r) => s + parseFloat(r.total_ingresos || 0), 0);
  const totalTxs         = serie.reduce((s, r) => s + parseInt(r.num_transacciones || 0, 10), 0);
  const ticketPromedio   = totalTxs > 0 ? totalPeriodo / totalTxs : 0;

  const result = {
    granularidad: params.granularidad,
    serie,
    totales: { total_periodo: totalPeriodo, transacciones_periodo: totalTxs, ticket_promedio: ticketPromedio },
  };

  await setCache(cacheKey, result);
  return result;
}

/**
 * Datos de ocupación.
 */
async function getOcupacion(params) {
  return reporteDao.getOcupacion(params);
}

/**
 * Datos de horas pico.
 */
async function getHorasPico(params) {
  const cacheKey = buildCacheKey('horas_pico', params.idNegocio, params);
  const cached   = await fromCache(cacheKey);
  if (cached) return cached;

  const result = await reporteDao.getHorasPico(params);
  await setCache(cacheKey, result);
  return result;
}

/**
 * Distribución por tipo de vehículo.
 */
async function getDistribucionTipoVehiculo(params) {
  return reporteDao.getDistribucionTipoVehiculo(params);
}

/**
 * Reconciliación de caja.
 */
async function getReconciliacionCaja(params) {
  return reporteDao.getReconciliacionCaja(params);
}

/**
 * Anomalías del período.
 */
async function getAnomalias(params) {
  return reporteDao.getAnomalias(params);
}

/**
 * Resumen KPIs del período.
 */
async function getResumenPeriodo(params) {
  const cacheKey = buildCacheKey('resumen', params.idNegocio, params);
  const cached   = await fromCache(cacheKey);
  if (cached) return cached;

  const result = await reporteDao.getResumenPeriodo(params);
  await setCache(cacheKey, result);
  return result;
}

module.exports = {
  generarReporte,
  getTransacciones,
  getIngresosAgregados,
  getOcupacion,
  getHorasPico,
  getDistribucionTipoVehiculo,
  getReconciliacionCaja,
  getAnomalias,
  getResumenPeriodo,
  invalidarCacheTenant,
};
