/**
 * reporteSchedulerService.js
 * CRUD y ejecución de reportes programados.
 *
 * Dependencias:
 *   npm install nodemailer
 */

'use strict';

/**
 * Mini-cron nativo — reemplaza node-cron sin dependencias externas.
 * Soporta expresiones de 5 campos: minuto hora dia_mes mes dia_semana
 * Cada campo acepta: *  [*]/n  n  n,m  n-m
 */
const cron = (() => {
  function parseField(field, min, max) {
    if (field === '*') return null;
    const values = new Set();
    for (const part of field.split(',')) {
      if (part.includes('/')) {
        const [range, step] = part.split('/');
        const s = parseInt(step, 10);
        const start = range === '*' ? min : parseInt(range, 10);
        for (let i = start; i <= max; i += s) values.add(i);
      } else if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(Number);
        for (let i = lo; i <= hi; i++) values.add(i);
      } else {
        values.add(parseInt(part, 10));
      }
    }
    return values;
  }

  function matches(expr, now) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [m, h, dom, mon, dow] = parts;
    const checks = [
      [parseField(m,   0, 59), now.getMinutes()],
      [parseField(h,   0, 23), now.getHours()],
      [parseField(dom, 1, 31), now.getDate()],
      [parseField(mon, 1, 12), now.getMonth() + 1],
      [parseField(dow, 0,  6), now.getDay()],
    ];
    return checks.every(([set, val]) => set === null || set.has(val));
  }

  return {
    validate(expr) {
      if (typeof expr !== 'string') return false;
      return expr.trim().split(/\s+/).length === 5;
    },
    schedule(expr, fn) {
      let lastMinute = -1;
      const id = setInterval(() => {
        const now = new Date();
        const minute = now.getFullYear() * 525600
          + now.getMonth() * 44640
          + now.getDate() * 1440
          + now.getHours() * 60
          + now.getMinutes();
        if (minute !== lastMinute && matches(expr, now)) {
          lastMinute = minute;
          try { fn(); } catch (e) { console.error('[scheduler] Error en tarea cron:', e.message); }
        }
      }, 30_000);
      return { stop() { clearInterval(id); } };
    },
  };
})();
const nodemailer   = require('nodemailer');
const reporteService = require('./reporteService');
const exportService  = require('./reporteExportService');
const { pool }     = require('../../app_core/models/conection');

const TZ = 'America/Bogota';

/** Mapa en memoria de tareas cron activas: { scheduleId → task } */
const tareasActivas = new Map();

// ─────────────────────────────────────────────
// Nodemailer transporter
// ─────────────────────────────────────────────

function crearTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ─────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────

async function crearProgramacion({ idNegocio, nombre, tipoReporte, cronExpression, formato, emailDestinatarios, filtros, retentionDays, creadoPor }) {
  const sql = `
    INSERT INTO parqueadero.parq_reporte_programado
      (id_negocio, nombre, tipo_reporte, cron_expression, formato, email_destinatarios, filtros, retention_days, creado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
    RETURNING *;
  `;
  const { rows } = await pool.query(sql, [
    idNegocio, nombre, tipoReporte, cronExpression, formato,
    emailDestinatarios, JSON.stringify(filtros || {}), retentionDays || 30, creadoPor,
  ]);
  return rows[0];
}

async function listarProgramaciones(idNegocio) {
  const { rows } = await pool.query(
    `SELECT * FROM parqueadero.parq_reporte_programado WHERE id_negocio = $1 AND activo = TRUE ORDER BY fecha_creacion DESC`,
    [idNegocio],
  );
  return rows;
}

async function eliminarProgramacion(idProgramacion, idNegocio) {
  const { rowCount } = await pool.query(
    `UPDATE parqueadero.parq_reporte_programado SET activo = FALSE WHERE id_programacion = $1 AND id_negocio = $2`,
    [idProgramacion, idNegocio],
  );
  return rowCount > 0;
}

async function actualizarUltimoEnvio(idProgramacion, proximoEnvio) {
  await pool.query(
    `UPDATE parqueadero.parq_reporte_programado SET ultimo_envio = NOW(), proximo_envio = $2 WHERE id_programacion = $1`,
    [idProgramacion, proximoEnvio],
  );
}

async function registrarLog(idProgramacion, status, archivo, enviadoA, errorMsg = null) {
  await pool.query(
    `INSERT INTO parqueadero.parq_reporte_programado_log (id_programacion, status, archivo, enviado_a, error_msg) VALUES ($1,$2,$3,$4,$5)`,
    [idProgramacion, status, archivo, enviadoA, errorMsg],
  );
}

// ─────────────────────────────────────────────
// Ejecución de un reporte programado
// ─────────────────────────────────────────────

/**
 * Ejecuta un reporte programado: genera datos, exporta y envía email.
 * @param {object} programacion  Fila de parq_reporte_programado
 */
