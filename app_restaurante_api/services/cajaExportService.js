/**
 * cajaExportService.js — el turno de caja en un archivo de Excel.
 *
 * No reutiliza `reporteExportService`: aquel genera una tabla plana (una cabecera y
 * N filas iguales) y este reporte son tres bloques distintos apilados —el resumen del
 * turno, el desglose por forma de pago con su total, y el listado de pedidos—. Forzar
 * eso en un generador de tabla plana sale peor que escribir la hoja aquí.
 *
 * Los importes van como NÚMERO con formato de moneda, no como texto: si van de texto,
 * quien reciba el archivo no puede sumar una columna, que es lo primero que hace todo
 * el mundo al abrir un reporte de caja.
 */
'use strict';

const Models = require('../../app_core/models/conection');

/** Azul de la cabecera, el mismo que usa el exportador de reportes. */
const AZUL = 'FF1E3A5F';
const GRIS = 'FFEFF2F6';
const FORMATO_MONEDA = '"$"#,##0';

/** dd/MM/yyyy HH:mm en hora de Bogotá, pase lo que pase con el TZ del proceso. */
function fechaHora(valor) {
    if (!valor) return '';
    const d = valor instanceof Date ? valor : new Date(valor);
    if (Number.isNaN(d.getTime())) return '';
    const p = new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).reduce((acc, x) => ({ ...acc, [x.type]: x.value }), {});
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

