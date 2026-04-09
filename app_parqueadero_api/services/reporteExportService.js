/**
 * reporteExportService.js
 * Genera archivos en formato CSV, XLSX y PDF a partir de datasets de reportes.
 *
 * Dependencias:
 *   npm install exceljs pdfkit
 */

'use strict';

const path  = require('path');
const fs    = require('fs');

/**
 * Serializa un array de objetos a string CSV.
 * Implementación nativa — no requiere dependencias externas.
 */
function stringify(data, options = {}) {
  const { header = true, columns, delimiter = ',', bom = false, cast = {} } = options;
  const cols = columns || Object.keys(data[0] || {});

  const castValue = (val) => {
    if (val == null) return '';
    if (val instanceof Date) return cast.date ? cast.date(val) : val.toISOString();
    if (typeof val === 'number') return cast.number ? cast.number(val) : String(val);
    return String(val);
  };

  const escapeCell = (val) => {
    const str = castValue(val);
    return (str.includes(delimiter) || str.includes('"') || str.includes('\r') || str.includes('\n'))
      ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [];
  if (header) lines.push(cols.map(c => escapeCell(c)).join(delimiter));
  for (const row of data) {
    lines.push(cols.map(col => escapeCell(row[col])).join(delimiter));
  }
  const csv = lines.join('\n') + '\n';
  return bom ? '\uFEFF' + csv : csv;
}

// Directorio donde se guardan temporalmente los archivos generados
const UPLOAD_DIR = process.env.REPORTE_UPLOAD_DIR
  || path.join(__dirname, '..', '..', 'uploads', 'reportes');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Genera el nombre base del archivo.
 * Formato: {slugNegocio}_{tipoReporte}_{YYYYMMDDHHmmss}
 */
function buildFilename(slugNegocio, tipoReporte, ext) {
  const now   = new Date();
  const ts    = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const slug  = (slugNegocio || 'negocio').replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const tipo  = (tipoReporte || 'reporte').replace(/[^a-z0-9]/gi, '_').toLowerCase();
  return `${slug}_${tipo}_${ts}.${ext}`;
}

// ─────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────

/**
 * Genera un archivo CSV a partir de un array de objetos.
 * @param {object[]} datos
 * @param {object} opciones
 * @param {string} opciones.slugNegocio
 * @param {string} opciones.tipoReporte
 * @param {string[]} [opciones.columnas]  Si se omite, usa las claves del primer objeto.
 * @returns {Promise<{ filePath: string, filename: string }>}
 */
async function generarCSV(datos, opciones = {}) {
  const { slugNegocio, tipoReporte, columnas } = opciones;
  if (!datos || datos.length === 0) throw new Error('Sin datos para exportar');

  const cols     = columnas || Object.keys(datos[0]);
  const filename = buildFilename(slugNegocio, tipoReporte, 'csv');
  const filePath = path.join(UPLOAD_DIR, filename);

  const content = stringify(datos, {
    header: true,
    columns: cols,
    bom: true,         // BOM UTF-8 para Excel
    delimiter: ',',
    cast: {
      date: (v) => v instanceof Date ? v.toISOString() : String(v),
      number: (v) => String(v),
    },
  });

  await fs.promises.writeFile(filePath, content, 'utf8');
  return { filePath, filename };
}

// ─────────────────────────────────────────────
// XLSX
// ─────────────────────────────────────────────

/**
 * Genera un archivo XLSX con estilos básicos.
 * @param {object[]} datos
 * @param {object} opciones
 * @returns {Promise<{ filePath: string, filename: string }>}
 */
async function generarXLSX(datos, opciones = {}) {
  const ExcelJS  = require('exceljs');
  const { slugNegocio, tipoReporte, columnas, titulo } = opciones;
  if (!datos || datos.length === 0) throw new Error('Sin datos para exportar');

  const cols     = columnas || Object.keys(datos[0]);
  const filename = buildFilename(slugNegocio, tipoReporte, 'xlsx');
  const filePath = path.join(UPLOAD_DIR, filename);

  const workbook  = new ExcelJS.Workbook();
  workbook.creator = 'Escalapp';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(titulo || tipoReporte || 'Reporte');

  // Cabecera con estilo
  sheet.columns = cols.map(col => ({
    header: col,
    key:    col,
    width:  Math.max(col.length + 4, 15),
  }));

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: 'FF1E3A5F' },
    };
    cell.font  = { color: { argb: 'FFFFFFFF' }, bold: true };
    cell.alignment = { horizontal: 'center' };
  });

  // Datos
  datos.forEach(fila => sheet.addRow(fila));

  // Auto-fit (aproximado)
  sheet.columns.forEach(col => {
    let maxLen = col.header ? col.header.length : 10;
    col.eachCell({ includeEmpty: false }, cell => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 2, 60);
  });

  await workbook.xlsx.writeFile(filePath);
  return { filePath, filename };
}

// ─────────────────────────────────────────────
// PDF
// ─────────────────────────────────────────────

