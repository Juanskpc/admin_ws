'use strict';
/**
 * El correo de una factura electrónica, con el mismo diseño del comprobante de pago de «Mis pagos»
 * (`app_admin_api/services/comprobanteService.js`): cabecera con el documento a la derecha, sello,
 * dos columnas, tabla con cabecera índigo y el total en su caja.
 *
 * Es HTML de correo, así que va todo en tablas y estilos en línea: los clientes de correo (Gmail,
 * Outlook) ignoran casi todo lo demás.
 *
 * Hoy no lo envía nadie automáticamente: el correo que recibe el comprador lo manda el proveedor
 * (Factus) con su propio diseño. Esto existe para el día en que EscalApp mande el suyo.
 */

/** La misma paleta del comprobante, que es la del admin. */
const INDIGO = '#312E81';
const TEXTO = '#101828';
const SUAVE = '#667085';
const LINEA = '#E4E7EC';
const FONDO = '#F5F7FA';

const MEDIO_PAGO = { 10: 'Efectivo', 47: 'Transferencia', 48: 'Tarjeta crédito', 49: 'Tarjeta débito', ZZZ: 'Otro' };
const TIPO_DOCUMENTO = { 13: 'Cédula', 22: 'Cédula de extranjería', 31: 'NIT', 41: 'Pasaporte' };

const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const dinero = (v) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 })
        .format(Number(v || 0))
        .replace(/ /g, ' ');

