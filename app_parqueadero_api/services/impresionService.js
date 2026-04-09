/**
 * Servicio de impresión silenciosa de recibos.
 * Genera un PDF con PDFKit y lo envía a la impresora configurada del negocio
 * usando pdf-to-printer (Windows/Mac/Linux) sin mostrar ningún diálogo.
 */
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const PDFKit  = require('pdfkit');
const bwipjs  = require('bwip-js');
const printer = require('pdf-to-printer');
const Models  = require('../../app_core/models/conection');

const TZ = 'America/Bogota';

function fmtFecha(d) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(new Date(d));
}

function fmtMoneda(v) {
  if (v == null) return '—';
  return new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', minimumFractionDigits: 0,
  }).format(v);
}

/**
 * Dibuja un ícono de vehículo usando formas geométricas de PDFKit.
 * @param {PDFDocument} doc
 * @param {string} tipo - nombre del tipo de vehículo
 * @param {number} cx   - centro X
 * @param {number} y    - posición Y (esquina superior)
 * @param {number} size - tamaño del ícono
 */
function dibujarIconoVehiculo(doc, tipo, cx, y, size) {
  const t = (tipo || '').toLowerCase();
  const s = size;
  doc.save().strokeColor('#333333').fillColor('#333333').lineWidth(1.2);

  if (t.includes('moto') || t.includes('bici') || t.includes('scut')) {
    // Motocicleta / Bicicleta: 2 ruedas + manillar simple
    const r = s * 0.28;
    doc.circle(cx - s * 0.38, y + s * 0.55, r).stroke();
    doc.circle(cx + s * 0.38, y + s * 0.55, r).stroke();
    // cuerpo / chasis
    doc.moveTo(cx - s * 0.38, y + s * 0.27).lineTo(cx, y + s * 0.2).lineTo(cx + s * 0.38, y + s * 0.27).stroke();
    doc.moveTo(cx - s * 0.05, y + s * 0.2).lineTo(cx - s * 0.05, y + s * 0.12).lineTo(cx + s * 0.15, y + s * 0.08).stroke();
  } else if (t.includes('camion') || t.includes('camión') || t.includes('bus') || t.includes('mini')) {
    // Camión / Bus: cuerpo largo + cabina
    doc.rect(cx - s * 0.5, y + s * 0.1, s * 0.9, s * 0.5).stroke();         // cuerpo
    doc.rect(cx + s * 0.38, y + s * 0.1, s * 0.12, s * 0.35).stroke();       // cabina
    const r = s * 0.16;
    doc.circle(cx - s * 0.28, y + s * 0.72, r).stroke();
    doc.circle(cx + s * 0.15, y + s * 0.72, r).stroke();
    doc.circle(cx + s * 0.43, y + s * 0.72, r).stroke();
  } else {
    // Automóvil / camioneta (default)
    doc.rect(cx - s * 0.5, y + s * 0.35, s, s * 0.36).stroke();              // cuerpo
    doc.rect(cx - s * 0.28, y + s * 0.1, s * 0.56, s * 0.27).stroke();       // cabina
    const r = s * 0.17;
    doc.circle(cx - s * 0.3, y + s * 0.78, r).stroke();
    doc.circle(cx + s * 0.3, y + s * 0.78, r).stroke();
  }

  doc.restore();
}

/**
 * Genera un Buffer PNG con código de barras CODE128 usando bwip-js.
 */
async function generarBarras(texto) {
  return bwipjs.toBuffer({
    bcid:        'code128',
    text:        texto || 'N/A',
    scale:       3,
    height:      14,       // mm
    includetext: true,
    textxalign:  'center',
    textsize:    10,
    backgroundcolor: 'ffffff',
  });
}

/**
 * Genera un Buffer PDF del recibo usando PDFKit (ancho 80 mm = 226.77 pt).
 * @param {object} v           - Datos del vehículo/factura
 * @param {boolean} esSalida   - true = recibo de salida, false = entrada
 * @param {object} config      - Configuración del parqueadero
 */