/**
 * Genera un PDF sencillo con tabla de datos usando pdfkit.
 * Para layouts más ricos, considerar puppeteer (HTML→PDF).
 * @param {object[]} datos
 * @param {object} opciones
 * @param {string} opciones.titulo
 * @param {string} opciones.slugNegocio
 * @param {string} opciones.tipoReporte
 * @param {string[]} [opciones.columnas]
 * @param {object} [opciones.kpis]  KPIs para el encabezado
 * @returns {Promise<{ filePath: string, filename: string }>}
 */
async function generarPDF(datos, opciones = {}) {
  const PDFDocument = require('pdfkit');
  const { slugNegocio, tipoReporte, titulo, columnas, kpis = {} } = opciones;
  if (!datos || datos.length === 0) throw new Error('Sin datos para exportar');

  const cols     = columnas || Object.keys(datos[0]);
  const filename = buildFilename(slugNegocio, tipoReporte, 'pdf');
  const filePath = path.join(UPLOAD_DIR, filename);

  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 40, size: 'A4' });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // ── Encabezado ──
    doc.fontSize(18).font('Helvetica-Bold')
       .text(titulo || 'Reporte Escalapp', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica')
       .text(`Generado: ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`, { align: 'right' });
    doc.moveDown(0.5);

    // ── KPI Cards ──
    if (Object.keys(kpis).length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').text('Resumen del período:');
      doc.fontSize(10).font('Helvetica');
      Object.entries(kpis).forEach(([k, v]) => {
        doc.text(`  ${k}: ${v}`);
      });
      doc.moveDown(0.5);
    }

    // ── Separador ──
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#1E3A5F');
    doc.moveDown(0.5);

    // ── Tabla ──
    const colWidth = Math.floor((555 - 40) / cols.length);
    let y = doc.y;
    const ROW_H = 18;
    const PAGE_H = doc.page.height - doc.page.margins.bottom;

    // Cabecera de tabla
    const dibujarCabecera = () => {
      doc.rect(40, y, 515, ROW_H).fill('#1E3A5F');
      cols.forEach((col, i) => {
        doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
           .text(col, 42 + i * colWidth, y + 4, { width: colWidth - 4, lineBreak: false });
      });
      doc.fillColor('black');
      y += ROW_H;
    };

    dibujarCabecera();

    datos.forEach((fila, idx) => {
      if (y + ROW_H > PAGE_H) {
        doc.addPage();
        y = 40;
        dibujarCabecera();
      }

      if (idx % 2 === 0) doc.rect(40, y, 515, ROW_H).fill('#F5F5F5');
      doc.fillColor('black');

      cols.forEach((col, i) => {
        const val = fila[col];
        const txt = val instanceof Date ? val.toLocaleString('es-CO', { timeZone: 'America/Bogota' })
                  : val !== null && val !== undefined ? String(val) : '';
        doc.fontSize(7).font('Helvetica')
           .text(txt, 42 + i * colWidth, y + 5, { width: colWidth - 4, lineBreak: false });
      });

      y += ROW_H;
    });

    // ── Pie de página ──
    doc.fontSize(8).font('Helvetica').fillColor('#666')
       .text(`Total registros: ${datos.length}`, 40, y + 10);

    doc.end();
    stream.on('finish', () => resolve({ filePath, filename }));
    stream.on('error', reject);
  });
}

// ─────────────────────────────────────────────
// Stream CSV (para exports grandes)
// ─────────────────────────────────────────────

/**
 * Genera headers HTTP para descarga directa y retorna el stream para piping.
 * Usar junto con QueryStream de pg.
 * @param {object} res  Express response
 * @param {string} filename
 * @param {string[]} columnas
 */
function iniciarStreamCSV(res, filename, columnas) {
  const { Transform } = require('stream');
  const { stringify: stringifyStream } = require('csv-stringify');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.write('\uFEFF'); // UTF-8 BOM

  const csvStream = stringifyStream({
    header: true,
    columns: columnas,
    bom: false,
  });

  csvStream.pipe(res);
  return csvStream;
}

// ─────────────────────────────────────────────
// Obtener ruta de archivo guardado
// ─────────────────────────────────────────────

function getFilePath(filename) {
  return path.join(UPLOAD_DIR, filename);
}

/**
 * Elimina archivos de reporte vencidos (llamar desde cron diario).
 * @param {number} retentionDays
 */
async function limpiarArchivosVencidos(retentionDays = 30) {
  const files = await fs.promises.readdir(UPLOAD_DIR);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let eliminados = 0;
  for (const file of files) {
    const fp   = path.join(UPLOAD_DIR, file);
    const stat = await fs.promises.stat(fp);
    if (stat.mtimeMs < cutoff) {
      await fs.promises.unlink(fp);
      eliminados++;
    }
  }
  return eliminados;
}

module.exports = {
  generarCSV,
  generarXLSX,
  generarPDF,
  iniciarStreamCSV,
  buildFilename,
  getFilePath,
  limpiarArchivosVencidos,
  UPLOAD_DIR,
};