function fechaHoraBogota(valor) {
    const d = valor instanceof Date ? valor : new Date(valor);
    if (!valor || Number.isNaN(d.getTime())) return '—';
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

/** Etiqueta + valor de una columna; se omite si no hay valor. */
const dato = (etiqueta, valor) =>
    valor
        ? `<p style="margin:0 0 2px;font-size:12px;color:${SUAVE};">${esc(etiqueta)}</p>
           <p style="margin:0 0 10px;font-size:14px;font-weight:700;color:${TEXTO};">${esc(valor)}</p>`
        : '';

const titulo = (t) =>
    `<p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:${SUAVE};">${esc(t)}</p>`;

/**
 * @param {object} p
 * @param {object} p.documento   fila de `facturacion.fe_documento`
 * @param {object[]} p.lineas    filas de `facturacion.fe_documento_linea`
 * @param {string} p.negocio     nombre comercial del negocio (`gener_negocio.nombre`)
 * @param {boolean} [p.ejemplo]  rotula el correo como ejemplo de pruebas
 * @returns {{ asunto: string, html: string, texto: string }}
 */
function correoFactura({ documento: d, lineas, negocio, ejemplo = false }) {
    const esNota = d.tipo === 'NC';
    const nombreDoc = esNota ? 'Nota crédito' : 'Factura electrónica de venta';
    const a = d.adquiriente || {};
    const e = d.emisor || {};
    const comprador = a.consumidor_final ? 'Consumidor final' : a.razon_social || a.nombres || '—';
    const documentoComprador = a.consumidor_final
        ? null
        : `${TIPO_DOCUMENTO[a.tipo_documento] || 'Documento'} ${a.numero_documento}${a.dv ? `-${a.dv}` : ''}`;
    const medios = (d.pagos || []).map((p) => MEDIO_PAGO[p.codigo_dian] || 'Otro').join(' + ') || '—';
    const nitEmisor = e.numero_documento ? `NIT ${e.numero_documento}${e.dv ? `-${e.dv}` : ''}` : '';

    const filas = lineas
        .map(
            (l, i) => `
          <tr style="background:${i % 2 === 0 ? FONDO : '#FFFFFF'};">
            <td style="padding:9px 10px;font-size:13px;color:${TEXTO};">${esc(l.descripcion)}</td>
            <td style="padding:9px 10px;font-size:13px;color:${TEXTO};text-align:right;">${Number(l.cantidad)}</td>
            <td style="padding:9px 10px;font-size:13px;color:${TEXTO};text-align:right;white-space:nowrap;">${dinero(l.precio_bruto)}</td>
            <td style="padding:9px 10px;font-size:13px;color:${TEXTO};text-align:right;white-space:nowrap;">${dinero(l.total)}</td>
          </tr>`
        )
        .join('');

    const impuestos = Number(d.total_impuestos) > 0
        ? `<tr><td style="padding:2px 0;font-size:13px;color:${SUAVE};">Subtotal</td><td style="padding:2px 0;font-size:13px;color:${TEXTO};text-align:right;">${dinero(d.subtotal)}</td></tr>
           <tr><td style="padding:2px 0 8px;font-size:13px;color:${SUAVE};">Impuestos</td><td style="padding:2px 0 8px;font-size:13px;color:${TEXTO};text-align:right;">${dinero(d.total_impuestos)}</td></tr>`
        : '';

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${esc(nombreDoc)} ${esc(d.numero)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f0f2f5;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#FFFFFF;border-radius:10px;">
    <tr><td style="padding:36px 40px 0;">
      ${ejemplo ? `<p style="margin:0 0 20px;padding:8px 12px;border:1px solid #F59E0B;border-radius:6px;background:#FEF3C7;font-size:12px;color:#92400E;"><strong>Ejemplo</strong> — factura del ambiente de pruebas de la DIAN, sin validez fiscal.</p>` : ''}

      <!-- Cabecera: quién factura, y qué documento es -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="vertical-align:top;">
            <p style="margin:0;font-size:24px;font-weight:700;color:${INDIGO};">${esc(negocio)}</p>
            <p style="margin:4px 0 0;font-size:12px;color:${SUAVE};">${esc([e.razon_social, nitEmisor].filter(Boolean).join(' · '))}</p>
          </td>
          <td style="vertical-align:top;text-align:right;">
            <p style="margin:0;font-size:15px;font-weight:700;color:${TEXTO};text-transform:uppercase;">${esc(nombreDoc)}</p>
            <p style="margin:4px 0 0;font-size:12px;color:${SUAVE};">N.º ${esc(d.numero)}</p>
          </td>
        </tr>
      </table>
      <div style="height:1px;background:${LINEA};margin:22px 0;"></div>

      <!-- Sello -->
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td style="background:#ECFDF3;border-radius:14px;padding:6px 26px;font-size:13px;font-weight:700;color:#027A48;">VALIDADA POR LA DIAN</td>
          <td style="padding-left:16px;font-size:13px;color:${SUAVE};">el ${esc(fechaHoraBogota(d.fecha_validacion))}</td>
        </tr>
      </table>

      <!-- Dos columnas -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
        <tr>
          <td width="50%" style="vertical-align:top;padding-right:12px;">
            ${titulo('Facturado a')}
            ${dato('Cliente', comprador)}
            ${dato('Documento', documentoComprador)}
            ${dato('Correo', a.correo)}
          </td>
          <td width="50%" style="vertical-align:top;padding-left:12px;">
            ${titulo('Datos de la venta')}
            ${dato('Pedido', d.origen_referencia)}
            ${dato('Medio de pago', medios)}
            ${esNota ? dato('Anula la factura', d.numero_factura_anulada) : ''}
          </td>
        </tr>
      </table>

      <!-- Detalle -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-bottom:1px solid ${LINEA};">
        <tr style="background:${INDIGO};">
          <th style="padding:10px;font-size:13px;color:#FFFFFF;text-align:left;">Descripción</th>
          <th style="padding:10px;font-size:13px;color:#FFFFFF;text-align:right;">Cant.</th>
          <th style="padding:10px;font-size:13px;color:#FFFFFF;text-align:right;">Unitario</th>
          <th style="padding:10px;font-size:13px;color:#FFFFFF;text-align:right;">Subtotal</th>
        </tr>
        ${filas}
      </table>

      <!-- Total -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 24px;">
        <tr><td></td><td width="280" style="background:${FONDO};border-radius:10px;padding:14px 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${impuestos}
            <tr><td colspan="2" style="font-size:13px;color:${SUAVE};">Total</td></tr>
            <tr><td colspan="2" style="padding-top:4px;font-size:24px;font-weight:700;color:${INDIGO};text-align:right;">${dinero(d.total)}</td></tr>
          </table>
        </td></tr>
      </table>

      ${d.url_publica ? `<p style="margin:0 0 22px;"><a href="${esc(d.url_publica)}" style="display:inline-block;background:${INDIGO};color:#FFFFFF;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:700;text-decoration:none;">Ver la factura en línea</a></p>` : ''}

      <!-- La letra pequeña -->
      <p style="margin:0 0 6px;font-size:11px;line-height:1.5;color:${SUAVE};">
        ${esNota ? 'Nota crédito' : 'Factura electrónica de venta'} validada por la DIAN. El PDF y el XML van adjuntos.
      </p>
      <p style="margin:0 0 32px;font-size:11px;line-height:1.5;color:${SUAVE};word-break:break-all;">
        ${esNota ? 'CUDE' : 'CUFE'}: ${esc(d.cufe)}
      </p>
    </td></tr>
    <tr><td style="padding:14px 40px;border-top:1px solid ${LINEA};font-size:11px;color:${SUAVE};">
      Enviado por EscalApp en nombre de ${esc(negocio)} · escalapp.cloud
    </td></tr>
  </table>
</body>
</html>`;

    const texto =
        `${nombreDoc} N.º ${d.numero} — ${negocio}\n\n` +
        `Cliente: ${comprador}\n` +
        `Pedido: ${d.origen_referencia ?? '—'}\n` +
        `Total: ${dinero(d.total)}\n` +
        `${esNota ? 'CUDE' : 'CUFE'}: ${d.cufe}\n` +
        (d.url_publica ? `Ver en línea: ${d.url_publica}\n` : '') +
        '\nEl PDF va adjunto.';

    return {
        asunto: `${ejemplo ? '[EJEMPLO] ' : ''}${nombreDoc} ${d.numero} · ${negocio}`,
        html,
        texto,
    };
}

module.exports = { correoFactura };
