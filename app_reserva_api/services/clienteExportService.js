'use strict';
/**
 * La cartera de clientes en Excel o PDF.
 *
 * Dos formatos para dos usos distintos:
 *   - **Excel**: para trabajar los datos —filtrar, ordenar, cruzar con otra lista—. Por eso el
 *     teléfono va en E.164 (lo que acepta cualquier herramienta de WhatsApp o SMS), los importes
 *     como número con formato de moneda y las fechas como fecha de verdad, no como texto.
 *   - **PDF**: para imprimir o enviar. Menos columnas, teléfono legible y un total al pie.
 *
 * Las fechas se escriben en hora de Bogotá pase lo que pase con el TZ del proceso.
 */
const Models = require('../../app_core/models/conection');
const { infoPais, monedaDePais } = require('../../app_core/helpers/paises');

const AZUL = 'FF1E3A5F';

/**
 * El formato de celda de Excel para un importe, con el símbolo del país.
 *
 * Estaba clavado en `"$"#,##0`: la cartera de un negocio peruano salía en dólares y sin
 * céntimos. El símbolo y los decimales vienen de la misma tabla que decide la moneda en
 * pantalla, así que el archivo y la consola no pueden discrepar.
 */
function formatoMonedaExcel(m) {
    const decimales = m.decimales > 0 ? `.${'0'.repeat(m.decimales)}` : '';
    return `"${m.simbolo} "#,##0${decimales}`;
}

/** Partes de una fecha en hora de pared de Bogotá. */
function partesBogota(valor) {
    if (!valor) return null;
    const d = valor instanceof Date ? valor : new Date(valor);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).reduce((acc, x) => ({ ...acc, [x.type]: x.value }), {});
}

function fechaTexto(valor) {
    const p = partesBogota(valor);
    return p ? `${p.day}/${p.month}/${p.year}` : '';
}

function fechaHoraTexto(valor) {
    const p = partesBogota(valor);
    return p ? `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` : '';
}

/**
 * Fecha para una celda de Excel. ExcelJS guarda los `Date` en UTC, así que se construye uno cuyo
 * valor UTC *es* el día de Bogotá; de lo contrario una cita a las 8 p. m. aparecería al día
 * siguiente.
 */
function fechaExcel(valor) {
    const p = partesBogota(valor);
    return p ? new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))) : null;
}

/**
 * '+573001112233' → '300 111 2233'. Lo mismo que muestra la pantalla.
 *
 * El prefijo a quitar sale del país del negocio, no de un `+57` escrito aquí: con el primer
 * cliente chileno esta columna pasó a mostrar el número en crudo, con prefijo y todo, en la
 * única vista pensada para leerlo a ojo.
 */
function telefonoLegible(e164, pais = null) {
    const { telefono } = infoPais(pais);
    const conPrefijo = String(e164 || '');
    const prefijo = `+${telefono.cc}`;
    const nacional = conPrefijo.startsWith(prefijo) ? conPrefijo.slice(prefijo.length) : conPrefijo;
    if (nacional.length !== telefono.largo) return conPrefijo;
    // Diez dígitos se leen 3-3-4 (Colombia, México); nueve, 1-4-4 (Chile, Perú, Ecuador).
    return telefono.largo === 10
        ? `${nacional.slice(0, 3)} ${nacional.slice(3, 6)} ${nacional.slice(6)}`
        : `${nacional.slice(0, 1)} ${nacional.slice(1, 5)} ${nacional.slice(5)}`;
}

function moneda(valor, m) {
    return new Intl.NumberFormat(m.locale, {
        style: 'currency',
        currency: m.codigo,
        minimumFractionDigits: m.decimales,
        maximumFractionDigits: m.decimales,
    }).format(Number(valor || 0)).replace(/\s/g, ' ');
}

