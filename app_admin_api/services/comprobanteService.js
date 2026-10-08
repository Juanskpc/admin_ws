'use strict';
/**
 * comprobanteService — el comprobante de un pago de mensualidad, en PDF.
 *
 * Lo que el cliente ve en «Mis pagos → Pagos» y puede descargar, imprimir o reenviar a su
 * contador. Un documento, dos salidas: el PDF que se descarga y el mismo PDF adjunto a un correo.
 *
 * ## Comprobante, NO factura electrónica
 *
 * `docs/cobro-mensualidades.md` §1.5: cada cobro tiene que terminar en una factura nuestra, y
 * hasta que exista la habilitación DIAN el número y el CUFE se llenan **a mano** en
 * `cob_factura.numero_factura` / `cufe`. Así que este documento dice lo que es:
 *
 *   - con `numero_factura` → lleva el número (y el CUFE si está): es el respaldo de la factura;
 *   - sin él → se rotula «Comprobante de pago» y avisa de que la factura llega aparte.
 *
 * Llamarlo «factura» mientras no lo es sería ponerle a un cliente un papel que no le sirve ante
 * su contador y que a nosotros nos compromete.
 *
 * ## Lo que NO sale en el PDF
 *
 * `comision_pasarela`, `retencion_declarada` y `neto_recibido`. Son nuestra conciliación
 * (`docs/obligaciones-escalapp.md` §3), no un dato del cliente — igual que en
 * `cobranzaService.pagosDeUsuario`.
 */
const Models = require('../../app_core/models/conection');
const Dao = require('../../app_core/dao/cobranzaDao');
const MailService = require('./mailService');

const sequelize = Models.sequelize;

/** Paleta del admin (`_theme.scss`): el comprobante se ve como la consola desde la que se pide. */
const INDIGO = '#312E81';
const TEXTO = '#101828';
const SUAVE = '#667085';
const LINEA = '#E4E7EC';
const FONDO = '#F5F7FA';

/** Monedas sin céntimos: nadie cobra decimales en pesos colombianos ni chilenos. */
const SIN_DECIMALES = new Set(['COP', 'CLP']);

function error(mensaje, code, statusCode = 400) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

function dinero(valor, moneda = 'COP') {
    const decimales = SIN_DECIMALES.has(moneda) ? 0 : 2;
    return new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: moneda || 'COP',
        minimumFractionDigits: decimales,
        maximumFractionDigits: decimales,
    })
        .format(Number(valor || 0))
        .replace(/ /g, ' ');
}

/** 'YYYY-MM-DD' → '1 de octubre de 2026'. Es una fecha de calendario: nada de husos. */
function diaLargo(iso) {
    if (!iso) return '—';
    const [a, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d)).toLocaleDateString('es-CO', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    });
}

/** Un instante (el pago) en hora de pared de Bogotá, pase lo que pase con el TZ del proceso. */
function fechaHoraBogota(valor) {
    if (!valor) return '—';
    const d = valor instanceof Date ? valor : new Date(valor);
    if (Number.isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    }).format(d);
}

/** Cómo se llama el medio en el papel. `medio_pago_texto` (lo que se teclea) manda si existe. */
// Los mismos nombres que la pantalla (`core/utils/pasarelas.ts`): el PDF y la tabla desde la que
// se pide no pueden llamar de dos maneras distintas al mismo medio de pago.
const NOMBRE_PASARELA = { wompi: 'Wompi', dlocal: 'dLocal Go', manual: 'Transferencia bancaria' };

function medioDePago(factura) {
    return factura.medio_pago_texto || NOMBRE_PASARELA[factura.pasarela] || factura.pasarela || '—';
}

/** Qué cobró esta factura. Un `ajuste` no es una mensualidad: es la diferencia de subir de plan. */
function concepto(factura) {
    const plan = factura.plan ? ` · ${factura.plan}` : '';
    return factura.tipo === 'ajuste' ? `Cambio de plan${plan}` : `Mensualidad EscalApp${plan}`;
}

