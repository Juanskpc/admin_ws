'use strict';

/**
 * Notificaciones por correo del módulo Reserva.
 *
 * ## Qué sale y a quién
 *
 * | Evento                | Cliente (si dejó correo válido)     | Profesional (si tiene correo)                  |
 * |-----------------------|-------------------------------------|------------------------------------------------|
 * | `cita_creada`         | constancia de la cita               | solo si la agendó el cliente (portal público)  |
 * | `cita_pendiente_pago` | «reserva recibida, validando pago»  | ídem                                           |
 * | `cita_cancelada`      | la cancelación (y el motivo si fue el negocio) | que se le liberó ese hueco          |
 * | `cita_reagendada`     | antes → ahora                       | el de ahora; y el de antes si cambió de profesional |
 * | `pago_aprobado`       | cita confirmada                     | —  (ya supo de la cita al crearse)             |
 * | `pago_rechazado`      | no se pudo confirmar, con el motivo | que la cita quedó cancelada                    |
 *
 * ## Identidad del negocio
 *
 * El correo lo manda EscalApp, pero quien le habla al cliente es **su** negocio: cabecera con el
 * logo, el nombre y el color primario de `gener_negocio.colores` (la misma fuente que el tema del
 * portal, ver `marcaService.js`). Los clientes de correo no entienden `color-mix` ni variables
 * CSS, así que los tonos derivados (fondo suave, texto legible encima del primario) se calculan
 * aquí en hexadecimal.
 *
 * ## Qué NO lleva el correo del profesional
 *
 * Ni teléfono, ni correo, ni notas del cliente, ni el motivo de una cancelación: un correo se
 * reenvía y se queda en buzones que nadie controla (misma regla que el aviso de conversación
 * escalada, ADR-024). Nombre, servicio y hora bastan para prepararse; el resto está en la agenda.
 *
 * ## Best-effort
 *
 * Quien llama ya confirmó su transacción y atrapa el error: un correo que no sale nunca deshace
 * una cita, y el fallo de un destinatario no impide los demás.
 */
const Models = require('../../app_core/models/conection');
const Mail = require('../../app_admin_api/services/mailService');
const { monedaDePais } = require('../../app_core/helpers/paises');

const ZONA = 'America/Bogota';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
/** Sin colores propios: un gris neutro, no el índigo de EscalApp, que no es la marca de nadie. */
const PRIMARIO_NEUTRO = '#1F2937';

// ============================================================
// Utilidades
// ============================================================

function emailValido(valor) {
    const v = String(valor || '').trim();
    return v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}

