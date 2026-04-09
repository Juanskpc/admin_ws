/**
 * reporteController.js
 * Controladores HTTP para el módulo de reportes del parqueadero.
 * Todos los endpoints requieren JWT válido (middleware verificarToken).
 * La autorización de rol/tenant se delega al middleware requireReportePermission.
 */

'use strict';

const { validationResult } = require('express-validator');
const Respuesta             = require('../../app_core/helpers/respuesta');
const reporteService        = require('../services/reporteService');
const exportService         = require('../services/reporteExportService');
const schedulerService      = require('../services/reporteSchedulerService');
const { getEstadoJob, jobsEstado } = require('../workers/reporteWorker');
const jwt                          = require('jsonwebtoken');

const BASE_URL          = process.env.API_BASE_URL || 'http://localhost:3000';
const PARQ_ROUTE_PREFIX = process.env.PARQ_ROUTE_PREFIX || '/parqueadero';
const SIGNED_TTL = 60 * 60; // 1 hora
const fs                    = require('fs');
const path                  = require('path');

// ─────────────────────────────────────────────
// Helper de validación
// ─────────────────────────────────────────────

function validar(req, res) {
  const errores = validationResult(req);
  if (!errores.isEmpty()) {
    Respuesta.error(res, 'Parámetros inválidos', 400, errores.array());
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────
// Helper de mensajes de error al cliente
// Evita exponer internos de la base de datos.
// Códigos PostgreSQL empiezan con dígito (p.ej. '42703').
// ─────────────────────────────────────────────
function clientMsg(err, fallback) {
  if (err?.code && /^\d/.test(String(err.code))) {
    return `${fallback} — error de base de datos (${err.code})`;
  }
  return err?.message || fallback;
}

function parseIntOpt(val) { return val ? parseInt(val, 10) : null; }

// ─────────────────────────────────────────────
// POST /reportes/generar
// ─────────────────────────────────────────────

async function generarReporte(req, res) {
  if (!validar(req, res)) return;
  try {
    const {
      tipo_reporte,
      id_negocio,
      fecha_desde,
      fecha_hasta,
      granularidad = 'daily',
      filtros      = {},
      formato      = 'json',
    } = req.body;

    const idNegocio   = parseInt(id_negocio, 10);
    const slugNegocio = req.usuario.slug_negocio || `negocio_${idNegocio}`;

    // ── Formatos de archivo: exportar sincrónicamente y registrar en jobsEstado ──
    if (formato !== 'json') {
      // 1. Obtener datos en JSON
      const datosResult = await reporteService.generarReporte({
        tipoReporte: tipo_reporte,
        idNegocio,
        fechaDesde:  fecha_desde,
        fechaHasta:  fecha_hasta,
        granularidad,
        filtros,
        formato: 'json',
        idUsuario: req.usuario.id_usuario,
        slugNegocio,
      });

      const datos      = datosResult.datos || [];
      const exportOpts = { slugNegocio, tipoReporte: tipo_reporte };

      // 2. Exportar al formato solicitado
      let exportResult;
      switch (formato) {
        case 'csv':  exportResult = await exportService.generarCSV(datos, exportOpts);  break;
        case 'xlsx': exportResult = await exportService.generarXLSX(datos, exportOpts); break;
        case 'pdf':  exportResult = await exportService.generarPDF(datos, { ...exportOpts, titulo: tipo_reporte }); break;
        default:     return Respuesta.error(res, `Formato no soportado: ${formato}`, 400);
      }

      // 3. Generar ID y URL de descarga firmada
      const jobKey      = `${Date.now()}_${idNegocio}`;
      const reporteId   = `rpt_${jobKey}`;
      const downloadToken = jwt.sign(
        { jobId: jobKey, idNegocio, filename: exportResult.filename },
        process.env.JWT_SECRET,
        { expiresIn: SIGNED_TTL },
      );
      const downloadUrl = `${BASE_URL}${PARQ_ROUTE_PREFIX}/reportes/${reporteId}/descargar?token=${downloadToken}`;

      // 4. Registrar en jobsEstado para que GET /reportes/:id lo encuentre
      jobsEstado.set(jobKey, {
        status:      'ready',
        filename:    exportResult.filename,
        filePath:    exportResult.filePath,
        downloadUrl,
        expiresAt:   new Date(Date.now() + SIGNED_TTL * 1000).toISOString(),
        rows:        datos.length,
        generatedAt: new Date().toISOString(),
        formato,
        idNegocio,
        tipoReporte: tipo_reporte,
      });

      return Respuesta.success(res, 'Reporte generado', {
        reporte_id:   reporteId,
        status:       'ready',
        rows:         datos.length,
        generated_at: new Date().toISOString(),
      });
    }

    // ── Formato JSON: flujo existente ──
    const resultado = await reporteService.generarReporte({
      tipoReporte:  tipo_reporte,
      idNegocio,
      fechaDesde:   fecha_desde,
      fechaHasta:   fecha_hasta,
      granularidad,
      filtros,
      formato,
      idUsuario:    req.usuario.id_usuario,
      slugNegocio,
    });

    return Respuesta.success(res,
      resultado.status === 'queued' ? 'Reporte encolado' : 'Reporte generado',
      {
        reporte_id:  resultado.reporteId,
        status:      resultado.status,
        rows:        resultado.datos ? resultado.datos.length : undefined,
        generated_at: resultado.status === 'ready' ? new Date().toISOString() : undefined,
        resultado:   resultado.status === 'ready' ? resultado.datos : undefined,
      },
    );
  } catch (err) {
    console.error('[reporteController] generarReporte:', err);
    return Respuesta.error(res, err.message || 'Error al generar reporte');
  }
}

// ─────────────────────────────────────────────
// GET /reportes/:reporteId
// ─────────────────────────────────────────────

async function getEstadoReporte(req, res) {
  try {
    const { reporteId } = req.params;
    // reporteId tiene formato rpt_{jobId}
    const jobId  = reporteId.replace(/^rpt_/, '');
    const estado = getEstadoJob(jobId);

    if (estado.status === 'not_found') {
      return Respuesta.error(res, 'Reporte no encontrado', 404);
    }

    return Respuesta.success(res, 'Estado del reporte', {
      reporte_id:   reporteId,
      status:       estado.status,
      download_url: estado.downloadUrl || undefined,
      expires_at:   estado.expiresAt   || undefined,
      meta: {
        rows:         estado.rows        || 0,
        generated_at: estado.generatedAt || null,
        formato:      estado.formato     || null,
      },
    });
  } catch (err) {
    console.error('[reporteController] getEstadoReporte | reporteId=%s |', req.params.reporteId, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al consultar estado del reporte'));
  }
}

// ─────────────────────────────────────────────
// GET /reportes/:reporteId/descargar
// ─────────────────────────────────────────────

async function descargarReporte(req, res) {
  try {
    const { reporteId } = req.params;
    const { token }     = req.query;

    if (!token) return Respuesta.error(res, 'Token de descarga requerido', 401);

    // Verificar token firmado
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_) {
      return Respuesta.error(res, 'Token de descarga inválido o expirado', 401);
    }

    const jobId  = reporteId.replace(/^rpt_/, '');
    if (String(payload.jobId) !== String(jobId)) {
      return Respuesta.error(res, 'Token no corresponde al reporte solicitado', 403);
    }

    const estado = getEstadoJob(jobId);
    if (!estado || estado.status !== 'ready') {
      return Respuesta.error(res, 'Reporte no disponible aún', 404);
    }

    const filePath = estado.filePath;
    if (!fs.existsSync(filePath)) {
      return Respuesta.error(res, 'Archivo de reporte no encontrado', 404);
    }

    res.download(filePath, estado.filename);
  } catch (err) {
    console.error('[reporteController] descargarReporte | reporteId=%s |', req.params.reporteId, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al descargar reporte'));
  }
}

// ─────────────────────────────────────────────
// GET /reportes/preview
// ─────────────────────────────────────────────

async function previewReporte(req, res) {
  if (!validar(req, res)) return;
  try {
    const { tipoReporte: tipoRep, idNegocio, fechaDesde, fechaHasta, granularidad = 'daily' } = req.query;

    const resultado = await reporteService.generarReporte({
      tipoReporte: tipoRep,
      idNegocio:   parseInt(idNegocio, 10),
      fechaDesde,
      fechaHasta,
      granularidad,
      filtros:     {},
      formato:     'json',
      idUsuario:   req.usuario.id_usuario,
    });

    const datos   = resultado.datos || [];
    const muestra = datos.slice(0, 20);

    return Respuesta.success(res, 'Preview generado', {
      filas_muestra:   muestra.length,
      total_estimado:  datos.length,
      columnas:        muestra.length > 0 ? Object.keys(muestra[0]) : [],
      datos:           muestra,
    });
  } catch (err) {
    console.error('[reporteController] previewReporte:', err);
    return Respuesta.error(res, err.message || 'Error al generar preview');
  }
}

// ─────────────────────────────────────────────
// GET /reportes/transacciones
// ─────────────────────────────────────────────

async function getTransacciones(req, res) {
  if (!validar(req, res)) return;
  try {
    const {
      idNegocio, fechaDesde, fechaHasta,
      estadoFactura, placa, idTipoVehiculo: idTipoVehQ, idUsuario: idUsuarioQ,
      page = 1, pageSize: pageSizeQ = 50, sort = 'fecha_cierre:DESC',
    } = req.query;

    const [sortCampo, sortDir] = sort.split(':');
    const pageSize  = Math.min(parseInt(pageSizeQ, 10) || 50, 500);

    const resultado = await reporteService.getTransacciones({
      idNegocio:      parseInt(idNegocio, 10),
      fechaDesde,
      fechaHasta,
      estadoFactura:  estadoFactura  || null,
      placa:          placa          || null,
      idTipoVehiculo: parseIntOpt(idTipoVehQ),
      idUsuario:      parseIntOpt(idUsuarioQ),
      page:           parseInt(page, 10) || 1,
      pageSize,
      sortCampo,
      sortDir,
    });

    return Respuesta.success(res, 'Transacciones obtenidas', {
      total:     resultado.total,
      page:      parseInt(page, 10),
      page_size: pageSize,
      pages:     Math.ceil(resultado.total / pageSize),
      items:     resultado.items,
    });
  } catch (err) {
    console.error('[reporteController] getTransacciones | idNegocio=%s fechaDesde=%s fechaHasta=%s |', req.query.idNegocio, req.query.fechaDesde, req.query.fechaHasta, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al obtener transacciones'));
  }
}

// ─────────────────────────────────────────────
// GET /reportes/ingresos/agregado
// ─────────────────────────────────────────────

async function getIngresosAgregado(req, res) {
  if (!validar(req, res)) return;
  try {
    const { idNegocio, fechaDesde, fechaHasta, granularidad = 'daily' } = req.query;

    const resultado = await reporteService.getIngresosAgregados({
      idNegocio:    parseInt(idNegocio, 10),
      fechaDesde,
      fechaHasta,
      granularidad,
    });

    return Respuesta.success(res, 'Ingresos agregados', resultado);
  } catch (err) {
    console.error('[reporteController] getIngresosAgregado | idNegocio=%s fechaDesde=%s fechaHasta=%s |', req.query.idNegocio, req.query.fechaDesde, req.query.fechaHasta, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al obtener ingresos'));
  }
}

// ─────────────────────────────────────────────
// GET /reportes/ocupacion
// ─────────────────────────────────────────────

async function getOcupacion(req, res) {
  if (!validar(req, res)) return;
  try {
    const { idNegocio, fechaDesde, fechaHasta, granularidad = 'daily', idTipoVehiculo: idTipoVehQ } = req.query;

    const datos = await reporteService.getOcupacion({
      idNegocio:      parseInt(idNegocio, 10),
      fechaDesde,
      fechaHasta,
      granularidad,
      idTipoVehiculo: parseIntOpt(idTipoVehQ),
    });

    return Respuesta.success(res, 'Ocupación obtenida', { serie: datos });
  } catch (err) {
    console.error('[reporteController] getOcupacion | idNegocio=%s fechaDesde=%s fechaHasta=%s |', req.query.idNegocio, req.query.fechaDesde, req.query.fechaHasta, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al obtener ocupación'));
  }
}

// ─────────────────────────────────────────────
// GET /reportes/horas-pico
// ─────────────────────────────────────────────

async function getHorasPico(req, res) {
  if (!validar(req, res)) return;
  try {
    const { idNegocio, fechaDesde, fechaHasta } = req.query;

    const resultado = await reporteService.getHorasPico({
      idNegocio:  parseInt(idNegocio, 10),
      fechaDesde,
      fechaHasta,
    });

    return Respuesta.success(res, 'Horas pico obtenidas', resultado);
  } catch (err) {
    console.error('[reporteController] getHorasPico | idNegocio=%s fechaDesde=%s fechaHasta=%s |', req.query.idNegocio, req.query.fechaDesde, req.query.fechaHasta, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al obtener horas pico'));
  }
}

// ─────────────────────────────────────────────
// GET /reportes/tipos-vehiculo
// ─────────────────────────────────────────────

async function getDistribucionTipos(req, res) {
  if (!validar(req, res)) return;
  try {
    const { idNegocio, fechaDesde, fechaHasta } = req.query;

    const datos = await reporteService.getDistribucionTipoVehiculo({
      idNegocio:  parseInt(idNegocio, 10),
      fechaDesde,
      fechaHasta,
    });

    return Respuesta.success(res, 'Distribución por tipo obtenida', datos);
  } catch (err) {
    console.error('[reporteController] getDistribucionTipos | idNegocio=%s fechaDesde=%s fechaHasta=%s |', req.query.idNegocio, req.query.fechaDesde, req.query.fechaHasta, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al obtener distribución de tipos'));
  }
}

// ─────────────────────────────────────────────
// GET /reportes/turno/:idCaja
// ─────────────────────────────────────────────

async function getReconciliacionCaja(req, res) {
  try {
    const idCaja    = parseInt(req.params.idCaja, 10);
    const idNegocio = parseInt(req.query.id_negocio, 10);

    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

    const datos = await reporteService.getReconciliacionCaja({ idNegocio, idCaja });
    if (!datos)  return Respuesta.error(res, 'Caja no encontrada', 404);

    return Respuesta.success(res, 'Reconciliación de caja obtenida', datos);
  } catch (err) {
    console.error('[reporteController] getReconciliacionCaja | idCaja=%s idNegocio=%s |', req.params.idCaja, req.query.id_negocio, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al obtener reconciliación de caja'));
  }
}

// ─────────────────────────────────────────────
// GET /reportes/anomalias
// ─────────────────────────────────────────────

async function getAnomalias(req, res) {
  if (!validar(req, res)) return;
  try {
    const { idNegocio, fechaDesde, fechaHasta } = req.query;

    const datos = await reporteService.getAnomalias({
      idNegocio:  parseInt(idNegocio, 10),
      fechaDesde,
      fechaHasta,
    });

    return Respuesta.success(res, 'Anomalías obtenidas', datos);
  } catch (err) {
    console.error('[reporteController] getAnomalias | idNegocio=%s fechaDesde=%s fechaHasta=%s |', req.query.idNegocio, req.query.fechaDesde, req.query.fechaHasta, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al obtener anomalías'));
  }
}

// ─────────────────────────────────────────────
// GET /reportes/resumen
// ─────────────────────────────────────────────

async function getResumenPeriodo(req, res) {
  if (!validar(req, res)) return;
  try {
    const { idNegocio, fechaDesde, fechaHasta } = req.query;

    const datos = await reporteService.getResumenPeriodo({
      idNegocio:  parseInt(idNegocio, 10),
      fechaDesde,
      fechaHasta,
    });

    return Respuesta.success(res, 'Resumen del período obtenido', datos);
  } catch (err) {
    console.error('[reporteController] getResumenPeriodo | idNegocio=%s fechaDesde=%s fechaHasta=%s |', req.query.idNegocio, req.query.fechaDesde, req.query.fechaHasta, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al obtener resumen del período'));
  }
}

// ─────────────────────────────────────────────
// Scheduled reports
// ─────────────────────────────────────────────

async function crearProgramacion(req, res) {
  if (!validar(req, res)) return;
  try {
    const {
      id_negocio, nombre, tipo_reporte, cron_expression,
      formato, email_destinatarios, filtros, retention_days,
    } = req.body;

    // Validar cron expression
    if (!schedulerService.validateCronExpression(cron_expression)) {
      return Respuesta.error(res, 'Expresión cron inválida', 400);
    }

    const programacion = await schedulerService.crearProgramacion({
      idNegocio:         parseInt(id_negocio, 10),
      nombre,
      tipoReporte:       tipo_reporte,
      cronExpression:    cron_expression,
      formato:           formato || 'pdf',
      emailDestinatarios: email_destinatarios,
      filtros:           filtros || {},
      retentionDays:     retention_days || 30,
      creadoPor:         req.usuario.id_usuario,
    });

    // Registrar la tarea cron en memoria
    schedulerService.registrarTareaCron(programacion);

    return Respuesta.success(res, 'Reporte programado creado', {
      schedule_id: programacion.id_programacion,
    }, 201);
  } catch (err) {
    console.error('[reporteController] crearProgramacion | idNegocio=%s nombre=%s |', req.body.id_negocio, req.body.nombre, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al crear programación'));
  }
}

async function listarProgramaciones(req, res) {
  try {
    const idNegocio = parseInt(req.query.id_negocio, 10);
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

    const lista = await schedulerService.listarProgramaciones(idNegocio);
    return Respuesta.success(res, 'Programaciones obtenidas', lista);
  } catch (err) {
    console.error('[reporteController] listarProgramaciones | idNegocio=%s |', req.query.id_negocio, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al listar programaciones'));
  }
}

async function eliminarProgramacion(req, res) {
  try {
    const idProgramacion = parseInt(req.params.scheduleId, 10);
    const idNegocio      = parseInt(req.query.id_negocio || req.body.id_negocio, 10);

    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

    const ok = await schedulerService.eliminarProgramacion(idProgramacion, idNegocio);
    if (!ok)   return Respuesta.error(res, 'Programación no encontrada', 404);

    schedulerService.detenerTareaCron(idProgramacion);
    return Respuesta.success(res, 'Reporte programado eliminado');
  } catch (err) {
    console.error('[reporteController] eliminarProgramacion | scheduleId=%s idNegocio=%s |', req.params.scheduleId, req.query.id_negocio || req.body.id_negocio, err.message, err);
    return Respuesta.error(res, clientMsg(err, 'Error al eliminar programación'));
  }
}

// ─────────────────────────────────────────────
// Exportar controladores
// ─────────────────────────────────────────────

module.exports = {
  generarReporte,
  getEstadoReporte,
  descargarReporte,
  previewReporte,
  getTransacciones,
  getIngresosAgregado,
  getOcupacion,
  getHorasPico,
  getDistribucionTipos,
  getReconciliacionCaja,
  getAnomalias,
  getResumenPeriodo,
  crearProgramacion,
  listarProgramaciones,
  eliminarProgramacion,
};