function slug(texto) {
    return String(texto || 'negocio')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

function nombreArchivo(nombreNegocio, ext) {
    const p = partesBogota(new Date());
    return `clientes_${slug(nombreNegocio)}_${p.year}${p.month}${p.day}.${ext}`;
}

function subtitulo(clientes, buscar) {
    const partes = [
        `${clientes.length} ${clientes.length === 1 ? 'cliente' : 'clientes'}`,
        `Generado ${fechaHoraTexto(new Date())}`,
    ];
    if (buscar) partes.push(`Búsqueda: «${buscar}»`);
    return partes.join(' · ');
}

// ─────────────────────────── Excel ───────────────────────────

/**
 * @param {object[]} clientes  Lo que devuelve `clienteService.listarParaExportar`.
 * @param {{ nombreNegocio: string, buscar?: string|null, pais?: string|null }} opciones
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
async function generarXLSX(clientes, { nombreNegocio, buscar = null, pais = null }) {
    const moneda_ = monedaDePais(pais);
    const ExcelJS = require('exceljs');

    const wb = new ExcelJS.Workbook();
    wb.creator = 'EscalApp';
    wb.created = new Date();

    const hoja = wb.addWorksheet('Clientes');
    const COLS = [
        { titulo: 'Nombre',        ancho: 30 },
        { titulo: 'Teléfono',      ancho: 16 },
        { titulo: 'Email',         ancho: 30 },
        { titulo: 'Citas',         ancho: 9 },
        { titulo: 'Completadas',   ancho: 13 },
        { titulo: 'Canceladas',    ancho: 12 },
        { titulo: 'No asistió',    ancho: 12 },
        { titulo: 'Total gastado', ancho: 16 },
        { titulo: 'Primera cita',  ancho: 14 },
        { titulo: 'Última cita',   ancho: 14 },
        { titulo: 'Cliente desde', ancho: 14 },
        { titulo: 'Notas',         ancho: 45 },
    ];
    hoja.columns = COLS.map((c) => ({ width: c.ancho }));

    const titulo = hoja.addRow([nombreNegocio]);
    hoja.mergeCells(titulo.number, 1, titulo.number, COLS.length);
    titulo.getCell(1).font = { bold: true, size: 15 };
    titulo.height = 22;

    const sub = hoja.addRow([`Listado de clientes · ${subtitulo(clientes, buscar)}`]);
    hoja.mergeCells(sub.number, 1, sub.number, COLS.length);
    sub.getCell(1).font = { size: 11, color: { argb: 'FF667085' } };

    hoja.addRow([]);

    const cab = hoja.addRow(COLS.map((c) => c.titulo));
    cab.eachCell((celda) => {
        celda.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
        celda.alignment = { vertical: 'middle' };
    });
    cab.height = 20;

    for (const c of clientes) {
        const fila = hoja.addRow([
            c.nombre || 'Sin nombre',
            c.telefono || '',
            c.email || '',
            c.total_citas,
            c.citas_completadas,
            c.citas_canceladas,
            c.inasistencias,
            Number(c.total_gastado || 0),
            fechaExcel(c.primera_cita),
            fechaExcel(c.ultima_cita),
            fechaExcel(c.creado_en),
            c.notas || '',
        ]);
        fila.getCell(8).numFmt = formatoMonedaExcel(moneda_);
        [9, 10, 11].forEach((n) => { fila.getCell(n).numFmt = 'dd/mm/yyyy'; });
        fila.getCell(12).alignment = { wrapText: true, vertical: 'top' };
    }

    if (clientes.length === 0) {
        hoja.addRow(['No hay clientes que coincidan.']);
    } else {
        // Filtros en la cabecera y cabecera fija al bajar: lo primero que haría quien lo abre.
        hoja.autoFilter = {
            from: { row: cab.number, column: 1 },
            to: { row: cab.number + clientes.length, column: COLS.length },
        };
    }
    hoja.views = [{ state: 'frozen', ySplit: cab.number }];

    const buffer = await wb.xlsx.writeBuffer();
    return { buffer: Buffer.from(buffer), filename: nombreArchivo(nombreNegocio, 'xlsx') };
}

// ─────────────────────────── PDF ───────────────────────────

/**
 * A4 apaisado: ocho columnas no caben en vertical sin encoger la letra hasta hacerla ilegible.
 *
 * @param {object[]} clientes
 * @param {{ nombreNegocio: string, buscar?: string|null, pais?: string|null }} opciones
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
function generarPDF(clientes, { nombreNegocio, buscar = null, pais = null }) {
    const PDFDocument = require('pdfkit');
    const moneda_ = monedaDePais(pais);

    const MARGEN = 36;
    const COLS = [
        { titulo: 'Nombre',        ancho: 170, valor: (c) => c.nombre || 'Sin nombre' },
        { titulo: 'Teléfono',      ancho: 85,  valor: (c) => telefonoLegible(c.telefono, pais) },
        { titulo: 'Email',         ancho: 170, valor: (c) => c.email || '—' },
        { titulo: 'Citas',         ancho: 45,  valor: (c) => String(c.total_citas), num: true },
        { titulo: 'No asistió',    ancho: 55,  valor: (c) => String(c.inasistencias), num: true },
        { titulo: 'Gastado',       ancho: 85,  valor: (c) => moneda(c.total_gastado, moneda_), num: true },
        { titulo: 'Última cita',   ancho: 80,  valor: (c) => fechaTexto(c.ultima_cita) || '—', num: true },
        { titulo: 'Cliente desde', ancho: 80,  valor: (c) => fechaTexto(c.primera_cita || c.creado_en), num: true },
    ];
    const ANCHO = COLS.reduce((s, c) => s + c.ancho, 0);
    const FILA_H = 18;
    const PAD = 4;

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4', layout: 'landscape', margin: MARGEN, bufferPages: true,
            info: { Title: `Clientes · ${nombreNegocio}`, Author: 'EscalApp' },
        });
        const chunks = [];
        doc.on('data', (ch) => chunks.push(ch));
        doc.on('end', () => resolve({
            buffer: Buffer.concat(chunks),
            filename: nombreArchivo(nombreNegocio, 'pdf'),
        }));
        doc.on('error', reject);

        const limiteY = () => doc.page.height - MARGEN - 20;

        doc.font('Helvetica-Bold').fontSize(16).fillColor('#101828').text(nombreNegocio, MARGEN, MARGEN);
        doc.font('Helvetica').fontSize(10).fillColor('#667085')
           .text(`Listado de clientes · ${subtitulo(clientes, buscar)}`);
        doc.moveDown(0.8);

        let y = doc.y;

        const celdas = (valores, { negrita = false, color = '#101828' } = {}) => {
            let x = MARGEN;
            COLS.forEach((col, i) => {
                doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(color)
                   .text(valores[i], x + PAD, y + 5, {
                       width: col.ancho - PAD * 2, height: FILA_H - 6,
                       lineBreak: false, ellipsis: true, align: col.num ? 'right' : 'left',
                   });
                x += col.ancho;
            });
        };

        const cabecera = () => {
            doc.rect(MARGEN, y, ANCHO, FILA_H).fill('#1E3A5F');
            celdas(COLS.map((c) => c.titulo), { negrita: true, color: '#FFFFFF' });
            y += FILA_H;
        };

        cabecera();

        if (clientes.length === 0) {
            doc.font('Helvetica').fontSize(9).fillColor('#667085')
               .text('No hay clientes que coincidan.', MARGEN + PAD, y + 6);
            y += FILA_H;
        }

        clientes.forEach((c, idx) => {
            if (y + FILA_H > limiteY()) {
                doc.addPage();
                y = MARGEN;
                cabecera();
            }
            if (idx % 2 === 0) doc.rect(MARGEN, y, ANCHO, FILA_H).fill('#F5F7FA');
            celdas(COLS.map((col) => col.valor(c)));
            y += FILA_H;
        });

        if (clientes.length > 0) {
            if (y + FILA_H > limiteY()) { doc.addPage(); y = MARGEN; }
            doc.moveTo(MARGEN, y).lineTo(MARGEN + ANCHO, y).lineWidth(0.8).stroke('#1E3A5F');
            const total = clientes.reduce((s, c) => s + Number(c.total_gastado || 0), 0);
            const citas = clientes.reduce((s, c) => s + Number(c.total_citas || 0), 0);
            const inas  = clientes.reduce((s, c) => s + Number(c.inasistencias || 0), 0);
            celdas(['TOTAL', '', '', String(citas), String(inas), moneda(total, moneda_), '', ''], { negrita: true });
        }

        // Numeración al pie. Se baja el margen inferior para que escribir ahí no abra otra página.
        const rango = doc.bufferedPageRange();
        for (let i = rango.start; i < rango.start + rango.count; i++) {
            doc.switchToPage(i);
            const margenInferior = doc.page.margins.bottom;
            doc.page.margins.bottom = 0;
            doc.font('Helvetica').fontSize(8).fillColor('#98A2B3')
               .text(`Página ${i + 1} de ${rango.count}`, MARGEN, doc.page.height - MARGEN + 8, {
                   width: ANCHO, align: 'right', lineBreak: false,
               });
            doc.page.margins.bottom = margenInferior;
        }

        doc.end();
    });
}

/**
 * Nombre y país del negocio: la cabecera del archivo y la moneda con la que se escriben sus
 * importes. Van juntos en una consulta porque se piden a la vez y son la misma fila.
 */
async function getNegocio(idNegocio) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['nombre', 'pais'],
    });
    return { nombreNegocio: negocio?.nombre || 'Negocio', pais: negocio?.pais || null };
}

module.exports = { generarXLSX, generarPDF, getNegocio, telefonoLegible };
