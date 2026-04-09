/**
 * reporteExportService.test.js
 * Tests del servicio de exportación CSV / XLSX / PDF.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const exportService = require('../../app_parqueadero_api/services/reporteExportService');

const DATOS_MOCK = [
  { fecha: '2026-01-01', id_negocio: 5, total_ingresos: 450000, num_transacciones: 48, ticket_promedio: 9375 },
  { fecha: '2026-01-02', id_negocio: 5, total_ingresos: 512000, num_transacciones: 54, ticket_promedio: 9481 },
];

describe('exportService.generarCSV', () => {
  afterEach(() => {
    // Cleanup archivos generados en tests
    const files = fs.readdirSync(exportService.UPLOAD_DIR);
    files.filter(f => f.includes('test_negocio')).forEach(f => {
      try { fs.unlinkSync(path.join(exportService.UPLOAD_DIR, f)); } catch (_) {}
    });
  });

  it('genera un archivo CSV con cabeceras correctas', async () => {
    const { filePath, filename } = await exportService.generarCSV(DATOS_MOCK, {
      slugNegocio: 'test_negocio',
      tipoReporte: 'daily_revenue',
    });

    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    // La primera línea debe ser la cabecera
    const lines = content.split('\n');
    expect(lines[0]).toContain('fecha');
    expect(lines[0]).toContain('total_ingresos');
    expect(lines[0]).toContain('num_transacciones');
  });

  it('el CSV tiene BOM UTF-8 (para compatibilidad con Excel)', async () => {
    const { filePath } = await exportService.generarCSV(DATOS_MOCK, {
      slugNegocio: 'test_negocio',
      tipoReporte: 'daily_revenue',
    });

    const buffer = fs.readFileSync(filePath);
    // BOM = EF BB BF
    expect(buffer[0]).toBe(0xEF);
    expect(buffer[1]).toBe(0xBB);
    expect(buffer[2]).toBe(0xBF);
  });

  it('genera N+1 líneas (cabecera + datos)', async () => {
    const { filePath } = await exportService.generarCSV(DATOS_MOCK, {
      slugNegocio: 'test_negocio',
      tipoReporte: 'test',
    });

    const content = fs.readFileSync(filePath, 'utf8').trimEnd();
    const lines   = content.split('\n').filter(l => l.trim());
    expect(lines.length).toBe(DATOS_MOCK.length + 1); // cabecera + filas
  });

  it('lanza error cuando no hay datos', async () => {
    await expect(
      exportService.generarCSV([], { slugNegocio: 'test', tipoReporte: 'test' }),
    ).rejects.toThrow('Sin datos para exportar');
  });
});

describe('exportService.generarXLSX', () => {
  it('genera un archivo XLSX válido', async () => {
    const ExcelJS = require('exceljs');
    const { filePath } = await exportService.generarXLSX(DATOS_MOCK, {
      slugNegocio: 'test_negocio',
      tipoReporte: 'daily_revenue',
    });

    expect(fs.existsSync(filePath)).toBe(true);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];

    // Verificar cabeceras
    const cabeceras = [];
    ws.getRow(1).eachCell(cell => cabeceras.push(cell.value));
    expect(cabeceras).toContain('fecha');
    expect(cabeceras).toContain('total_ingresos');

    // Verificar número de filas de datos
    expect(ws.rowCount).toBe(DATOS_MOCK.length + 1); // cabecera + datos

    // Cleanup
    fs.unlinkSync(filePath);
  });
});

describe('exportService.buildFilename', () => {
  it('genera nombre con formato correcto', () => {
    const filename = exportService.buildFilename('parking_norte', 'daily_revenue', 'csv');
    expect(filename).toMatch(/^parking_norte_daily_revenue_\d{14}\.csv$/);
  });

  it('sanitiza caracteres especiales en slugNegocio', () => {
    const filename = exportService.buildFilename('Parking & Más!', 'test', 'xlsx');
    expect(filename).not.toContain('&');
    expect(filename).not.toContain('!');
  });
});

describe('exportService.limpiarArchivosVencidos', () => {
  it('elimina archivos más antiguos que retention_days', async () => {
    // Crear un archivo de prueba con fecha modificada antiguamente
    const fakeFile = path.join(exportService.UPLOAD_DIR, 'test_old_file.csv');
    fs.writeFileSync(fakeFile, 'test');
    // Backdating: 35 días atrás
    const oldTime = Date.now() - 35 * 24 * 60 * 60 * 1000;
    fs.utimesSync(fakeFile, oldTime / 1000, oldTime / 1000);

    const eliminados = await exportService.limpiarArchivosVencidos(30);
    expect(eliminados).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(fakeFile)).toBe(false);
  });
});
