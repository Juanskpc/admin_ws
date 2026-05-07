'use strict';
const path = require('path');
const fs = require('fs');
const { validationResult } = require('express-validator');
const Models = require('../../app_core/models/conection');
const CitaService = require('../services/citaService');
const CitaListadoService = require('../services/citaListadoService');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

/** GET /reserva/citas?id_negocio=&desde=&hasta=&id_profesional=&estado= */
async function listar(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const r = await CitaListadoService.listar({
            idNegocio,
            desde:         req.query.desde,
            hasta:         req.query.hasta,
            idProfesional: req.query.id_profesional ? Number(req.query.id_profesional) : null,
            estado:        req.query.estado || null,
        });
        return Respuesta.success(res, 'Citas obtenidas', r);
    } catch (err) {
        console.error('[Reserva/Citas] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener citas.');
    }
}

/** GET /reserva/citas/pendientes-pago?id_negocio= */
async function listarPendientesPago(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const r = await CitaListadoService.listar({ idNegocio, soloPendientesPago: true });
        return Respuesta.success(res, 'Citas pendientes de validación', r);
    } catch (err) {
        console.error('[Reserva/Citas] pendientes:', err.message);
        return Respuesta.error(res, 'Error al obtener pendientes de pago.');
    }
}

/** GET /reserva/citas/:id?id_negocio= */
async function getById(req, res) {
    try {
        const c = await CitaListadoService.getById(Number(req.params.id), Number(req.query.id_negocio));
        if (!c) return Respuesta.error(res, 'Cita no encontrada', 404);
        return Respuesta.success(res, 'Cita obtenida', c);
    } catch (err) {
        console.error('[Reserva/Citas] getById:', err.message);
        return Respuesta.error(res, 'Error al obtener la cita.');
    }
}

/** POST /reserva/citas — crear manual desde el negocio */
async function crearManual(req, res) {
    if (!check(req, res)) return;
    try {
        const cita = await CitaService.crearCita({
            idNegocio:          Number(req.body.id_negocio),
            idProfesional:      Number(req.body.id_profesional),
            idServicios:        (req.body.id_servicios || []).map(Number),
            fechaHoraInicioISO: String(req.body.fecha_hora_inicio),
            clienteNombre:      String(req.body.cliente_nombre),
            clienteTelefono:    req.body.cliente_telefono || null,
            clienteEmail:       req.body.cliente_email || null,
            notas:              req.body.notas || null,
            creadoPorIdUsuario: req.usuario?.id_usuario,
        });
        return Respuesta.success(res, 'Cita creada', cita, 201);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode,
            err.code ? [{ code: err.code }] : null);
        console.error('[Reserva/Citas] crearManual:', err.message);
        return Respuesta.error(res, 'Error al crear la cita.');
    }
}

/** POST /reserva/citas/:id/confirmar */
async function confirmar(req, res) {
    try {
        const c = await CitaListadoService.cambiarEstado(
            Number(req.params.id), Number(req.body.id_negocio), 'confirmada',
        );
        if (!c) return Respuesta.error(res, 'Cita no encontrada', 404);
        return Respuesta.success(res, 'Cita confirmada', c);
    } catch (err) {
        console.error('[Reserva/Citas] confirmar:', err.message);
        return Respuesta.error(res, 'Error al confirmar la cita.');
    }
}

/** POST /reserva/citas/:id/completar */
async function completar(req, res) {
    try {
        const c = await CitaListadoService.cambiarEstado(
            Number(req.params.id), Number(req.body.id_negocio), 'completada',
        );
        if (!c) return Respuesta.error(res, 'Cita no encontrada', 404);
        return Respuesta.success(res, 'Cita completada', c);
    } catch (err) {
        console.error('[Reserva/Citas] completar:', err.message);
        return Respuesta.error(res, 'Error al completar la cita.');
    }
}

/** POST /reserva/citas/:id/no-show */
async function noShow(req, res) {
    try {
        const c = await CitaListadoService.cambiarEstado(
            Number(req.params.id), Number(req.body.id_negocio), 'no_show',
        );
        if (!c) return Respuesta.error(res, 'Cita no encontrada', 404);
        return Respuesta.success(res, 'Cita marcada como no-show', c);
    } catch (err) {
        console.error('[Reserva/Citas] noShow:', err.message);
        return Respuesta.error(res, 'Error al marcar la cita.');
    }
}

/** POST /reserva/citas/:id/cancelar  body: { id_negocio, motivo } */
async function cancelarPorNegocio(req, res) {
    try {
        const c = await CitaListadoService.cambiarEstado(
            Number(req.params.id), Number(req.body.id_negocio), 'cancelada',
            { cancelado_por: 'negocio', cancelado_motivo: req.body.motivo || null },
        );
        if (!c) return Respuesta.error(res, 'Cita no encontrada', 404);
        return Respuesta.success(res, 'Cita cancelada', c);
    } catch (err) {
        console.error('[Reserva/Citas] cancelar:', err.message);
        return Respuesta.error(res, 'Error al cancelar la cita.');
    }
}

/** POST /reserva/citas/:id/pago/aprobar  body: { id_negocio } */
async function aprobarPago(req, res) {
    try {
        const c = await CitaService.aprobarPago(
            Number(req.params.id), Number(req.body.id_negocio), req.usuario?.id_usuario,
        );
        return Respuesta.success(res, 'Pago aprobado', c);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Citas] aprobarPago:', err.message);
        return Respuesta.error(res, 'Error al aprobar el pago.');
    }
}

/** POST /reserva/citas/:id/pago/rechazar  body: { id_negocio, motivo } */
async function rechazarPago(req, res) {
    try {
        const c = await CitaService.rechazarPago(
            Number(req.params.id), Number(req.body.id_negocio), req.usuario?.id_usuario, req.body.motivo,
        );
        return Respuesta.success(res, 'Pago rechazado', c);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Citas] rechazarPago:', err.message);
        return Respuesta.error(res, 'Error al rechazar el pago.');
    }
}

/** GET /reserva/citas/:id/comprobante?id_negocio= — sirve el archivo si pertenece al negocio */
async function descargarComprobante(req, res) {
    try {
        const cita = await Models.ReservaCita.findOne({
            where: { id_cita: Number(req.params.id), id_negocio: Number(req.query.id_negocio) },
            attributes: ['comprobante_pago_url'],
        });
        if (!cita || !cita.comprobante_pago_url) return Respuesta.error(res, 'Comprobante no disponible', 404);

        const rel = cita.comprobante_pago_url.replace(/^\/+/, ''); // "uploads/reserva/..."
        const abs = path.resolve(path.join(__dirname, '..', '..'), rel);
        if (!abs.startsWith(path.resolve(path.join(__dirname, '..', '..', 'uploads')))) {
            return Respuesta.error(res, 'Ruta inválida', 400);
        }
        if (!fs.existsSync(abs)) return Respuesta.error(res, 'Archivo no encontrado', 404);
        return res.sendFile(abs);
    } catch (err) {
        console.error('[Reserva/Citas] comprobante:', err.message);
        return Respuesta.error(res, 'Error al obtener el comprobante.');
    }
}

module.exports = {
    listar, listarPendientesPago, getById, crearManual,
    confirmar, completar, noShow, cancelarPorNegocio,
    aprobarPago, rechazarPago, descargarComprobante,
};
