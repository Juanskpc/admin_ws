/**
 * reporteExportService.js — El PDF y el Excel de los informes del restaurante.
 *
 * Existe aparte del exportador genérico (`app_parqueadero_api/services/reporteExportService`)
 * porque éste SÍ sabe qué es cada columna: con el tipo (`currency`, `number`, `date`) puede
 * poner los miles, alinear las cifras a la derecha y escribir las fechas en hora de Bogotá, en
 * vez de volcar el valor crudo. El genérico sigue sirviendo al parqueadero tal cual.
 *
 * Dependencias: exceljs, pdfkit (ya instaladas).
 */

'use strict';

const TZ = 'America/Bogota';

/** Azul índigo corporativo, el mismo del panel. */
const COLOR = {
    tinta: '#312E81',
    tintaClara: '#4F46E5',
    texto: '#1F2937',
    suave: '#6B7280',
    linea: '#E5E7EB',
    cebra: '#F7F7FB',
    panel: '#EEF0FB',
};

const ARGB = {
    tinta: 'FF312E81',
    panel: 'FFEEF0FB',
    cebra: 'FFF7F7FB',
    linea: 'FFE5E7EB',
    blanco: 'FFFFFFFF',
    texto: 'FF1F2937',
};

/** `$ 241.000` — punto para los miles, como se lee el dinero en Colombia. */
function formatoMoneda(valor) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return '$ 0';
    return '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n));
}

/** `1.234` — los conteos también llevan separador: 11 pedidos y 1.100 no se leen igual. */
function formatoNumero(valor) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return '0';
    return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(n);
}

/** `15/10/2026 10:11 p. m.` en hora de Bogotá, no el ISO crudo con la Z. */
function formatoFecha(valor) {
    if (valor == null || valor === '') return '';
    const d = valor instanceof Date ? valor : new Date(valor);
    if (Number.isNaN(d.getTime())) return String(valor);
    return d.toLocaleString('es-CO', {
        timeZone: TZ,
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
    });
}

/**
 * La fecha tal y como Excel debe enseñarla.
 *
 * Excel no guarda zona horaria: guarda un número de días desde 1900, y ExcelJS lo calcula
 * sobre el UTC del `Date`. Una venta de las 8 de la noche en Bogotá es la 1 de la madrugada
 * en UTC, así que pasar el `Date` tal cual corre todas las ventas cinco horas y cambia de día
 * las de la noche. Se construye un `Date` cuyo UTC YA ES la hora de pared de Bogotá.
 */
function fechaParaExcel(valor) {
    if (valor == null || valor === '') return null;
    const d = valor instanceof Date ? valor : new Date(valor);
    if (Number.isNaN(d.getTime())) return null;

    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(d).reduce((acc, parte) => {
        acc[parte.type] = parte.value;
        return acc;
    }, {});

    return new Date(Date.UTC(
        Number(partes.year), Number(partes.month) - 1, Number(partes.day),
        Number(partes.hour) % 24, Number(partes.minute), Number(partes.second),
    ));
}

/** El valor de una celda, ya en texto y según el tipo de su columna. */
function textoCelda(valor, tipo) {
    if (valor == null || valor === '') return tipo === 'currency' || tipo === 'number' ? '' : '';
    if (tipo === 'currency') return formatoMoneda(valor);
    if (tipo === 'number') return formatoNumero(valor);
    if (tipo === 'date') return formatoFecha(valor);
    return String(valor);
}

function esNumerica(tipo) {
    return tipo === 'currency' || tipo === 'number';
}

function buildFilename(slugNegocio, tipoReporte, ext) {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const slug = (slugNegocio || 'negocio').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const tipo = (tipoReporte || 'reporte').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return `${slug}_${tipo}_${ts}.${ext}`;
}

/**
 * Normaliza lo que llega del servicio a algo que los dos formatos puedan pintar igual.
 * `filas` queda con los valores CRUDOS: el Excel los necesita numéricos para poder sumarlos.
 */
function prepararDatos({ columnas = [], filas = [], resumenItems = [], desglosePago = [] }) {
    const cols = columnas.map((c) => ({
        key: c.key,
        label: c.label,
        tipo: c.type || 'text',
    }));
    const totalDesglose = desglosePago.reduce((acc, d) => acc + Number(d.total || 0), 0);
    return { cols, filas, resumenItems, desglosePago, totalDesglose };
}

