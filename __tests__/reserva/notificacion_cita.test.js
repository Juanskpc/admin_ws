'use strict';

/**
 * Correos de citas de Reserva: quién recibe qué en cada evento, con la identidad del negocio.
 * Sin base ni SMTP: se simulan el modelo y el envío.
 */
jest.mock('../../app_core/models/conection', () => ({
    GenerNegocio: { findByPk: jest.fn() },
    ReservaProfesional: { findByPk: jest.fn() },
    ReservaCitaServicio: { findAll: jest.fn() },
    ReservaServicio: {},
    GenerUsuario: {},
}));
jest.mock('../../app_admin_api/services/mailService', () => ({
    sendHtmlEmail: jest.fn().mockResolvedValue(true),
}));

const Models = require('../../app_core/models/conection');
const Mail = require('../../app_admin_api/services/mailService');
const Notificacion = require('../../app_reserva_api/services/notificacionService');

const NEGOCIO = {
    id_negocio: 16, nombre: "D'ALEX BARBERIA", pais: 'CO', slug: null, email_contacto: 'negocio@x.co',
    logo_url: '/uploads/reserva/logos/16/logo.png', colores: { primario: '#7C2D12', acento: '#F59E0B' },
};
const PROFESIONALES = {
    3: { id_profesional: 3, nombre: 'Alex', email: 'alex@x.co', usuario: null },
    4: { id_profesional: 4, nombre: 'Sara', email: 'sara@x.co', usuario: null },
};

function cita(extra = {}) {
    return {
        id_cita: 99, id_negocio: 16, id_profesional: 3, codigo_publico: 'ABC123',
        fecha_hora_inicio: '2026-10-06T20:30:00.000Z', monto_total: 25000,
        cliente_nombre: 'Juan <b>Pérez</b>', cliente_email: 'juan@correo.com',
        creado_por_id_usuario: null, ...extra,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    Mail.sendHtmlEmail.mockResolvedValue(true);
    Models.GenerNegocio.findByPk.mockResolvedValue(NEGOCIO);
    Models.ReservaProfesional.findByPk.mockImplementation(async (id) => PROFESIONALES[id] || null);
    Models.ReservaCitaServicio.findAll.mockResolvedValue([{ servicio: { nombre: 'Corte' }, variante_snapshot: null }]);
});

const destinatarios = () => Mail.sendHtmlEmail.mock.calls.map(([c]) => c.to).sort();
const correoA = (to) => Mail.sendHtmlEmail.mock.calls.find(([c]) => c.to === to)?.[0];

describe('cita nueva', () => {
    test('cliente con correo agenda desde el portal: correo al cliente y al profesional', async () => {
        await Notificacion.enviar('cita_creada', { cita: cita() });

        expect(destinatarios()).toEqual(['alex@x.co', 'juan@correo.com']);
        const c = correoA('juan@correo.com');
        expect(c.subject).toMatch(/quedó agendada/);
        expect(c.html).toContain('ABC123');
        expect(c.html).toContain('Corte');
        expect(c.html).toContain('/reserva/p/16/mi-cita?codigo=ABC123');
        expect(c.html).toContain('3:30'); // 20:30Z = 3:30 p. m. en Bogotá
        expect(c.replyTo).toBe('negocio@x.co');
        expect(c.html).not.toContain('<b>Pérez</b>');
        expect(c.html).toContain('&lt;b&gt;Pérez&lt;/b&gt;');
    });

    test('lleva la identidad del negocio: su color y su logo con URL completa', async () => {
        await Notificacion.enviar('cita_creada', { cita: cita() });
        const c = correoA('juan@correo.com');
        expect(c.html).toContain('background:#7C2D12');
        expect(c.html).toContain('https://api.escalapp.cloud/uploads/reserva/logos/16/logo.png');
        expect(c.html).toContain('D&#39;ALEX BARBERIA');
    });

    test('sin colores propios usa un gris neutro, no el índigo de EscalApp', async () => {
        Models.GenerNegocio.findByPk.mockResolvedValue({ ...NEGOCIO, colores: null, logo_url: null });
        await Notificacion.enviar('cita_creada', { cita: cita() });
        const c = correoA('juan@correo.com');
        expect(c.html).toContain('background:#1F2937');
        expect(c.html).not.toMatch(/4361ee/i);
    });

    test('el correo del profesional no lleva el correo ni el teléfono del cliente', async () => {
        await Notificacion.enviar('cita_creada', { cita: cita({ cliente_telefono: '3001234567' }) });
        const c = correoA('alex@x.co');
        expect(c.html).not.toContain('juan@correo.com');
        expect(c.html).not.toContain('3001234567');
        expect(c.html).toContain('Corte');
        expect(c.replyTo).toBeUndefined();
    });

    test('con pago por validar, el cliente recibe «reserva recibida», no «agendada»', async () => {
        await Notificacion.enviar('cita_pendiente_pago', { cita: cita() });
        expect(correoA('juan@correo.com').subject).toMatch(/validando tu pago/);
    });

    test('correo inválido: solo se avisa al profesional', async () => {
        await Notificacion.enviar('cita_creada', { cita: cita({ cliente_email: 'no-es-correo' }) });
        expect(destinatarios()).toEqual(['alex@x.co']);
    });

    test('creada por el negocio desde la agenda: no se avisa al profesional', async () => {
        await Notificacion.enviar('cita_creada', { cita: cita({ creado_por_id_usuario: 7 }) });
        expect(destinatarios()).toEqual(['juan@correo.com']);
    });

    test('profesional sin correo en la ficha usa el de su usuario', async () => {
        Models.ReservaProfesional.findByPk.mockResolvedValue({ ...PROFESIONALES[3], email: null, usuario: { email: 'alex.user@x.co' } });
        await Notificacion.enviar('cita_creada', { cita: cita({ cliente_email: null }) });
        expect(destinatarios()).toEqual(['alex.user@x.co']);
    });
});