/** Todo lo que viene de un formulario pasa por aquí antes de entrar al HTML. */
function esc(valor) {
    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatearFecha(fecha) {
    const d = new Date(fecha);
    const dia = d.toLocaleDateString('es-CO', {
        timeZone: ZONA, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    const hora = d.toLocaleTimeString('es-CO', { timeZone: ZONA, hour: 'numeric', minute: '2-digit' });
    const diaMayus = dia.charAt(0).toUpperCase() + dia.slice(1);
    return { dia: diaMayus, hora, completo: `${diaMayus}, ${hora}` };
}

function formatearMonto(valor, pais) {
    const m = monedaDePais(pais);
    return new Intl.NumberFormat(m.locale, {
        style: 'currency', currency: m.codigo,
        minimumFractionDigits: m.decimales, maximumFractionDigits: m.decimales,
    }).format(Number(valor) || 0);
}

function baseFrontend() {
    return String(process.env.FRONTEND_URL || 'https://escalapp.cloud').replace(/\/+$/, '');
}

/** Los logos se guardan como `/uploads/...` y los sirve Node: el correo necesita la URL completa. */
function urlAbsolutaApi(ruta) {
    if (!ruta) return null;
    if (/^https?:\/\//i.test(ruta)) return ruta;
    const base = String(process.env.APP_PUBLIC_URL || 'https://api.escalapp.cloud').replace(/\/+$/, '');
    return `${base}${ruta.startsWith('/') ? '' : '/'}${ruta}`;
}

/** Con subdominio propio el cliente vuelve a la URL de su negocio; sin él, a la genérica. */
function urlMiCita(negocio, codigo) {
    const q = `mi-cita?codigo=${encodeURIComponent(codigo)}`;
    return negocio.slug
        ? `https://${negocio.slug}.escalapp.cloud/${q}`
        : `${baseFrontend()}/reserva/p/${negocio.id_negocio}/${q}`;
}

function urlPortal(negocio) {
    return negocio.slug
        ? `https://${negocio.slug}.escalapp.cloud/`
        : `${baseFrontend()}/reserva/p/${negocio.id_negocio}`;
}

function urlAgenda() {
    return `${baseFrontend()}/reserva/agenda`;
}

// ── Color ──

function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mezcla con blanco: `peso` = cuánto queda del color (0..1). El `color-mix` que el correo no tiene. */
function aclarar(hex, peso) {
    const [r, g, b] = rgb(hex).map((c) => Math.round(c * peso + 255 * (1 - peso)));
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** Blanco o casi negro, el que se lea mejor encima de `hex` (luminancia relativa WCAG). */
function textoSobre(hex) {
    const [r, g, b] = rgb(hex).map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return l > 0.4 ? '#111827' : '#FFFFFF';
}

function marcaDe(negocio) {
    const c = negocio.colores || {};
    const primario = HEX.test(c.primario || '') ? c.primario.toUpperCase() : PRIMARIO_NEUTRO;
    return {
        nombre: negocio.nombre,
        logoUrl: urlAbsolutaApi(negocio.logo_url),
        primario,
        sobrePrimario: textoSobre(primario),
        suave: aclarar(primario, 0.08),
        borde: aclarar(primario, 0.35),
    };
}

// ============================================================
// Plantilla única
// ============================================================

/**
 * Un correo se describe, no se escribe: de la misma descripción salen el HTML y el texto plano,
 * así no pueden decir cosas distintas.
 *
 * @param {object} d
 * @param {object} d.marca       - `marcaDe(negocio)`
 * @param {string} d.encabezado  - La línea bajo el nombre del negocio.
 * @param {string} d.saludo      - «Hola, Juan.» (sin escapar, se escapa aquí)
 * @param {string[]} d.parrafos
 * @param {Array<{etq:string, valor:string, tachado?:boolean, codigo?:boolean}>} d.filas
 * @param {string=} d.aviso      - Franja ámbar.
 * @param {string=} d.nota       - Letra pequeña al final.
 * @param {{url:string, texto:string}=} d.boton
 */
function componer(d) {
    const m = d.marca;
    const filas = (d.filas || []).filter((f) => f.valor);

    const filasHtml = filas.map((f) => {
        const estilo = f.codigo
            ? `font-family:'Courier New',monospace;font-size:18px;font-weight:800;letter-spacing:2px;color:${m.primario};`
            : f.tachado
                ? 'color:#9CA3AF;text-decoration:line-through;'
                : 'color:#111827;';
        return `
            <tr><td style="padding:0 0 12px;">
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6B7280;font-weight:600;">${esc(f.etq)}</div>
              <div style="font-size:15px;line-height:1.45;${estilo}">${esc(f.valor)}</div>
            </td></tr>`;
    }).join('');

    const cabeceraLogo = m.logoUrl
        ? `<img src="${esc(m.logoUrl)}" alt="${esc(m.nombre)}" width="64" height="64"
               style="display:block;margin:0 auto 12px;width:64px;height:64px;border-radius:14px;object-fit:cover;background:#FFFFFF;border:2px solid rgba(255,255,255,.6);" />`
        : `<div style="width:64px;height:64px;line-height:64px;margin:0 auto 12px;border-radius:14px;background:rgba(255,255,255,.18);color:${m.sobrePrimario};font-size:28px;font-weight:800;text-align:center;">${esc((m.nombre || '?').trim().charAt(0).toUpperCase())}</div>`;

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>${esc(d.asunto)}</title>
</head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06);">
        <tr><td style="background:${m.primario};padding:28px 24px;text-align:center;">
          ${cabeceraLogo}
          <div style="color:${m.sobrePrimario};font-size:20px;font-weight:800;line-height:1.2;">${esc(m.nombre)}</div>
          <div style="color:${m.sobrePrimario};opacity:.8;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin-top:6px;">${esc(d.encabezado)}</div>
        </td></tr>
        <tr><td style="padding:28px 28px 8px;">
          <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#111827;">${esc(d.saludo)}</p>
          ${(d.parrafos || []).map((p) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.65;color:#4B5563;">${esc(p)}</p>`).join('')}
          ${filas.length ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${m.suave};border-left:4px solid ${m.primario};border-radius:10px;margin:18px 0;">
            <tr><td style="padding:18px 20px 6px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${filasHtml}
              </table>
            </td></tr>
          </table>` : ''}
          ${d.aviso ? `<p style="margin:0 0 14px;padding:12px 14px;background:#FFFBEB;border-left:4px solid #F59E0B;border-radius:6px;font-size:13px;line-height:1.6;color:#78350F;">${esc(d.aviso)}</p>` : ''}
          ${d.boton ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:10px 0 18px;">
            <a href="${esc(d.boton.url)}" style="display:inline-block;background:${m.primario};color:${m.sobrePrimario};text-decoration:none;padding:13px 30px;border-radius:8px;font-weight:700;font-size:14px;">${esc(d.boton.texto)}</a>
          </td></tr></table>` : ''}
          ${d.nota ? `<p style="margin:0 0 18px;font-size:12px;line-height:1.6;color:#9CA3AF;">${esc(d.nota)}</p>` : ''}
        </td></tr>
        <tr><td style="background:#F9FAFB;border-top:1px solid ${m.borde};padding:14px 24px;text-align:center;">
          <p style="margin:0;font-size:11px;line-height:1.6;color:#9CA3AF;">
            ${esc(m.nombre)} · Reservas con <strong style="color:#6B7280;">EscalApp</strong><br />
            Este correo se generó automáticamente.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const text = [
        `${m.nombre} — ${d.encabezado}`,
        '',
        d.saludo,
        '',
        ...(d.parrafos || []).flatMap((p) => [p, '']),
        ...filas.map((f) => `${f.etq}: ${f.valor}${f.tachado ? ' (ya no aplica)' : ''}`),
        filas.length ? '' : null,
        d.aviso ? `${d.aviso}\n` : null,
        d.boton ? `${d.boton.texto.replace(/\s*→$/, '')}: ${d.boton.url}` : null,
        d.nota ? `\n${d.nota}` : null,
    ].filter((l) => l !== null).join('\n');

    return { asunto: d.asunto, html, text };
}

// ============================================================
// Los correos, uno por evento y destinatario
// ============================================================

function filasCita(ctx, { conValor = false, conCodigo = false } = {}) {
    return [
        { etq: 'Fecha', valor: ctx.cuando.dia },
        { etq: 'Hora', valor: ctx.cuando.hora },
        { etq: 'Servicio', valor: ctx.nombresServicios },
        { etq: 'Con', valor: ctx.profesional.nombre },
        conValor ? { etq: 'Valor', valor: ctx.monto } : null,
        conCodigo ? { etq: 'Código de tu cita', valor: ctx.cita.codigo_publico, codigo: true } : null,
    ].filter(Boolean);
}

function filasParaProfesional(ctx) {
    return [
        { etq: 'Cliente', valor: ctx.cita.cliente_nombre },
        { etq: 'Fecha', valor: ctx.cuando.dia },
        { etq: 'Hora', valor: ctx.cuando.hora },
        { etq: 'Servicio', valor: ctx.nombresServicios },
    ];
}

const AL_CLIENTE = {
    cita_creada: (ctx) => componer({
        marca: ctx.marca,
        asunto: `Tu cita en ${ctx.negocio.nombre} quedó agendada`,
        encabezado: 'Cita agendada',
        saludo: `Hola, ${ctx.cita.cliente_nombre}.`,
        parrafos: ['Tu cita quedó agendada. Estos son los detalles:'],
        filas: filasCita(ctx, { conValor: true, conCodigo: true }),
        boton: { url: urlMiCita(ctx.negocio, ctx.cita.codigo_publico), texto: 'Ver mi cita →' },
        nota: 'Con el código puedes consultar o cancelar tu cita cuando quieras.',
    }),

    cita_pendiente_pago: (ctx) => componer({
        marca: ctx.marca,
        asunto: `Recibimos tu reserva en ${ctx.negocio.nombre} — validando tu pago`,
        encabezado: 'Reserva recibida',
        saludo: `Hola, ${ctx.cita.cliente_nombre}.`,
        parrafos: ['Recibimos tu reserva y tu comprobante de pago. Te avisaremos por este medio en cuanto el negocio lo valide.'],
        filas: filasCita(ctx, { conValor: true, conCodigo: true }),
        aviso: 'Tu cita queda sujeta a que el negocio valide el pago.',
        boton: { url: urlMiCita(ctx.negocio, ctx.cita.codigo_publico), texto: 'Ver mi cita →' },
        nota: 'Con el código puedes consultar o cancelar tu cita cuando quieras.',
    }),

    cita_cancelada: (ctx) => {
        const porElNegocio = ctx.cita.cancelado_por === 'negocio';
        return componer({
            marca: ctx.marca,
            asunto: `Tu cita en ${ctx.negocio.nombre} fue cancelada`,
            encabezado: 'Cita cancelada',
            saludo: `Hola, ${ctx.cita.cliente_nombre}.`,
            parrafos: [porElNegocio
                ? `${ctx.negocio.nombre} canceló tu cita. Lamentamos las molestias.`
                : 'Confirmamos que cancelaste tu cita.'],
            filas: [
                ...filasCita(ctx).map((f) => ({ ...f, tachado: f.etq === 'Fecha' || f.etq === 'Hora' })),
                porElNegocio && ctx.cita.cancelado_motivo ? { etq: 'Motivo', valor: ctx.cita.cancelado_motivo } : null,
            ].filter(Boolean),
            boton: { url: urlPortal(ctx.negocio), texto: 'Agendar otra cita →' },
        });
    },

    cita_reagendada: (ctx) => {
        const cambioHora = ctx.antes && ctx.antes.completo !== ctx.cuando.completo;
        return componer({
            marca: ctx.marca,
            asunto: cambioHora
                ? `Tu cita en ${ctx.negocio.nombre} cambió de hora`
                : `Tu cita en ${ctx.negocio.nombre} fue actualizada`,
            encabezado: cambioHora ? 'Cita reprogramada' : 'Cita actualizada',
            saludo: `Hola, ${ctx.cita.cliente_nombre}.`,
            parrafos: [cambioHora
                ? 'Tu cita cambió de hora. Así queda:'
                : 'Hubo un cambio en tu cita. Así queda:'],
            filas: [
                cambioHora ? { etq: 'Antes', valor: ctx.antes.completo, tachado: true } : null,
                ...filasCita(ctx, { conValor: true, conCodigo: true }),
            ].filter(Boolean),
            boton: { url: urlMiCita(ctx.negocio, ctx.cita.codigo_publico), texto: 'Ver mi cita →' },
            nota: 'Si la nueva hora no te sirve, puedes cancelarla desde el enlace con tu código.',
        });
    },

    pago_aprobado: (ctx) => componer({
        marca: ctx.marca,
        asunto: `Tu cita en ${ctx.negocio.nombre} está confirmada`,
        encabezado: 'Pago validado',
        saludo: `Hola, ${ctx.cita.cliente_nombre}.`,
        parrafos: ['Validamos tu pago y tu cita quedó confirmada. ¡Te esperamos!'],
        filas: filasCita(ctx, { conValor: true, conCodigo: true }),
        boton: { url: urlMiCita(ctx.negocio, ctx.cita.codigo_publico), texto: 'Ver mi cita →' },
    }),

    pago_rechazado: (ctx) => componer({
        marca: ctx.marca,
        asunto: `No pudimos confirmar tu cita en ${ctx.negocio.nombre}`,
        encabezado: 'Pago no validado',
        saludo: `Hola, ${ctx.cita.cliente_nombre}.`,
        parrafos: [`${ctx.negocio.nombre} no pudo validar tu comprobante de pago, así que la reserva quedó cancelada.`],
        filas: [
            ...filasCita(ctx).map((f) => ({ ...f, tachado: f.etq === 'Fecha' || f.etq === 'Hora' })),
            ctx.motivo ? { etq: 'Motivo', valor: ctx.motivo } : null,
        ].filter(Boolean),
        aviso: 'Si crees que es un error, comunícate con el negocio antes de volver a reservar.',
        boton: { url: urlPortal(ctx.negocio), texto: 'Volver a reservar →' },
    }),
};

function citaNuevaProfesional(ctx, aviso = null) {
    return componer({
        marca: ctx.marca,
        asunto: `Nueva cita: ${ctx.cuando.completo} — ${ctx.cita.cliente_nombre}`,
        encabezado: 'Tienes una cita nueva',
        saludo: `Hola, ${ctx.profesional.nombre}.`,
        parrafos: ['Un cliente acaba de agendar una cita contigo desde el portal de reservas.'],
        filas: filasParaProfesional(ctx),
        aviso,
        boton: { url: urlAgenda(), texto: 'Abrir la agenda →' },
    });
}

const AL_PROFESIONAL = {
    cita_creada: (ctx) => citaNuevaProfesional(ctx),

    cita_pendiente_pago: (ctx) =>
        citaNuevaProfesional(ctx, 'El cliente adjuntó un comprobante de pago que falta validar.'),

    cita_cancelada: (ctx) => componer({
        marca: ctx.marca,
        asunto: `Cita cancelada: ${ctx.cuando.completo} — ${ctx.cita.cliente_nombre}`,
        encabezado: 'Se liberó un espacio',
        saludo: `Hola, ${ctx.profesional.nombre}.`,
        parrafos: [ctx.cita.cancelado_por === 'negocio'
            ? 'El negocio canceló esta cita. Ese espacio de tu agenda quedó libre.'
            : 'El cliente canceló esta cita. Ese espacio de tu agenda quedó libre.'],
        filas: filasParaProfesional(ctx).map((f) => ({ ...f, tachado: f.etq === 'Fecha' || f.etq === 'Hora' })),
        boton: { url: urlAgenda(), texto: 'Abrir la agenda →' },
    }),

    cita_reagendada: (ctx) => {
        const cambioHora = ctx.antes && ctx.antes.completo !== ctx.cuando.completo;
        const llegaNueva = ctx.antes && ctx.antes.id_profesional !== ctx.profesional.id_profesional;
        return componer({
            marca: ctx.marca,
            asunto: llegaNueva
                ? `Nueva cita: ${ctx.cuando.completo} — ${ctx.cita.cliente_nombre}`
                : `Cita ${cambioHora ? 'reprogramada' : 'actualizada'}: ${ctx.cuando.completo} — ${ctx.cita.cliente_nombre}`,
            encabezado: llegaNueva ? 'Te asignaron una cita' : (cambioHora ? 'Cita reprogramada' : 'Cita actualizada'),
            saludo: `Hola, ${ctx.profesional.nombre}.`,
            parrafos: [llegaNueva
                ? 'Esta cita pasó a tu agenda.'
                : (cambioHora ? 'Esta cita cambió de hora.' : 'Esta cita cambió (servicios o detalles).')],
            filas: [
                cambioHora && !llegaNueva ? { etq: 'Antes', valor: ctx.antes.completo, tachado: true } : null,
                ...filasParaProfesional(ctx),
            ].filter(Boolean),
            boton: { url: urlAgenda(), texto: 'Abrir la agenda →' },
        });
    },

    /** Al profesional que se quedó SIN la cita porque se la pasaron a otro. */
    cita_reasignada_fuera: (ctx) => componer({
        marca: ctx.marca,
        asunto: `Cita reasignada: ${ctx.antes.completo} — ${ctx.cita.cliente_nombre}`,
        encabezado: 'Se liberó un espacio',
        saludo: `Hola, ${ctx.profesional.nombre}.`,
        parrafos: ['Esta cita pasó a otra persona del equipo. Ese espacio de tu agenda quedó libre.'],
        filas: [
            { etq: 'Cliente', valor: ctx.cita.cliente_nombre },
            { etq: 'Era el', valor: ctx.antes.completo, tachado: true },
        ],
        boton: { url: urlAgenda(), texto: 'Abrir la agenda →' },
    }),

    pago_rechazado: (ctx) => componer({
        marca: ctx.marca,
        asunto: `Cita cancelada: ${ctx.cuando.completo} — ${ctx.cita.cliente_nombre}`,
        encabezado: 'Se liberó un espacio',
        saludo: `Hola, ${ctx.profesional.nombre}.`,
        parrafos: ['El pago de esta cita no se pudo validar y quedó cancelada. Ese espacio de tu agenda quedó libre.'],
        filas: filasParaProfesional(ctx).map((f) => ({ ...f, tachado: f.etq === 'Fecha' || f.etq === 'Hora' })),
        boton: { url: urlAgenda(), texto: 'Abrir la agenda →' },
    }),
};

// ============================================================
// Datos
// ============================================================

async function cargarProfesional(idProfesional) {
    if (!idProfesional) return null;
    const p = await Models.ReservaProfesional.findByPk(idProfesional, {
        attributes: ['id_profesional', 'nombre', 'email'],
        include: [{ model: Models.GenerUsuario, as: 'usuario', attributes: ['email'], required: false }],
    });
    if (!p) return null;
    // La ficha del profesional manda; si no tiene, el correo de su usuario del sistema.
    return {
        id_profesional: p.id_profesional,
        nombre: p.nombre,
        email: emailValido(p.email) || emailValido(p.usuario?.email),
    };
}

async function nombresDeServicios(idCita) {
    const lineas = await Models.ReservaCitaServicio.findAll({
        where: { id_cita: idCita },
        attributes: ['id_servicio', 'variante_snapshot'],
        include: [{ model: Models.ReservaServicio, as: 'servicio', attributes: ['nombre'] }],
    });
    return lineas
        .map((l) => [l.servicio?.nombre, l.variante_snapshot].filter(Boolean).join(' · '))
        .filter(Boolean)
        .join(', ');
}

async function cargarContexto(payload) {
    const cita = payload.cita;
    const [negocio, profesional, nombresServicios] = await Promise.all([
        Models.GenerNegocio.findByPk(cita.id_negocio, {
            attributes: ['id_negocio', 'nombre', 'pais', 'slug', 'email_contacto', 'logo_url', 'colores'],
        }),
        cargarProfesional(cita.id_profesional),
        nombresDeServicios(cita.id_cita),
    ]);
    if (!negocio || !profesional) return null;

    const antes = payload.anterior?.fecha_hora_inicio
        ? { ...formatearFecha(payload.anterior.fecha_hora_inicio), id_profesional: payload.anterior.id_profesional }
        : null;

    return {
        cita,
        negocio,
        marca: marcaDe(negocio),
        profesional,
        nombresServicios,
        cuando: formatearFecha(cita.fecha_hora_inicio),
        antes,
        monto: formatearMonto(cita.monto_total, negocio.pais),
        motivo: payload.motivo || null,
    };
}

/** Quién recibe qué: `[[destinatario, correo], ...]`. */
async function destinatarios(evento, ctx) {
    const envios = [];
    const cita = ctx.cita;

    const emailCliente = emailValido(cita.cliente_email);
    if (emailCliente && AL_CLIENTE[evento]) {
        envios.push(['cliente', emailCliente, AL_CLIENTE[evento](ctx)]);
    }

    let avisarProfesional = !!AL_PROFESIONAL[evento];
    // Una cita que puso alguien del negocio desde la agenda: quien la puso ya lo sabe.
    if ((evento === 'cita_creada' || evento === 'cita_pendiente_pago') && cita.creado_por_id_usuario != null) {
        avisarProfesional = false;
    }
    if (avisarProfesional && ctx.profesional.email) {
        envios.push(['profesional', ctx.profesional.email, AL_PROFESIONAL[evento](ctx)]);
    }

    // Reagendada a otro profesional: el de antes también se entera de que ese hueco quedó libre.
    if (evento === 'cita_reagendada' && ctx.antes && ctx.antes.id_profesional
        && ctx.antes.id_profesional !== ctx.profesional.id_profesional) {
        const anterior = await cargarProfesional(ctx.antes.id_profesional);
        if (anterior?.email) {
            envios.push(['profesional anterior', anterior.email,
                AL_PROFESIONAL.cita_reasignada_fuera({ ...ctx, profesional: anterior })]);
        }
    }
    return envios;
}

// ============================================================
// Entrada
// ============================================================

const EVENTOS = new Set([
    'cita_creada', 'cita_pendiente_pago', 'cita_cancelada',
    'cita_reagendada', 'pago_aprobado', 'pago_rechazado',
]);

async function enviar(evento, payload = {}) {
    const idCita = payload.cita?.id_cita ?? '?';
    console.log(`[Reserva/Notif] evento=${evento} cita=${idCita}`);
    if (!EVENTOS.has(evento) || !payload.cita) return;

    const ctx = await cargarContexto(payload);
    if (!ctx) return;

    const envios = await destinatarios(evento, ctx);
    const replyTo = emailValido(ctx.negocio.email_contacto) || undefined;

    const resultados = await Promise.allSettled(envios.map(([quien, to, c]) =>
        Mail.sendHtmlEmail({
            to, subject: c.asunto, text: c.text, html: c.html,
            // Si el cliente contesta, que le llegue al negocio y no a EscalApp.
            ...(quien === 'cliente' && replyTo ? { replyTo } : {}),
        })));
    resultados.forEach((r, i) => {
        if (r.status === 'rejected') {
            console.error(`[Reserva/Notif] correo al ${envios[i][0]} (${evento}, cita ${idCita}) falló:`, r.reason?.message);
        }
    });
}

module.exports = {
    enviar,
    // Expuestos para tests y para la vista previa (`scripts/preview_correos_reserva.js`).
    _internos: { emailValido, esc, urlMiCita, marcaDe, textoSobre, formatearFecha, formatearMonto, AL_CLIENTE, AL_PROFESIONAL },
};
