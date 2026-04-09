/**
 * reporteWorker.js
 * Worker en memoria para generación asíncrona de reportes pesados.
 * No requiere Redis ni BullMQ — usa una cola FIFO en proceso.
 */

'use strict';

const { EventEmitter } = require('events');
const jwt              = require('jsonwebtoken');

const reporteService = require('../services/reporteService');
const exportService  = require('../services/reporteExportService');

const BASE_URL   = process.env.API_BASE_URL || 'http://localhost:3000';
const SIGNED_TTL = 60 * 60; // 1 hora en segundos
const CONCURRENCY = parseInt(process.env.REPORTE_WORKER_CONCURRENCY || '3', 10);

/** Estado en memoria de los jobs */
const jobsEstado = new Map();

// ── Cola en memoria ──
const _queue   = [];
let   _running = 0;
let   _seq     = 0;
const _emitter = new EventEmitter();

// ─────────────────────────────────────────────
// Procesador del job
// ─────────────────────────────────────────────

async function procesarJob(job) {
  const {
    tipoReporte,
    idNegocio,
    fechaDesde,
    fechaHasta,
    granularidad = 'daily',
    filtros = {},
    formato = 'csv',
    idUsuario,
    slugNegocio,
  } = job.data;

  console.log(`[reporteWorker] Procesando job ${job.id} — tipo: ${tipoReporte} formato: ${formato}`);
  jobsEstado.set(job.id, { status: 'running', startedAt: new Date().toISOString() });

  // 1. Obtener datos
  const resultado = await reporteService.generarReporte({
    tipoReporte, idNegocio, fechaDesde, fechaHasta, granularidad, filtros, formato: 'json', idUsuario,
  });
  const datos = resultado.datos || [];

  // 2. Exportar al formato solicitado
  const exportOpts = { slugNegocio: slugNegocio || `negocio_${idNegocio}`, tipoReporte };
  let exportResult;
  switch (formato) {
    case 'csv':  exportResult = await exportService.generarCSV(datos, exportOpts);  break;
    case 'xlsx': exportResult = await exportService.generarXLSX(datos, exportOpts); break;
    case 'pdf':  exportResult = await exportService.generarPDF(datos, { ...exportOpts, titulo: tipoReporte }); break;
    default:     throw new Error(`Formato no soportado: ${formato}`);
  }

  // 3. Generar URL de descarga firmada (JWT)
  const downloadToken = jwt.sign(
    { jobId: job.id, idNegocio, filename: exportResult.filename },
    process.env.JWT_SECRET,
    { expiresIn: SIGNED_TTL },
  );
  const downloadUrl = `${BASE_URL}/api/parqueadero/v1/reportes/${job.id}/descargar?token=${downloadToken}`;

  // 4. Guardar estado final
  const estado = {
    status:      'ready',
    filename:    exportResult.filename,
    filePath:    exportResult.filePath,
    downloadUrl,
    expiresAt:   new Date(Date.now() + SIGNED_TTL * 1000).toISOString(),
    rows:        datos.length,
    generatedAt: new Date().toISOString(),
    formato,
    idNegocio,
    tipoReporte,
  };

  jobsEstado.set(job.id, estado);
  console.log(`[reporteWorker] Job ${job.id} completado — ${datos.length} filas → ${exportResult.filename}`);
  return estado;
}

// ─────────────────────────────────────────────
// Motor de la cola
// ─────────────────────────────────────────────

function _dequeue() {
  if (_running >= CONCURRENCY || _queue.length === 0) return;
  _running++;
  const job = _queue.shift();
  procesarJob(job)
    .then(() => { _emitter.emit('completed', job); })
    .catch((err) => {
      jobsEstado.set(job.id, { status: 'failed', error: err.message });
      _emitter.emit('failed', job, err);
    })
    .finally(() => { _running--; _dequeue(); });
}

/**
 * Encola un job para procesamiento asíncrono en memoria.
 * Devuelve un objeto con el id del job (compatible con la API de BullMQ).
 */
function encolarJob(data) {
  const id = `inprc_${++_seq}_${Date.now()}`;
  const job = { id, data };
  jobsEstado.set(id, { status: 'waiting', enqueuedAt: new Date().toISOString() });
  _queue.push(job);
  setImmediate(_dequeue);
  return { id };
}

// ─────────────────────────────────────────────
// Iniciar worker
// ─────────────────────────────────────────────

function iniciarWorker() {
  _emitter.on('completed', (job) => {
    console.log(`[reporteWorker] ✓ Job ${job.id} completado.`);
  });
  _emitter.on('failed', (job, err) => {
    console.error(`[reporteWorker] ✗ Job ${job?.id} fallido:`, err.message);
  });
  console.log('[reporteWorker] Worker iniciado (in-process, sin Redis).');
}

/**
 * Obtiene el estado de un job por su ID.
 * @param {string} jobId
 */
function getEstadoJob(jobId) {
  return jobsEstado.get(jobId) || { status: 'not_found' };
}

// Auto-iniciar
iniciarWorker();

module.exports = { iniciarWorker, getEstadoJob, jobsEstado, encolarJob };