async function ejecutarProgramacion(programacion) {
  const { id_programacion, id_negocio, tipo_reporte, formato, email_destinatarios, filtros, nombre, retention_days } = programacion;

  try {
    // Rango: el día/semana/mes anterior según el tipo de reporte
    const hoy        = new Date();
    const fechaHasta = hoy.toISOString().slice(0, 10);
    const fechaDesde = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Generar datos
    const resultado = await reporteService.generarReporte({
      tipoReporte: tipo_reporte,
      idNegocio:   id_negocio,
      fechaDesde,
      fechaHasta,
      granularidad: 'daily',
      filtros:     filtros || {},
      formato:     'json',
    });

    const datos     = resultado.datos || [];
    const resumen   = await reporteService.getResumenPeriodo({ idNegocio: id_negocio, fechaDesde, fechaHasta });

    // Exportar al formato solicitado
    let exportResult;
    const exportOpts = { slugNegocio: `negocio_${id_negocio}`, tipoReporte: tipo_reporte };
    if (formato === 'csv')       exportResult = await exportService.generarCSV(datos, exportOpts);
    else if (formato === 'xlsx') exportResult = await exportService.generarXLSX(datos, exportOpts);
    else                         exportResult = await exportService.generarPDF(datos, { ...exportOpts, titulo: nombre, kpis: resumen });

    // Enviar email
    await enviarEmailReporte({
      destinatarios: email_destinatarios,
      asunto:        `[Escalapp] Reporte: ${nombre} — ${fechaDesde} al ${fechaHasta}`,
      kpis:          resumen,
      nombreReporte: nombre,
      periodo:       `${fechaDesde} al ${fechaHasta}`,
      adjunto:       exportResult,
      formato,
    });

    await registrarLog(id_programacion, 'success', exportResult.filename, email_destinatarios);
    await actualizarUltimoEnvio(id_programacion, null);

    // Limpiar archivos vencidos
    await exportService.limpiarArchivosVencidos(retention_days || 30);

  } catch (err) {
    console.error(`[reporteScheduler] Error ejecutando programación ${id_programacion}:`, err.message);
    await registrarLog(id_programacion, 'failed', null, email_destinatarios, err.message);
  }
}

// ─────────────────────────────────────────────
// Email
// ─────────────────────────────────────────────

async function enviarEmailReporte({ destinatarios, asunto, kpis, nombreReporte, periodo, adjunto, formato }) {
  const transporter = crearTransporter();

  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1E3A5F;padding:20px;border-radius:8px 8px 0 0;">
        <h2 style="color:#fff;margin:0;">📊 ${nombreReporte}</h2>
        <p style="color:#aac4e8;margin:4px 0 0;">Período: ${periodo}</p>
      </div>
      <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
        <h3 style="color:#1E3A5F;">Resumen del período</h3>
        <table style="width:100%;border-collapse:collapse;">
          ${Object.entries(kpis || {}).map(([k, v]) => `
            <tr>
              <td style="padding:8px;border-bottom:1px solid #eee;color:#666;">${k}</td>
              <td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">${v}</td>
            </tr>
          `).join('')}
        </table>
        <p style="color:#888;font-size:12px;margin-top:16px;">
          El archivo adjunto contiene el reporte completo en formato ${formato.toUpperCase()}.
        </p>
        <p style="color:#888;font-size:11px;">Este email fue enviado automáticamente por Escalapp.</p>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from:        `"Escalapp Reportes" <${process.env.SMTP_USER}>`,
    to:          destinatarios.join(', '),
    subject:     asunto,
    html:        htmlBody,
    attachments: adjunto ? [{ filename: adjunto.filename, path: adjunto.filePath }] : [],
  });
}

// ─────────────────────────────────────────────
// Inicio del scheduler
// ─────────────────────────────────────────────

/**
 * Carga todas las programaciones activas de la DB e inicia las tareas cron.
 * Llamar al iniciar el servidor.
 */
async function iniciarScheduler() {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM parqueadero.parq_reporte_programado WHERE activo = TRUE`,
    );
    for (const prog of rows) {
      registrarTareaCron(prog);
    }
    console.log(`[reporteScheduler] ${rows.length} tarea(s) cron cargada(s).`);
  } catch (err) {
    console.error('[reporteScheduler] Error al iniciar scheduler:', err.message);
  }
}

/**
 * Registra una tarea cron en memoria para una programación.
 * Si ya existe una tarea con ese id, la detiene primero.
 */
function registrarTareaCron(programacion) {
  const { id_programacion, cron_expression } = programacion;

  if (!cron.validate(cron_expression)) {
    console.warn(`[reporteScheduler] Cron inválido para programación ${id_programacion}: ${cron_expression}`);
    return;
  }

  if (tareasActivas.has(id_programacion)) {
    tareasActivas.get(id_programacion).stop();
  }

  const tarea = cron.schedule(cron_expression, () => ejecutarProgramacion(programacion), {
    timezone: TZ,
  });

  tareasActivas.set(id_programacion, tarea);
}

/**
 * Detiene y elimina una tarea cron de memoria.
 */
function detenerTareaCron(idProgramacion) {
  if (tareasActivas.has(idProgramacion)) {
    tareasActivas.get(idProgramacion).stop();
    tareasActivas.delete(idProgramacion);
  }
}

module.exports = {
  crearProgramacion,
  listarProgramaciones,
  eliminarProgramacion,
  iniciarScheduler,
  registrarTareaCron,
  detenerTareaCron,
  ejecutarProgramacion,
  validateCronExpression: (expr) => cron.validate(expr),
};