// ═══════════════════════════════════════════════════════════════
// PDF
// ═══════════════════════════════════════════════════════════════

/**
 * El informe en PDF: cabecera, tarjetas de resumen, el reparto por forma de pago y la tabla.
 *
 * Va en horizontal: «Ventas por pedido» tiene ocho columnas y en vertical cada una quedaba en
 * 60 puntos, que es donde se partían los nombres y las fechas.
 */
async function generarPDFBuffer(opciones = {}) {
    const PDFDocument = require('pdfkit');
    const {
        slugNegocio, tipoReporte, titulo, nombreNegocio, periodo,
    } = opciones;
    const { cols, filas, resumenItems, desglosePago, totalDesglose } = prepararDatos(opciones);
    if (!filas.length) throw new Error('Sin datos para exportar');

    const filename = buildFilename(slugNegocio, tipoReporte, 'pdf');

    return new Promise((resolve, reject) => {
        // `bufferPages` para poder volver sobre las páginas al final y numerarlas: el total
        // no se sabe hasta que la tabla termina.
        const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape', bufferPages: true });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), filename }));
        doc.on('error', reject);

        const M = doc.page.margins.left;
        const ANCHO = doc.page.width - M * 2;
        const FONDO = doc.page.height - doc.page.margins.bottom;

        // ── Cabecera ──────────────────────────────────────────────
        doc.rect(M, M, ANCHO, 46).fill(COLOR.tinta);
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(16)
            .text(titulo || 'Informe', M + 14, M + 9, { width: ANCHO - 28, lineBreak: false });
        doc.font('Helvetica').fontSize(9).fillColor('#C7D2FE')
            .text(
                `${nombreNegocio || ''}${periodo ? `   ·   Del ${periodo.desde} al ${periodo.hasta}` : ''}`,
                M + 14, M + 29, { width: ANCHO - 28, lineBreak: false },
            );
        doc.font('Helvetica').fontSize(8).fillColor('#C7D2FE')
            .text(`Generado ${formatoFecha(new Date())}`, M, M + 30, {
                width: ANCHO - 14, align: 'right', lineBreak: false,
            });

        let y = M + 46 + 14;

        // ── Tarjetas del resumen ──────────────────────────────────
        if (resumenItems.length) {
            const porFila = Math.min(resumenItems.length, 4);
            const hueco = 10;
            const ancho = (ANCHO - hueco * (porFila - 1)) / porFila;
            const alto = 42;

            resumenItems.forEach((item, i) => {
                const fila = Math.floor(i / porFila);
                const col = i % porFila;
                const x = M + col * (ancho + hueco);
                const yy = y + fila * (alto + hueco);

                doc.roundedRect(x, yy, ancho, alto, 4).fillAndStroke(COLOR.panel, COLOR.linea);
                doc.fillColor(COLOR.suave).font('Helvetica').fontSize(7.5)
                    .text(String(item.label).toUpperCase(), x + 9, yy + 7, {
                        width: ancho - 18, lineBreak: false,
                    });
                doc.fillColor(COLOR.tinta).font('Helvetica-Bold').fontSize(13)
                    .text(textoCelda(item.value, item.type), x + 9, yy + 19, {
                        width: ancho - 18, lineBreak: false,
                    });
            });

            y += Math.ceil(resumenItems.length / porFila) * (alto + hueco) + 6;
        }

        // ── Ingresos por forma de pago ────────────────────────────
        if (desglosePago.length) {
            doc.fillColor(COLOR.texto).font('Helvetica-Bold').fontSize(10)
                .text('Ingresos por forma de pago', M, y);
            y += 16;

            const ALTO_F = 16;
            const anchoBarra = 120;
            const xValor = M + ANCHO - 110;
            const xPorc = M + ANCHO - 170;
            const xBarra = xPorc - anchoBarra - 14;

            desglosePago.forEach((d, i) => {
                if (i % 2 === 0) doc.rect(M, y - 3, ANCHO, ALTO_F).fill(COLOR.cebra);

                doc.fillColor(COLOR.texto).font('Helvetica').fontSize(8.5)
                    .text(`${d.metodo}  (${formatoNumero(d.ordenes)} pedidos)`, M + 8, y, {
                        width: xBarra - M - 16, lineBreak: false,
                    });

                const porc = Math.max(0, Math.min(100, Number(d.participacion) || 0));
                doc.rect(xBarra, y + 1, anchoBarra, 7).fill(COLOR.linea);
                if (porc > 0) doc.rect(xBarra, y + 1, (anchoBarra * porc) / 100, 7).fill(COLOR.tintaClara);

                doc.fillColor(COLOR.suave).font('Helvetica').fontSize(8)
                    .text(`${porc.toFixed(1)}%`, xPorc, y, { width: 46, align: 'right', lineBreak: false });
                doc.fillColor(COLOR.texto).font('Helvetica-Bold').fontSize(9)
                    .text(formatoMoneda(d.total), xValor, y, { width: 102, align: 'right', lineBreak: false });

                y += ALTO_F;
            });

            // El total: es la cifra que se viene a buscar, así que se marca.
            doc.moveTo(M, y + 1).lineTo(M + ANCHO, y + 1).lineWidth(0.8).stroke(COLOR.tinta);
            y += 6;
            doc.fillColor(COLOR.tinta).font('Helvetica-Bold').fontSize(9.5)
                .text('Total de ingresos', M + 8, y, { width: 240, lineBreak: false });
            doc.fillColor(COLOR.tinta).font('Helvetica-Bold').fontSize(11)
                .text(formatoMoneda(totalDesglose), xValor, y - 2, {
                    width: 102, align: 'right', lineBreak: false,
                });
            y += 22;
        }

        // ── Tabla ─────────────────────────────────────────────────
        // Las columnas de cifras no necesitan tanto sitio como las de nombres: se reparte el
        // ancho con pesos en vez de a partes iguales, que es lo que partía las fechas.
        const pesos = cols.map((c) => {
            if (c.tipo === 'date') return 1.5;
            if (esNumerica(c.tipo)) return 1;
            return 1.4;
        });
        const sumaPesos = pesos.reduce((a, b) => a + b, 0);
        const anchos = pesos.map((w) => (ANCHO * w) / sumaPesos);
        const xs = [];
        anchos.reduce((acc, w, i) => { xs[i] = M + acc; return acc + w; }, 0);

        const ALTO_H = 20;
        const ALTO_R = 16;

        const cabecera = () => {
            doc.rect(M, y, ANCHO, ALTO_H).fill(COLOR.tinta);
            cols.forEach((c, i) => {
                doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8)
                    .text(c.label, xs[i] + 6, y + 6, {
                        width: anchos[i] - 12,
                        align: esNumerica(c.tipo) ? 'right' : 'left',
                        lineBreak: false,
                    });
            });
            y += ALTO_H;
        };

        cabecera();

        filas.forEach((fila, idx) => {
            if (y + ALTO_R > FONDO - 20) {
                doc.addPage();
                y = M;
                cabecera();
            }
            if (idx % 2 === 1) doc.rect(M, y, ANCHO, ALTO_R).fill(COLOR.cebra);

            cols.forEach((c, i) => {
                const numerica = esNumerica(c.tipo);
                doc.fillColor(numerica ? COLOR.texto : COLOR.texto)
                    .font(numerica ? 'Helvetica-Bold' : 'Helvetica')
                    .fontSize(7.5)
                    .text(textoCelda(fila[c.key], c.tipo), xs[i] + 6, y + 4.5, {
                        width: anchos[i] - 12,
                        align: numerica ? 'right' : 'left',
                        lineBreak: false,
                        ellipsis: true,
                    });
            });
            y += ALTO_R;
        });

        // Fila de totales de las columnas de dinero: lo que suma la tabla que se está mirando.
        const sumables = cols.map((c, i) => (c.tipo === 'currency' ? i : -1)).filter((i) => i >= 0);
        if (sumables.length) {
            if (y + ALTO_R > FONDO - 20) { doc.addPage(); y = M; cabecera(); }
            doc.rect(M, y, ANCHO, ALTO_R + 2).fill(COLOR.panel);
            doc.fillColor(COLOR.tinta).font('Helvetica-Bold').fontSize(8)
                .text(`Total · ${formatoNumero(filas.length)} registros`, xs[0] + 6, y + 5, {
                    width: anchos[0] * 2, lineBreak: false,
                });
            sumables.forEach((i) => {
                const suma = filas.reduce((acc, f) => acc + (Number(f[cols[i].key]) || 0), 0);
                doc.fillColor(COLOR.tinta).font('Helvetica-Bold').fontSize(8)
                    .text(formatoMoneda(suma), xs[i] + 6, y + 5, {
                        width: anchos[i] - 12, align: 'right', lineBreak: false,
                    });
            });
            y += ALTO_R + 2;
        }

        // ── Numeración, al final para conocer el total de páginas ──
        const paginas = doc.bufferedPageRange();
        for (let i = 0; i < paginas.count; i++) {
            doc.switchToPage(paginas.start + i);
            doc.fillColor(COLOR.suave).font('Helvetica').fontSize(7.5)
                .text(
                    `EscalApp · ${nombreNegocio || ''} · Página ${i + 1} de ${paginas.count}`,
                    M, doc.page.height - doc.page.margins.bottom + 8,
                    { width: ANCHO, align: 'center', lineBreak: false },
                );
        }

        doc.end();
    });
}

