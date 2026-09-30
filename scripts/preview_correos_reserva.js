'use strict';

/**
 * Vista previa de los correos de citas de Reserva, sin base ni SMTP.
 *
 *   node scripts/preview_correos_reserva.js [archivo_salida.html]
 *
 * Genera una sola página con todos los correos (cliente y profesional, cada evento) para dos
 * negocios de ejemplo: uno de marca oscura con logo y otro de marca clara sin logo, que son los
 * dos extremos que tiene que aguantar la plantilla. Usa las mismas funciones que el envío real.
 */
const fs = require('fs');
const path = require('path');
const { _internos: N } = require('../app_reserva_api/services/notificacionService');

const salida = path.resolve(process.argv[2] || path.join(__dirname, 'preview_correos_reserva.html'));

const LOGO_EJEMPLO = 'data:image/svg+xml;base64,' + Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#fff"/>
     <circle cx="32" cy="32" r="22" fill="#7C2D12"/><text x="32" y="40" font-family="Georgia" font-size="22"
     font-weight="bold" fill="#F59E0B" text-anchor="middle">DA</text></svg>`).toString('base64');

const NEGOCIOS = [
    {
        etiqueta: 'Marca oscura, con logo',
        negocio: { id_negocio: 16, nombre: "D'ALEX BARBERIA", pais: 'CL', slug: 'dalex-barberia',
            logo_url: null, colores: { primario: '#7C2D12', acento: '#F59E0B' } },
        logo: LOGO_EJEMPLO,
    },
    {
        etiqueta: 'Marca clara, sin logo',
        negocio: { id_negocio: 21, nombre: 'Spa Lavanda', pais: 'CO', slug: null,
            logo_url: null, colores: { primario: '#C4B5FD', acento: '#7C3AED' } },
        logo: null,
    },
];

function contexto({ negocio, logo }, extra = {}) {
    const marca = N.marcaDe(negocio);
    marca.logoUrl = logo;
    const cita = {
        id_cita: 99, id_negocio: negocio.id_negocio, id_profesional: 3, codigo_publico: 'K7M2QX',
        fecha_hora_inicio: '2026-10-06T20:30:00.000Z', monto_total: 25000,
        cliente_nombre: 'Juan Pérez', cliente_email: 'juan@correo.com', creado_por_id_usuario: null,
        ...(extra.cita || {}),
    };
    return {
        cita, negocio, marca,
        profesional: { id_profesional: 3, nombre: 'Alex Rojas', email: 'alex@x.co' },
        nombresServicios: 'Corte clásico, Arreglo de barba',
        cuando: N.formatearFecha(cita.fecha_hora_inicio),
        antes: extra.antes ? { ...N.formatearFecha(extra.antes), id_profesional: 3 } : null,
        monto: N.formatearMonto(cita.monto_total, negocio.pais),
        motivo: extra.motivo || null,
    };
}

const CASOS = [
    ['Cliente', 'Cita agendada', (n) => N.AL_CLIENTE.cita_creada(contexto(n))],
    ['Profesional', 'Cita nueva', (n) => N.AL_PROFESIONAL.cita_creada(contexto(n))],
    ['Cliente', 'Reserva con pago por validar', (n) => N.AL_CLIENTE.cita_pendiente_pago(contexto(n))],
    ['Cliente', 'Pago aprobado', (n) => N.AL_CLIENTE.pago_aprobado(contexto(n))],
    ['Cliente', 'Pago rechazado', (n) => N.AL_CLIENTE.pago_rechazado(contexto(n, { motivo: 'El comprobante no corresponde al valor del abono.' }))],
    ['Profesional', 'Pago rechazado', (n) => N.AL_PROFESIONAL.pago_rechazado(contexto(n))],
    ['Cliente', 'Cambio de hora', (n) => N.AL_CLIENTE.cita_reagendada(contexto(n, { antes: '2026-10-05T15:00:00.000Z' }))],
    ['Profesional', 'Cambio de hora', (n) => N.AL_PROFESIONAL.cita_reagendada(contexto(n, { antes: '2026-10-05T15:00:00.000Z' }))],
    ['Cliente', 'Cancelada por el negocio', (n) => N.AL_CLIENTE.cita_cancelada(contexto(n, { cita: { cancelado_por: 'negocio', cancelado_motivo: 'El profesional tuvo una calamidad.' } }))],
    ['Cliente', 'Cancelada por el cliente', (n) => N.AL_CLIENTE.cita_cancelada(contexto(n, { cita: { cancelado_por: 'cliente' } }))],
    ['Profesional', 'Cancelada', (n) => N.AL_PROFESIONAL.cita_cancelada(contexto(n, { cita: { cancelado_por: 'cliente' } }))],
];

const esc = N.esc;
const secciones = NEGOCIOS.map((n) => `
  <h2>${esc(n.negocio.nombre)} <small>${esc(n.etiqueta)} · ${esc(n.negocio.colores.primario)}</small></h2>
  <div class="grid">
    ${CASOS.map(([para, titulo, hacer]) => {
        const c = hacer(n);
        return `<figure>
          <figcaption><span class="para ${para === 'Cliente' ? 'cli' : 'pro'}">${para}</span> ${esc(titulo)}
            <div class="asunto">Asunto: ${esc(c.asunto)}</div></figcaption>
          <iframe srcdoc="${esc(c.html)}" loading="lazy"></iframe>
        </figure>`;
    }).join('')}
  </div>`).join('');

fs.writeFileSync(salida, `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Correos de Reserva</title>
<style>
  body { margin: 0; padding: 24px 16px 48px; background: #E5E7EB; font-family: system-ui, sans-serif; color: #111827; }
  h1 { margin: 0 0 4px; font-size: 22px; } p.sub { margin: 0 0 24px; color: #4B5563; font-size: 14px; }
  h2 { font-size: 18px; margin: 32px 0 12px; } h2 small { font-weight: 400; color: #6B7280; font-size: 13px; margin-left: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 20px; }
  figure { margin: 0; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  figcaption { padding: 12px 14px; font-size: 14px; font-weight: 600; border-bottom: 1px solid #E5E7EB; }
  .asunto { font-weight: 400; color: #6B7280; font-size: 12px; margin-top: 4px; }
  .para { font-size: 11px; padding: 2px 8px; border-radius: 99px; margin-right: 6px; }
  .cli { background: #DBEAFE; color: #1E40AF; } .pro { background: #DCFCE7; color: #166534; }
  iframe { width: 100%; height: 760px; border: 0; display: block; }
  @media (max-width: 440px) { .grid { grid-template-columns: 1fr; } }
</style></head>
<body>
  <h1>Correos de citas · Reserva</h1>
  <p class="sub">Vista previa generada con la plantilla real. Datos de ejemplo.</p>
  ${secciones}
</body></html>`);

console.log(`Vista previa escrita en ${salida}`);