describe('cancelación', () => {
    test('la cancela el cliente: constancia al cliente y aviso al profesional', async () => {
        await Notificacion.enviar('cita_cancelada', { cita: cita({ cancelado_por: 'cliente', cancelado_motivo: 'viaje' }) });
        expect(destinatarios()).toEqual(['alex@x.co', 'juan@correo.com']);
        expect(correoA('juan@correo.com').html).toContain('cancelaste');
        // El motivo del cliente no viaja al profesional.
        expect(correoA('alex@x.co').html).not.toContain('viaje');
    });

    test('la cancela el negocio: el cliente ve el motivo', async () => {
        await Notificacion.enviar('cita_cancelada', { cita: cita({ cancelado_por: 'negocio', cancelado_motivo: 'Barbero enfermo' }) });
        const c = correoA('juan@correo.com');
        expect(c.subject).toMatch(/fue cancelada/);
        expect(c.html).toContain('Barbero enfermo');
        expect(correoA('alex@x.co').html).not.toContain('Barbero enfermo');
    });
});

describe('cambio de hora', () => {
    test('muestra antes y ahora al cliente y al profesional', async () => {
        await Notificacion.enviar('cita_reagendada', {
            cita: cita(), anterior: { fecha_hora_inicio: '2026-10-05T15:00:00.000Z', id_profesional: 3 },
        });
        expect(destinatarios()).toEqual(['alex@x.co', 'juan@correo.com']);
        const c = correoA('juan@correo.com');
        expect(c.subject).toMatch(/cambió de hora/);
        expect(c.html).toContain('Lunes, 5 de octubre');
        expect(c.html).toContain('line-through');
    });

    test('pasa a otro profesional: avisa al nuevo y al que se queda sin ella', async () => {
        await Notificacion.enviar('cita_reagendada', {
            cita: cita({ id_profesional: 4 }), anterior: { fecha_hora_inicio: '2026-10-06T20:30:00.000Z', id_profesional: 3 },
        });
        expect(destinatarios()).toEqual(['alex@x.co', 'juan@correo.com', 'sara@x.co']);
        expect(correoA('sara@x.co').html).toContain('pasó a tu agenda');
        expect(correoA('alex@x.co').html).toContain('pasó a otra persona');
    });

    test('solo cambian los servicios (misma hora): «actualizada», sin fila de antes', async () => {
        await Notificacion.enviar('cita_reagendada', {
            cita: cita(), anterior: { fecha_hora_inicio: '2026-10-06T20:30:00.000Z', id_profesional: 3 },
        });
        const c = correoA('juan@correo.com');
        expect(c.subject).toMatch(/fue actualizada/);
        expect(c.html).not.toContain('>Antes<');
    });
});

describe('pago', () => {
    test('aprobado: solo al cliente, cita confirmada', async () => {
        await Notificacion.enviar('pago_aprobado', { cita: cita({ creado_por_id_usuario: null }) });
        expect(destinatarios()).toEqual(['juan@correo.com']);
        expect(correoA('juan@correo.com').subject).toMatch(/está confirmada/);
    });

    test('rechazado: al cliente con el motivo, y al profesional que se liberó el espacio', async () => {
        await Notificacion.enviar('pago_rechazado', { cita: cita(), motivo: 'Comprobante ilegible' });
        expect(destinatarios()).toEqual(['alex@x.co', 'juan@correo.com']);
        expect(correoA('juan@correo.com').html).toContain('Comprobante ilegible');
        expect(correoA('alex@x.co').html).not.toContain('Comprobante ilegible');
    });
});

test('si falla un correo, los demás salen igual y no se lanza error', async () => {
    Mail.sendHtmlEmail.mockImplementation(({ to }) =>
        to === 'juan@correo.com' ? Promise.reject(new Error('SMTP caído')) : Promise.resolve(true));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(Notificacion.enviar('cita_creada', { cita: cita() })).resolves.toBeUndefined();
    expect(destinatarios()).toEqual(['alex@x.co', 'juan@correo.com']);
    spy.mockRestore();
});

test('con subdominio propio, el enlace del cliente va a su URL', () => {
    const { urlMiCita } = Notificacion._internos;
    expect(urlMiCita({ id_negocio: 16, slug: 'dalex-barberia' }, 'ABC123'))
        .toBe('https://dalex-barberia.escalapp.cloud/mi-cita?codigo=ABC123');
});

test('el texto encima del color del negocio siempre se lee', () => {
    const { textoSobre } = Notificacion._internos;
    expect(textoSobre('#7C2D12')).toBe('#FFFFFF'); // oscuro → blanco
    expect(textoSobre('#FDE68A')).toBe('#111827'); // claro → casi negro
});

test('eventos desconocidos no mandan correo', async () => {
    await Notificacion.enviar('cita_completada', { cita: cita() });
    expect(Mail.sendHtmlEmail).not.toHaveBeenCalled();
});
