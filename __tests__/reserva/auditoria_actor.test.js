/**
 * Reserva: las escrituras sobre tablas auditadas dejan QUIÉN las hizo en
 * `auditoria.audit_dato.id_usuario`.
 *
 * `fn_audit()` lee el actor de las GUC que `conection.js` fija SOLO al abrir una transacción; un
 * `cita.update(...)` suelto lo dejaba en NULL. `aprobarPago` / `rechazarPago` (validar un pago,
 * dinero) y `inactivar` un servicio se envolvieron en transacción: aquí se comprueba.
 *
 * El request se simula con el middleware `auditContext`. Corre contra la base de verdad y necesita
 * un negocio de reserva con servicio y profesional (`Salón`/`Barbería` del seed).
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const citaService = require('../../app_reserva_api/services/citaService');
const servicioService = require('../../app_reserva_api/services/servicioService');
const { auditContext } = require('../../app_core/middleware/auditContext');

const sequelize = Models.sequelize;

let idNegocio;
let idServicio;
let idProfesional;
let idUsuario;
const citas = [];
const servicios = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

function comoRequest(fn) {
    return new Promise((resolve, reject) => {
        auditContext({ usuario: { id_usuario: idUsuario }, ip: '127.0.0.1' }, {}, () => {
            Promise.resolve().then(fn).then(resolve, reject);
        });
    });
}

function actorDe(tabla, pk, condicion = 'true') {
    return unaFila(
        `SELECT id_usuario FROM auditoria.audit_dato
          WHERE esquema = 'reserva' AND tabla = :t AND operacion = 'U' AND pk_registro::text = :pk
            AND ${condicion}
          ORDER BY id_audit DESC LIMIT 1;`,
        { t: tabla, pk: String(pk) },
    );
}

async function crearCitaPendienteDePago() {
    const cita = await Models.ReservaCita.create({
        id_negocio: idNegocio, id_servicio: idServicio, id_profesional: idProfesional,
        fecha_hora_inicio: '2031-01-15 10:00:00', fecha_hora_fin: '2031-01-15 10:30:00',
        estado: 'pendiente', cliente_nombre: 'TEST actor', codigo_publico: `T${Date.now().toString(36).slice(-6)}${citas.length}`.toUpperCase(), requiere_pago: true, monto_total: 10000,
        pago_estado: 'pendiente_validacion',
    });
    citas.push(cita.id_cita);
    return cita;
}

beforeAll(async () => {
    const s = await unaFila(
        `SELECT s.id_negocio, s.id_servicio, (SELECT p.id_profesional FROM reserva.reserva_profesional p
                                              WHERE p.id_negocio = s.id_negocio LIMIT 1) AS id_profesional
           FROM reserva.reserva_servicio s
          WHERE s.estado = 'A' AND EXISTS (SELECT 1 FROM reserva.reserva_profesional p WHERE p.id_negocio = s.id_negocio)
          ORDER BY s.id_servicio DESC LIMIT 1;`,
    );
    ({ id_negocio: idNegocio, id_servicio: idServicio, id_profesional: idProfesional } = s);
    idUsuario = (await unaFila(
        `SELECT id_usuario FROM general.gener_negocio_usuario WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 1;`,
        { n: idNegocio },
    )).id_usuario;
});

afterAll(async () => {
    for (const id of citas) {
        await sequelize.query('DELETE FROM reserva.reserva_cita WHERE id_cita = :c', { replacements: { c: id } });
    }
    for (const id of servicios) {
        await sequelize.query('DELETE FROM reserva.reserva_servicio WHERE id_servicio = :s', { replacements: { s: id } });
    }
    await sequelize.close();
});

describe('validar un pago deja al usuario', () => {
    it('aprobarPago', async () => {
        const cita = await crearCitaPendienteDePago();
        await comoRequest(() => citaService.aprobarPago(cita.id_cita, idNegocio, idUsuario));
        const audit = await actorDe('reserva_cita', cita.id_cita, `datos_despues->>'pago_estado' = 'aprobado'`);
        expect(audit?.id_usuario).toBe(idUsuario);
    });

    it('rechazarPago', async () => {
        const cita = await crearCitaPendienteDePago();
        await comoRequest(() => citaService.rechazarPago(cita.id_cita, idNegocio, idUsuario, 'comprobante ilegible'));
        const audit = await actorDe('reserva_cita', cita.id_cita, `datos_despues->>'pago_estado' = 'rechazado'`);
        expect(audit?.id_usuario).toBe(idUsuario);
    });
});

describe('servicios', () => {
    it('inactivar un servicio deja al usuario', async () => {
        const s = await Models.ReservaServicio.create({
            id_negocio: idNegocio, nombre: `TEST-actor-${Date.now()}`, duracion_min: 30, precio: 1000, estado: 'A',
        });
        servicios.push(s.id_servicio);
        await comoRequest(() => servicioService.inactivar(s.id_servicio, idNegocio));
        const audit = await actorDe('reserva_servicio', s.id_servicio, `datos_despues->>'estado' = 'I'`);
        expect(audit?.id_usuario).toBe(idUsuario);
    });
});