// ═══════════════════════════════════════════════════════════════
// XLSX
// ═══════════════════════════════════════════════════════════════

const FMT_MONEDA = '"$" #,##0';
const FMT_NUMERO = '#,##0.##';
const FMT_FECHA = 'dd/mm/yyyy hh:mm AM/PM';

/**
 * El informe en Excel: una hoja «Resumen» con las cifras y el reparto por forma de pago, y
 * otra con el detalle.
 *
 * Las cifras van como NÚMERO con formato, no como texto: así el dueño puede sumarlas, filtrarlas
 * y hacerles una tabla dinámica, que es para lo que se baja un Excel y no un PDF.
 */
async function generarXLSXBuffer(opciones = {}) {
    const ExcelJS = require('exceljs');
    const { slugNegocio, tipoReporte, titulo, nombreNegocio, periodo } = opciones;
    const { cols, filas, resumenItems, desglosePago, totalDesglose } = prepararDatos(opciones);
    if (!filas.length) throw new Error('Sin datos para exportar');

    const filename = buildFilename(slugNegocio, tipoReporte, 'xlsx');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'EscalApp';
    workbook.created = new Date();

    const titulazo = (hoja, texto, ancho) => {
        const fila = hoja.addRow([texto]);
        hoja.mergeCells(fila.number, 1, fila.number, ancho);
        const celda = fila.getCell(1);
        celda.font = { bold: true, size: 13, color: { argb: ARGB.blanco } };
        celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB.tinta } };
        celda.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
        fila.height = 26;
        return fila;
    };

    // ── Hoja 1: Resumen ───────────────────────────────────────────
    const resumen = workbook.addWorksheet('Resumen', {
        views: [{ showGridLines: false }],
    });
    resumen.columns = [
        { width: 34 }, { width: 18 }, { width: 14 }, { width: 16 },
    ];

    titulazo(resumen, titulo || 'Informe', 4);
    resumen.addRow([nombreNegocio || '']).getCell(1).font = { bold: true, color: { argb: ARGB.texto } };
    if (periodo) resumen.addRow([`Del ${periodo.desde} al ${periodo.hasta}`]).getCell(1).font = { color: { argb: 'FF6B7280' } };
    resumen.addRow([`Generado ${formatoFecha(new Date())}`]).getCell(1).font = { color: { argb: 'FF6B7280' } };
    resumen.addRow([]);

    const cabeceraResumen = resumen.addRow(['Resumen del período', '', '', '']);
    cabeceraResumen.getCell(1).font = { bold: true, size: 11, color: { argb: ARGB.tinta } };
    resumenItems.forEach((item) => {
        const fila = resumen.addRow([item.label, item.value]);
        fila.getCell(1).font = { color: { argb: 'FF6B7280' } };
        const celda = fila.getCell(2);
        celda.font = { bold: true, color: { argb: ARGB.texto } };
        if (item.type === 'currency') celda.numFmt = FMT_MONEDA;
        else if (item.type === 'number') celda.numFmt = FMT_NUMERO;
        celda.alignment = { horizontal: item.type === 'text' ? 'left' : 'right' };
    });

    if (desglosePago.length) {
        resumen.addRow([]);
        const cab = resumen.addRow(['Ingresos por forma de pago', 'Valor', 'Pedidos', 'Participación']);
        cab.eachCell((celda) => {
            celda.font = { bold: true, color: { argb: ARGB.blanco } };
            celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB.tinta } };
            celda.alignment = { horizontal: 'center' };
        });

        desglosePago.forEach((d, i) => {
            const fila = resumen.addRow([
                d.metodo, Number(d.total) || 0, Number(d.ordenes) || 0,
                (Number(d.participacion) || 0) / 100,
            ]);
            fila.getCell(2).numFmt = FMT_MONEDA;
            fila.getCell(3).numFmt = FMT_NUMERO;
            fila.getCell(4).numFmt = '0.0%';
            if (i % 2 === 1) {
                fila.eachCell((celda) => {
                    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB.cebra } };
                });
            }
        });

        const total = resumen.addRow(['Total de ingresos', totalDesglose, '', 1]);
        total.getCell(2).numFmt = FMT_MONEDA;
        total.getCell(4).numFmt = '0.0%';
        total.eachCell((celda) => {
            celda.font = { bold: true, color: { argb: ARGB.tinta } };
            celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB.panel } };
        });
    }

    // ── Hoja 2: Detalle ───────────────────────────────────────────
    const detalle = workbook.addWorksheet('Detalle', {
        views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
    });

    detalle.columns = cols.map((c) => ({
        header: c.label,
        key: c.key,
        width: Math.max(String(c.label).length + 4, c.tipo === 'date' ? 22 : 16),
    }));

    const cabecera = detalle.getRow(1);
    cabecera.height = 22;
    cabecera.eachCell((celda) => {
        celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB.tinta } };
        celda.font = { color: { argb: ARGB.blanco }, bold: true };
        celda.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    filas.forEach((f, idx) => {
        const valores = {};
        cols.forEach((c) => {
            const bruto = f[c.key];
            if (c.tipo === 'currency' || c.tipo === 'number') {
                valores[c.key] = bruto == null || bruto === '' ? null : Number(bruto);
            } else if (c.tipo === 'date') {
                valores[c.key] = fechaParaExcel(bruto);
            } else {
                valores[c.key] = bruto ?? '';
            }
        });

        const fila = detalle.addRow(valores);
        cols.forEach((c, i) => {
            const celda = fila.getCell(i + 1);
            if (c.tipo === 'currency') celda.numFmt = FMT_MONEDA;
            else if (c.tipo === 'number') celda.numFmt = FMT_NUMERO;
            else if (c.tipo === 'date') celda.numFmt = FMT_FECHA;
            if (esNumerica(c.tipo)) celda.alignment = { horizontal: 'right' };
        });
        if (idx % 2 === 1) {
            fila.eachCell((celda) => {
                celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB.cebra } };
            });
        }
    });

    // Fila de totales: el Excel se abre y la suma ya está, sin seleccionar la columna.
    const indices = cols.map((c, i) => (c.tipo === 'currency' ? i + 1 : 0)).filter(Boolean);
    if (indices.length) {
        const fila = detalle.addRow([]);
        fila.getCell(1).value = `Total · ${filas.length} registros`;
        indices.forEach((i) => {
            const letra = detalle.getColumn(i).letter;
            fila.getCell(i).value = { formula: `SUM(${letra}2:${letra}${fila.number - 1})` };
            fila.getCell(i).numFmt = FMT_MONEDA;
            fila.getCell(i).alignment = { horizontal: 'right' };
        });
        fila.eachCell((celda) => {
            celda.font = { bold: true, color: { argb: ARGB.tinta } };
            celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB.panel } };
        });
    }

    detalle.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: cols.length },
    };

    const buffer = await workbook.xlsx.writeBuffer();
    return { buffer: Buffer.from(buffer), filename };
}

module.exports = {
    generarPDFBuffer,
    generarXLSXBuffer,
    buildFilename,
    formatoMoneda,
    formatoNumero,
    formatoFecha,
    fechaParaExcel,
};