function slug(texto) {
    return String(texto || 'negocio')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

/** Etiqueta de la fila: distingue el cobro, el egreso y las dos caras de una anulación. */
function etiquetaTipo(m) {
    if (m.es_anulacion) return 'Anulación';
    if (m.anulado) return m.tipo === 'INGRESO' ? 'Ingreso anulado' : 'Egreso anulado';
    return m.tipo === 'INGRESO' ? 'Ingreso' : 'Egreso';
}

function etiquetaTipoPedido(m) {
    if (m.es_pago_domicilio) return 'Domicilio';
    const t = m.orden?.tipo_pedido;
    if (!t) return '';
    const mapa = { MESA: 'Mesa', LLEVAR: 'Para llevar', DOMICILIO: 'Domicilio' };
    return mapa[String(t).toUpperCase()] || t;
}

/** El concepto corto: si el movimiento viene de un pedido basta el número de orden. */
function concepto(m) {
    return m.orden?.numero_orden || m.concepto || '';
}

/**
 * Arma el libro de Excel de un turno.
 *
 * @param {object} caja        Lo que devuelve `cajaService.getCajaDetalle`.
 * @param {object[]} movimientos  Lo que devuelve `cajaService.getMovimientos`.
 * @param {string} nombreNegocio
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
async function generarXLSXCaja(caja, movimientos, nombreNegocio) {
    const ExcelJS = require('exceljs');

    const wb = new ExcelJS.Workbook();
    wb.creator = 'EscalApp';
    wb.created = new Date();

    const hoja = wb.addWorksheet(`Caja ${caja.id_caja}`);
    hoja.columns = [
        { width: 22 }, { width: 16 }, { width: 16 },
        { width: 26 }, { width: 24 }, { width: 16 },
    ];

    /** Escribe una fila de sección y devuelve su número. */
    const seccion = (titulo) => {
        const fila = hoja.addRow([titulo]);
        hoja.mergeCells(fila.number, 1, fila.number, 6);
        fila.getCell(1).font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
        fila.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
        fila.height = 20;
        return fila;
    };

    const etiquetaValor = (etiqueta, valor, { moneda = false, negrita = false } = {}) => {
        const fila = hoja.addRow([etiqueta, valor]);
        fila.getCell(1).font = { bold: negrita };
        fila.getCell(2).font = { bold: negrita };
        if (moneda) fila.getCell(2).numFmt = FORMATO_MONEDA;
        return fila;
    };

    // ── Cabecera ──────────────────────────────────────────────────────
    const titulo = hoja.addRow([nombreNegocio]);
    hoja.mergeCells(titulo.number, 1, titulo.number, 6);
    titulo.getCell(1).font = { bold: true, size: 15 };
    titulo.height = 22;

    const sub = hoja.addRow([`Reporte de caja · Turno #${caja.id_caja}`]);
    hoja.mergeCells(sub.number, 1, sub.number, 6);
    sub.getCell(1).font = { size: 11, color: { argb: 'FF667085' } };

    hoja.addRow([]);
    etiquetaValor('Apertura', fechaHora(caja.fecha_apertura));
    etiquetaValor('Cierre', caja.fecha_cierre ? fechaHora(caja.fecha_cierre) : 'Sin cerrar');
    etiquetaValor(
        'Responsable',
        [caja.usuario?.primer_nombre, caja.usuario?.primer_apellido].filter(Boolean).join(' ')
    );
    etiquetaValor('Monto de apertura', Number(caja.monto_apertura || 0), { moneda: true });
    etiquetaValor('Ingresos', Number(caja.ingresos || 0), { moneda: true });
    etiquetaValor('Egresos', Number(caja.egresos || 0), { moneda: true });
    etiquetaValor('Esperado en caja', Number(caja.monto_esperado || 0), { moneda: true, negrita: true });
    if (caja.monto_reportado != null) {
        etiquetaValor('Contado al cerrar', Number(caja.monto_reportado), { moneda: true });
    }
    if (caja.diferencia != null) {
        etiquetaValor('Diferencia', Number(caja.diferencia), { moneda: true, negrita: true });
    }
    if (caja.observaciones) etiquetaValor('Observaciones', caja.observaciones);

    // ── Formas de pago ────────────────────────────────────────────────
    hoja.addRow([]);
    seccion('FORMAS DE PAGO');

    const cabPagos = hoja.addRow(['Forma de pago', 'Valor']);
    [1, 2].forEach((c) => {
        cabPagos.getCell(c).font = { bold: true };
        cabPagos.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS } };
    });

    const metodos = caja.ingresos_por_metodo || [];
    if (metodos.length === 0) {
        hoja.addRow(['Sin ingresos registrados en el turno', '']);
    } else {
        for (const m of metodos) {
            const fila = hoja.addRow([m.nombre, Number(m.total || 0)]);
            fila.getCell(2).numFmt = FORMATO_MONEDA;
        }
    }

    const totalMetodos = metodos.reduce((suma, m) => suma + Number(m.total || 0), 0);
    const filaTotal = hoja.addRow(['TOTAL', totalMetodos]);
    [1, 2].forEach((c) => {
        filaTotal.getCell(c).font = { bold: true, size: 12 };
        filaTotal.getCell(c).border = { top: { style: 'thin' } };
    });
    filaTotal.getCell(2).numFmt = FORMATO_MONEDA;

    // ── Pedidos ───────────────────────────────────────────────────────
    hoja.addRow([]);
    seccion('PEDIDOS DEL TURNO');

    const COLS = ['Fecha', 'Tipo', 'Tipo de pedido', 'Pedido / Concepto', 'Usuario', 'Monto'];
    const cabPedidos = hoja.addRow(COLS);
    COLS.forEach((_, i) => {
        const celda = cabPedidos.getCell(i + 1);
        celda.font = { bold: true };
        celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS } };
    });

    if ((movimientos || []).length === 0) {
        hoja.addRow(['Este turno no registró movimientos.']);
    } else {
        for (const m of movimientos) {
            const fila = hoja.addRow([
                fechaHora(m.fecha),
                etiquetaTipo(m),
                etiquetaTipoPedido(m),
                concepto(m),
                [m.usuario?.primer_nombre, m.usuario?.primer_apellido].filter(Boolean).join(' '),
                Number(m.monto || 0),
            ]);
            fila.getCell(6).numFmt = FORMATO_MONEDA;
            // Lo anulado se tacha en vez de esconderse: la fila sigue estando en la caja.
            if (m.anulado || m.es_anulacion) {
                fila.eachCell((celda) => {
                    celda.font = { ...(celda.font || {}), strike: m.anulado, color: { argb: 'FF98A2B3' } };
                });
            }
        }
    }

    const buffer = await wb.xlsx.writeBuffer();
    const sello = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const filename = `caja_${caja.id_caja}_${slug(nombreNegocio)}_${sello}.xlsx`;
    return { buffer: Buffer.from(buffer), filename };
}

/** Nombre del negocio para la cabecera del archivo. */
async function getNombreNegocio(idNegocio) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, { attributes: ['nombre'] });
    return negocio?.nombre || 'Negocio';
}

module.exports = { generarXLSXCaja, getNombreNegocio };