function slug(texto) {
    return String(texto || 'escalapp')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

/**
 * Todo lo que lleva el comprobante de una factura PAGADA.
 *
 * Exige el estado: una factura `fallida` es un intento y una `anulada` se perdonó; un PDF que
 * diga «pagado» sobre cualquiera de las dos es un documento falso.
 */
async function datosComprobante(idFactura) {
    const factura = await Dao.getFactura(idFactura);
    if (!factura) throw error('No encontramos ese pago.', 'PAGO_NO_ENCONTRADO', 404);
    if (factura.estado !== 'pagada') {
        throw error('Ese cobro todavía no está pagado.', 'PAGO_NO_CONFIRMADO', 409);
    }

    const [negocio, plan, lineas] = await Promise.all([
        Models.GenerNegocio.findByPk(factura.id_negocio, {
            attributes: ['id_negocio', 'nombre', 'nit', 'email_contacto', 'telefono', 'direccion', 'pais'],
        }),
        factura.id_plan
            ? Models.GenerPlan.findByPk(factura.id_plan, { attributes: ['nombre'] })
            : null,
        Dao.listarDetalleFactura(idFactura),
    ]);

    return {
        id_factura: factura.id_factura,
        referencia: factura.referencia,
        id_negocio: factura.id_negocio,
        negocio: negocio?.nombre || 'Negocio',
        nit: negocio?.nit || null,
        email_negocio: negocio?.email_contacto || null,
        telefono: negocio?.telefono || null,
        direccion: negocio?.direccion || null,
        tipo: factura.tipo,
        plan: plan?.nombre || null,
        periodo_inicio: factura.periodo_inicio,
        periodo_fin: factura.periodo_fin,
        moneda: factura.moneda,
        subtotal: Number(factura.subtotal),
        impuestos: Number(factura.impuestos),
        total: Number(factura.total),
        fecha_pago: factura.fecha_pago,
        pasarela: factura.pasarela,
        medio_pago_texto: factura.medio_pago_texto,
        numero_factura: factura.numero_factura,
        cufe: factura.cufe,
        lineas,
    };
}

/**
 * El PDF, en una sola página A4.
 *
 * Una página a propósito: un comprobante de una mensualidad tiene una línea o tres, y paginar
 * algo que nunca se desborda solo añade código que nadie prueba. Si un día una factura llevara
 * veinte líneas, el bloque de la tabla es el único que habría que tocar.
 *
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
function generarPDF(datos) {
    const PDFDocument = require('pdfkit');

    const MARGEN = 48;
    const ANCHO = 595.28 - MARGEN * 2; // A4 menos márgenes
    const esFactura = Boolean(datos.numero_factura);
    const titulo = esFactura ? 'Factura de venta' : 'Comprobante de pago';

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            margin: MARGEN,
            info: { Title: `${titulo} ${datos.referencia}`, Author: 'EscalApp' },
        });
        const trozos = [];
        doc.on('data', (t) => trozos.push(t));
        doc.on('end', () =>
            resolve({
                buffer: Buffer.concat(trozos),
                filename: `comprobante_${slug(datos.referencia)}.pdf`,
            })
        );
        doc.on('error', reject);

        // ── Cabecera: quién cobra, qué documento es y su referencia ──
        doc.font('Helvetica-Bold').fontSize(20).fillColor(INDIGO).text('EscalApp', MARGEN, MARGEN);
        // El ancho se corta en la mitad menos un canal: la referencia del documento se escribe en
        // la otra mitad y A LA MISMA ALTURA, así que dos bloques que se solapen se pisarían.
        doc.font('Helvetica').fontSize(9).fillColor(SUAVE)
            .text('Software de gestión por suscripción · escalapp.cloud', { width: ANCHO * 0.5 - 12 });

        const yCab = MARGEN;
        doc.font('Helvetica-Bold').fontSize(13).fillColor(TEXTO)
            .text(titulo.toUpperCase(), MARGEN + ANCHO * 0.5, yCab, { width: ANCHO * 0.5, align: 'right' });
        doc.font('Helvetica').fontSize(9).fillColor(SUAVE)
            .text(`Referencia ${datos.referencia}`, { width: ANCHO * 0.5, align: 'right' });
        if (esFactura) {
            doc.text(`Factura N.º ${datos.numero_factura}`, { width: ANCHO * 0.5, align: 'right' });
        }

        let y = Math.max(doc.y, yCab + 52) + 10;
        doc.moveTo(MARGEN, y).lineTo(MARGEN + ANCHO, y).lineWidth(1).stroke(LINEA);
        y += 18;

        // ── Sello de pagado ──
        doc.roundedRect(MARGEN, y, 92, 22, 11).fill('#ECFDF3');
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#027A48')
            .text('PAGADO', MARGEN, y + 6, { width: 92, align: 'center' });
        doc.font('Helvetica').fontSize(10).fillColor(SUAVE)
            .text(`el ${fechaHoraBogota(datos.fecha_pago)}`, MARGEN + 104, y + 6, { width: ANCHO - 104 });
        y += 40;

        // ── Dos columnas: a quién se le cobró y cómo pagó ──
        const columna = (x, ancho, titulo_, filas) => {
            let yc = y;
            doc.font('Helvetica-Bold').fontSize(8).fillColor(SUAVE)
                .text(titulo_.toUpperCase(), x, yc, { width: ancho, characterSpacing: 0.5 });
            yc = doc.y + 4;
            for (const [etiqueta, valor] of filas) {
                if (!valor) continue;
                doc.font('Helvetica').fontSize(9).fillColor(SUAVE).text(etiqueta, x, yc, { width: ancho });
                doc.font('Helvetica-Bold').fontSize(10).fillColor(TEXTO).text(valor, x, doc.y, { width: ancho });
                yc = doc.y + 6;
            }
            return yc;
        };

        const anchoCol = (ANCHO - 24) / 2;
        const finIzq = columna(MARGEN, anchoCol, 'Cobrado a', [
            ['Negocio', datos.negocio],
            [datos.nit ? 'NIT' : null, datos.nit],
            ['Correo', datos.email_negocio],
            ['Dirección', datos.direccion],
        ]);
        const finDer = columna(MARGEN + anchoCol + 24, anchoCol, 'Datos del pago', [
            ['Medio de pago', medioDePago(datos)],
            ['Concepto', concepto(datos)],
            [
                'Período del servicio',
                datos.tipo === 'ajuste'
                    ? 'Ajuste de plan (no mueve el vencimiento)'
                    : `${diaLargo(datos.periodo_inicio)} → ${diaLargo(datos.periodo_fin)}`,
            ],
        ]);

        y = Math.max(finIzq, finDer) + 14;

        // ── Detalle ──
        const COLS = [
            { titulo: 'Descripción', ancho: ANCHO - 210, align: 'left' },
            { titulo: 'Cant.', ancho: 50, align: 'right' },
            { titulo: 'Unitario', ancho: 80, align: 'right' },
            { titulo: 'Subtotal', ancho: 80, align: 'right' },
        ];
        const FILA = 22;

        const fila = (valores, { negrita = false, color = TEXTO } = {}) => {
            let x = MARGEN;
            COLS.forEach((c, i) => {
                doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(color)
                    .text(valores[i], x + 8, y + 7, {
                        width: c.ancho - 16,
                        height: FILA - 8,
                        lineBreak: false,
                        ellipsis: true,
                        align: c.align,
                    });
                x += c.ancho;
            });
            y += FILA;
        };

        doc.rect(MARGEN, y, ANCHO, FILA).fill(INDIGO);
        fila(COLS.map((c) => c.titulo), { negrita: true, color: '#FFFFFF' });

        // Sin líneas de detalle (facturas anteriores a `cob_factura_detalle`) el total sigue
        // siendo cierto: se escribe una línea con el concepto y ya.
        const lineas = datos.lineas?.length
            ? datos.lineas
            : [{ descripcion: concepto(datos), cantidad: 1, precio_unitario: datos.total, subtotal: datos.total }];

        lineas.forEach((l, i) => {
            if (i % 2 === 0) doc.rect(MARGEN, y, ANCHO, FILA).fill(FONDO);
            fila([
                l.descripcion,
                String(l.cantidad ?? 1),
                dinero(l.precio_unitario, datos.moneda),
                dinero(l.subtotal, datos.moneda),
            ]);
        });

        doc.moveTo(MARGEN, y).lineTo(MARGEN + ANCHO, y).lineWidth(1).stroke(LINEA);
        y += 12;

        // ── Total ──
        const anchoTotal = 240;
        doc.roundedRect(MARGEN + ANCHO - anchoTotal, y, anchoTotal, 44, 8).fill(FONDO);
        doc.font('Helvetica').fontSize(10).fillColor(SUAVE)
            .text('Total pagado', MARGEN + ANCHO - anchoTotal + 14, y + 8);
        doc.font('Helvetica-Bold').fontSize(16).fillColor(INDIGO)
            .text(dinero(datos.total, datos.moneda), MARGEN + ANCHO - anchoTotal + 14, y + 22, {
                width: anchoTotal - 28,
                align: 'right',
            });
        y += 60;

        // ── La letra pequeña que de verdad importa ──
        doc.font('Helvetica').fontSize(8.5).fillColor(SUAVE);
        if (esFactura) {
            doc.text(
                `Respaldo del pago de la factura N.º ${datos.numero_factura}` +
                    (datos.cufe ? ` · CUFE ${datos.cufe}` : ''),
                MARGEN,
                y,
                { width: ANCHO }
            );
        } else {
            doc.text(
                'Este documento es un comprobante de pago: constata que el cobro de la referencia ' +
                    `${datos.referencia} fue recibido. No es una factura electrónica; si necesitas la ` +
                    'factura para tu contabilidad, escríbenos y te la enviamos.',
                MARGEN,
                y,
                { width: ANCHO }
            );
        }
        doc.moveDown(0.6);
        doc.text(
            'El valor no incluye IVA: EscalApp no es responsable de IVA a la fecha de este pago.',
            { width: ANCHO }
        );

        // ── Pie ──
        const yPie = 841.89 - MARGEN - 10;
        doc.moveTo(MARGEN, yPie - 12).lineTo(MARGEN + ANCHO, yPie - 12).lineWidth(1).stroke(LINEA);
        doc.font('Helvetica').fontSize(8).fillColor(SUAVE)
            .text(`Generado el ${fechaHoraBogota(new Date())} · EscalApp`, MARGEN, yPie, {
                width: ANCHO,
                lineBreak: false,
            });

        doc.end();
    });
}

function correoHtml(datos, titulo) {
    return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8" /><title>${titulo} · EscalApp</title></head>
<body style="margin:0;padding:32px 16px;background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.08);">
    <div style="background:#312E81;padding:24px 32px;text-align:center;">
      <span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:1px;">EscalApp</span>
      <p style="color:#ffffff;opacity:.75;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin:8px 0 0;">${titulo}</p>
    </div>
    <div style="padding:32px;">
      <p style="color:#4a5568;font-size:14px;line-height:1.7;margin:0 0 16px;">
        Adjuntamos el comprobante del pago de <strong>${datos.negocio}</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#4a5568;">
        <tr><td style="padding:6px 0;">Referencia</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#101828;">${datos.referencia}</td></tr>
        <tr><td style="padding:6px 0;">Pagado el</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#101828;">${fechaHoraBogota(datos.fecha_pago)}</td></tr>
        <tr><td style="padding:6px 0;">Medio de pago</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#101828;">${medioDePago(datos)}</td></tr>
        <tr><td style="padding:12px 0 0;border-top:1px solid #e8ecf0;">Total</td><td style="padding:12px 0 0;border-top:1px solid #e8ecf0;text-align:right;font-weight:800;font-size:18px;color:#312E81;">${dinero(datos.total, datos.moneda)}</td></tr>
      </table>
    </div>
    <div style="background:#f7f9ff;padding:16px 32px;text-align:center;">
      <p style="font-size:11px;color:#a0aec0;margin:0;line-height:1.6;">
        &copy; ${new Date().getFullYear()} <strong style="color:#718096;">EscalApp</strong> · Este correo fue generado automáticamente.
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Manda el comprobante por correo, con el PDF adjunto.
 *
 * El destinatario llega de fuera (el cliente escribe a quién se lo manda: su contador, su socio)
 * y por eso la ruta que llama aquí lleva límite de envíos: el acierto es lo que gasta la cuota de
 * correo, igual que en `forgot-password` (ver `app_core/middleware/limites.js`).
 */
async function enviarPorCorreo(datos, { email }) {
    const titulo = datos.numero_factura ? 'Factura de venta' : 'Comprobante de pago';
    const { buffer, filename } = await generarPDF(datos);

    const enviado = await MailService.sendHtmlEmail({
        to: email,
        subject: `${titulo} ${datos.referencia} · ${datos.negocio}`,
        text:
            `EscalApp — ${titulo}\n\n` +
            `Negocio: ${datos.negocio}\n` +
            `Referencia: ${datos.referencia}\n` +
            `Pagado el: ${fechaHoraBogota(datos.fecha_pago)}\n` +
            `Medio de pago: ${medioDePago(datos)}\n` +
            `Total: ${dinero(datos.total, datos.moneda)}\n\n` +
            'El comprobante va adjunto en PDF.',
        html: correoHtml(datos, titulo),
        attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
    });

    return { enviado, email, filename };
}

/**
 * El correo al que se manda por defecto: el del negocio, y si no tiene, el del usuario que lo pide.
 * Se resuelve en el backend para no depender de lo que el frontend crea saber del negocio.
 */
async function destinatarioPorDefecto(idNegocio, idUsuario) {
    const filas = await sequelize.query(
        `SELECT COALESCE(NULLIF(TRIM(n.email_contacto), ''), NULLIF(TRIM(u.email), '')) AS email
           FROM general.gener_negocio n
           LEFT JOIN general.gener_usuario u ON u.id_usuario = :idUsuario
          WHERE n.id_negocio = :idNegocio;`,
        { replacements: { idNegocio, idUsuario: idUsuario ?? null }, type: sequelize.QueryTypes.SELECT }
    );
    return filas[0]?.email || null;
}

module.exports = {
    datosComprobante,
    generarPDF,
    enviarPorCorreo,
    destinatarioPorDefecto,
    // Expuestas para las pruebas: son las decisiones de redacción del documento (cómo se nombra
    // el medio de pago, qué se cobró y cómo se escribe el dinero), y se pueden equivocar en
    // silencio en un PDF que nadie vuelve a leer.
    _interno: { dinero, medioDePago, concepto, diaLargo, fechaHoraBogota, slug },
};