async function generarPdfRecibo(v, esSalida, config) {
  // Generar código de barras antes de iniciar el PDF
  const barcodeBuffer = await generarBarras(v.placa || 'NOPLATE');

  return new Promise((resolve, reject) => {
    const ANCHO  = 226.77;   // 80 mm en puntos
    const MARGIN = 10;
    const COL    = ANCHO - MARGIN * 2;

    // ── Fuentes y tamaños ──
    const FNT_TITULO  = 'Helvetica-Bold';
    const FNT_NORMAL  = 'Helvetica';
    const FNT_BOLD    = 'Helvetica-Bold';
    const SZ_TITULO   = 14;
    const SZ_SUBTITULO = 9;
    const SZ_PLACA    = 24;
    const SZ_NORMAL   = 10;
    const SZ_SMALL    = 9;
    const SZ_TOTAL    = 16;

    const chunks = [];
    const doc = new PDFKit({
      size: [ANCHO, 700],
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      autoFirstPage: true,
      bufferPages: true,
    });

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const negocio        = config?.nombre_comercial || 'Parqueadero';
    const direccion      = config?.direccion  || '';
    const telefono       = config?.telefono   || '';
    const placa          = v.placa  || '';
    const tipoVeh        = v.tipoVehiculo?.nombre || '—';
    const tipoCobro      = v.tarifa?.tipo_cobro   || '—';
    const valorUnit      = v.tarifa?.valor        != null ? fmtMoneda(Number(v.tarifa.valor))    : '—';
    const valorAdicional = v.tarifa?.valor_adicional != null ? fmtMoneda(Number(v.tarifa.valor_adicional)) : null;
    const titulo         = esSalida ? 'RECIBO DE SALIDA' : 'RECIBO DE ENTRADA';

    let y = MARGIN;

    // ── Helper: línea punteada ──
    const dashed = (gap = 6) => {
      doc.dash(2, { space: 2 }).moveTo(MARGIN, y).lineTo(MARGIN + COL, y).lineWidth(0.5).stroke('#888888').undash();
      y += gap;
    };

    // ── Helper: línea sólida ──
    const solid = (grosor = 1, gap = 6) => {
      doc.moveTo(MARGIN, y).lineTo(MARGIN + COL, y).lineWidth(grosor).stroke('#000000');
      y += gap;
    };

    // ── Helper: fila label | valor ──
    const fila = (lbl, val) => {
      doc.font(FNT_NORMAL).fontSize(SZ_NORMAL).fillColor('#555555')
         .text(lbl, MARGIN, y, { width: COL * 0.52, lineBreak: false });
      doc.font(FNT_BOLD).fontSize(SZ_NORMAL).fillColor('#111111')
         .text(String(val), MARGIN + COL * 0.52, y, { width: COL * 0.48, align: 'right', lineBreak: false });
      y += 15;
    };

    // ── Ícono de vehículo (lado derecho del encabezado) ──
    const ICON_SIZE = 36;
    dibujarIconoVehiculo(doc, tipoVeh, MARGIN + COL - ICON_SIZE * 0.5, y + 4, ICON_SIZE);

    // ── Encabezado: nombre del negocio ──
    doc.font(FNT_TITULO).fontSize(SZ_TITULO).fillColor('#000000')
       .text(negocio.toUpperCase(), MARGIN, y, { width: COL - ICON_SIZE - 4 });
    y += 18;

    doc.font(FNT_BOLD).fontSize(SZ_SUBTITULO).fillColor('#444444')
       .text(titulo, MARGIN, y, { width: COL - ICON_SIZE - 4 });
    y += 12;

    if (direccion) {
      doc.font(FNT_NORMAL).fontSize(SZ_SMALL).fillColor('#666666')
         .text(direccion, MARGIN, y, { width: COL - ICON_SIZE - 4 });
      y += 11;
    }
    if (telefono) {
      doc.font(FNT_NORMAL).fontSize(SZ_SMALL).fillColor('#666666')
         .text(`Tel: ${telefono}`, MARGIN, y, { width: COL - ICON_SIZE - 4 });
      y += 11;
    }

    // Espacio restante para el ícono
    y = Math.max(y, MARGIN + ICON_SIZE + 8);

    solid(1.5, 7);

    // Número de factura
    if (v.numero_factura) {
      doc.font(FNT_NORMAL).fontSize(SZ_SMALL).fillColor('#888888')
         .text(`Factura: ${v.numero_factura}`, MARGIN, y, { width: COL, align: 'right' });
      y += 13;
    }

    // ── Placa grande ──
    doc.roundedRect(MARGIN + COL * 0.1, y, COL * 0.8, 30, 4).lineWidth(2).stroke('#000000');
    doc.font(FNT_TITULO).fontSize(SZ_PLACA).fillColor('#000000')
       .text(placa, MARGIN, y + 5, { width: COL, align: 'center' });
    y += 37;

    // ── Código de barras ──
    const BW = COL * 0.9;
    const BH = 42;
    doc.image(barcodeBuffer, MARGIN + (COL - BW) / 2, y, { width: BW, height: BH });
    y += BH + 6;

    dashed();

    // ── Detalles del vehículo y tarifa ──
    fila('Tipo de vehículo', tipoVeh);
    fila('Tipo de cobro',    tipoCobro);
    fila('Valor 1ª hora',    valorUnit);
    if (valorAdicional) {
      fila('Valor hora adic.', valorAdicional);
    }

    dashed();

    fila('Entrada', fmtFecha(v.fecha_entrada));
    if (esSalida) {
      fila('Salida', fmtFecha(v.fecha_salida || new Date().toISOString()));
    }

    if (esSalida) {
      solid(1.5, 8);
      doc.font(FNT_NORMAL).fontSize(SZ_SMALL).fillColor('#555555')
         .text('TOTAL A PAGAR', MARGIN, y, { width: COL, align: 'center' });
      y += 12;
      doc.font(FNT_TITULO).fontSize(SZ_TOTAL).fillColor('#000000')
         .text(fmtMoneda(v.valor_cobrado), MARGIN, y, { width: COL, align: 'center' });
      y += 22;
    }

    if (v.observaciones?.trim()) {
      dashed();
      doc.font(FNT_NORMAL).fontSize(SZ_SMALL).fillColor('#555555')
         .text(`Obs: ${v.observaciones.trim()}`, MARGIN, y, { width: COL });
      y += doc.heightOfString(v.observaciones.trim(), { width: COL, fontSize: SZ_SMALL }) + 6;
    }

    // ── Pie ──
    dashed(4);
    doc.font(FNT_BOLD).fontSize(SZ_SMALL).fillColor('#666666')
       .text('¡Gracias por su visita!', MARGIN, y, { width: COL, align: 'center' });
    y += 12;
    doc.font(FNT_NORMAL).fontSize(SZ_SMALL - 1).fillColor('#aaaaaa')
       .text(fmtFecha(new Date()), MARGIN, y, { width: COL, align: 'center' });

    doc.end();
  });
}

