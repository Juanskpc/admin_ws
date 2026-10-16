/**
 * reporteExportRestaurante.test.js
 *
 * El exportador propio del restaurante. Lo que se vigila es justo lo que estaba mal antes:
 * las cifras sin separador de miles, las fechas en ISO con la Z, y el Excel sin los ingresos
 * repartidos por forma de pago.
 */

'use strict';

const ExcelJS = require('exceljs');
const svc = require('../../app_restaurante_api/services/reporteExportService');

const COLUMNAS = [
    { key: 'numero_orden', label: 'Orden', type: 'text' },
    { key: 'fecha_pedido', label: 'Fecha pedido', type: 'date' },
    { key: 'tomo_pedido', label: 'Tomó el pedido', type: 'text' },
    { key: 'cobro', label: 'Cobró', type: 'text' },
    { key: 'total', label: 'Total', type: 'currency' },
];

// 15/10/2026 a las 8:00 p. m. en Bogotá es la 01:00 UTC del día 16: justo el caso que se
// cambiaba de día al escribirlo en el Excel.
const NOCHE_BOGOTA = new Date('2026-10-16T01:00:00.000Z');

const FILAS = [
    { numero_orden: 'ORD-0082', fecha_pedido: NOCHE_BOGOTA, tomo_pedido: 'Ana Torres', cobro: 'Juan Vela', total: 1250000 },
    { numero_orden: 'ORD-0081', fecha_pedido: NOCHE_BOGOTA, tomo_pedido: 'Ana Torres', cobro: 'Sin registro', total: 9000 },
];

const OPCIONES = {
    slugNegocio: 'test_negocio',
    tipoReporte: 'ventas_periodo',
    titulo: 'Ventas por pedido',
    nombreNegocio: 'Restaurante de prueba',
    periodo: { desde: '2026-09-16', hasta: '2026-10-15' },
    columnas: COLUMNAS,
    filas: FILAS,
    resumenItems: [
        { key: 'ventas_totales', label: 'Ventas totales', value: 1259000, type: 'currency' },
        { key: 'ordenes_cobradas', label: 'Ordenes cobradas', value: 2, type: 'number' },
    ],
    desglosePago: [
        { metodo: 'Efectivo', ordenes: 1, total: 1250000, participacion: 99.29 },
        { metodo: 'Transferencia', ordenes: 1, total: 9000, participacion: 0.71 },
    ],
};

describe('formato de las cifras', () => {
    it('separa los miles del dinero', () => {
        expect(svc.formatoMoneda(241000)).toBe('$ 241.000');
        expect(svc.formatoMoneda(21909.0909)).toBe('$ 21.909');
        expect(svc.formatoMoneda(0)).toBe('$ 0');
    });

    it('también los separa en los conteos', () => {
        expect(svc.formatoNumero(1100)).toBe('1.100');
    });

    it('escribe las fechas en hora de Bogotá, no en ISO', () => {
        const texto = svc.formatoFecha(NOCHE_BOGOTA);
        expect(texto).toContain('15/10/2026');
        expect(texto).not.toContain('Z');
        expect(texto).not.toContain('T');
    });

    it('la fecha que va al Excel lleva la hora de pared de Bogotá en su UTC', () => {
        // Excel no guarda zona: el día y la hora que se ven son los del UTC del Date.
        const d = svc.fechaParaExcel(NOCHE_BOGOTA);
        expect(d.getUTCDate()).toBe(15);
        expect(d.getUTCHours()).toBe(20);
    });
});

describe('generarXLSXBuffer', () => {
    let wb;

    beforeAll(async () => {
        const { buffer } = await svc.generarXLSXBuffer(OPCIONES);
        wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer);
    });

    it('trae una hoja de resumen y otra de detalle', () => {
        expect(wb.worksheets.map((w) => w.name)).toEqual(['Resumen', 'Detalle']);
    });

    it('el resumen reparte los ingresos por forma de pago y los cuadra con el total', () => {
        const hoja = wb.getWorksheet('Resumen');
        const textos = [];
        hoja.eachRow((fila) => textos.push(fila.values.slice(1)));
        const plano = JSON.stringify(textos);

        expect(plano).toContain('Ingresos por forma de pago');
        expect(plano).toContain('Efectivo');
        expect(plano).toContain('Transferencia');

        const total = textos.find((f) => f[0] === 'Total de ingresos');
        expect(total[1]).toBe(1259000);
    });

    it('las cifras van como número con formato, para poder sumarlas en Excel', () => {
        const hoja = wb.getWorksheet('Detalle');
        const celda = hoja.getRow(2).getCell(5);
        expect(typeof celda.value).toBe('number');
        expect(celda.value).toBe(1250000);
        expect(celda.numFmt).toContain('#,##0');
    });

    it('la fila de totales suma la columna de dinero con una fórmula', () => {
        const hoja = wb.getWorksheet('Detalle');
        const ultima = hoja.getRow(hoja.rowCount);
        expect(String(ultima.getCell(1).value)).toContain('2 registros');
        expect(ultima.getCell(5).value.formula).toBe('SUM(E2:E3)');
    });
});

describe('generarPDFBuffer', () => {
    it('produce un PDF con contenido', async () => {
        const { buffer, filename } = await svc.generarPDFBuffer(OPCIONES);
        expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(buffer.length).toBeGreaterThan(1000);
        expect(filename).toMatch(/^test_negocio_ventas_periodo_\d{14}\.pdf$/);
    });

    it('se niega a exportar un informe sin filas', async () => {
        await expect(svc.generarPDFBuffer({ ...OPCIONES, filas: [] }))
            .rejects.toThrow('Sin datos para exportar');
    });
});