/**
 * Imprime un recibo: genera PDF en disco, lo imprime y elimina el archivo temporal.
 * @param {object} vehiculoData - Datos del vehículo con tarifa, tipoVehiculo y factura
 * @param {boolean} esSalida
 * @param {number} idNegocio
 */
async function imprimirRecibo(vehiculoData, esSalida, idNegocio) {
  // Obtener configuración del negocio (para nombre y nombre de impresora)
  const config = await Models.ParqConfiguracion.findOne({ where: { id_negocio: idNegocio } });
  const configJson = config?.toJSON() || {};

  // Generar PDF
  const pdfBuffer = await generarPdfRecibo(vehiculoData, esSalida, configJson);
  // Escribir en archivo temporal
  const tmpFile = path.join(os.tmpdir(), `recibo_${Date.now()}_${idNegocio}.pdf`);
  fs.writeFileSync(tmpFile, pdfBuffer);

  try {
    const opts = {};
    // Si hay impresora configurada, usarla; si no, se usa la predeterminada del sistema
    if (configJson.nombre_impresora?.trim()) {
      opts.printer = configJson.nombre_impresora.trim();
    }
    await printer.print(tmpFile, opts);
  } finally {
    // Eliminar el archivo temporal (breve delay para que el spooler lo lea)
    setTimeout(() => {
      try { fs.unlinkSync(tmpFile); } catch (_) { /* ignorar */ }
    }, 5000);
  }
}

/**
 * Lista las impresoras disponibles en el sistema.
 */
async function listarImpresoras() {
  return printer.getPrinters();
}

module.exports = { imprimirRecibo, listarImpresoras };
