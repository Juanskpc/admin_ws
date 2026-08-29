'use strict';
const { validationResult } = require('express-validator');
const CajaService = require('../services/cajaService');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

/**
 * Reenvía los errores tipados del dominio tal cual (`CAJA_CERRADA`, `CAJA_YA_ABIERTA`…).
 * El servicio explica por qué rechaza; envolverlo en «Error al abrir la caja» tiraría el motivo.
 */
function fallo(res, err, contexto, porDefecto) {
    if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
    console.error(`[Reserva/Caja] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

/** GET /reserva/caja?id_negocio=N — estado del turno abierto. */
async function getEstado(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await CajaService.getEstadoCaja(Number(req.query.id_negocio));
        return Respuesta.success(res, data.abierta ? 'Caja abierta' : 'Sin caja abierta', data);
    } catch (err) {
        return fallo(res, err, 'getEstado', 'Error al consultar la caja.');
    }
}

/** POST /reserva/caja/abrir */
async function abrir(req, res) {
    if (!check(req, res)) return;
    try {
        const caja = await CajaService.abrirCaja({
            idNegocio: Number(req.body.id_negocio),
            idUsuario: req.usuario?.id_usuario,
            montoApertura: req.body.monto_apertura ?? 0,
            observaciones: req.body.observaciones,
        });
        return Respuesta.success(res, 'Caja abierta', caja);
    } catch (err) {
        return fallo(res, err, 'abrir', 'Error al abrir la caja.');
    }
}

/** POST /reserva/caja/:id/cerrar */
async function cerrar(req, res) {
    if (!check(req, res)) return;
    try {
        const caja = await CajaService.cerrarCaja({
            idCaja: Number(req.params.id),
            idNegocio: Number(req.body.id_negocio),
            montoReportado: req.body.monto_reportado,
            observaciones: req.body.observaciones,
        });
        if (!caja) return Respuesta.error(res, 'No se encontró una caja abierta con ese id.', 404);
        return Respuesta.success(res, 'Caja cerrada', caja);
    } catch (err) {
        return fallo(res, err, 'cerrar', 'Error al cerrar la caja.');
    }
}

/** POST /reserva/caja/movimiento — ingreso o egreso manual. */
async function registrarMovimiento(req, res) {
    if (!check(req, res)) return;
    try {
        const mov = await CajaService.registrarMovimientoManual({
            idNegocio: Number(req.body.id_negocio),
            tipo: String(req.body.tipo || '').toUpperCase(),
            monto: req.body.monto,
            concepto: req.body.concepto,
            idMetodoPago: req.body.id_metodo_pago ? Number(req.body.id_metodo_pago) : null,
            idUsuario: req.usuario?.id_usuario,
        });
        return Respuesta.success(res, 'Movimiento registrado', mov);
    } catch (err) {
        return fallo(res, err, 'registrarMovimiento', 'Error al registrar el movimiento.');
    }
}

/** GET /reserva/caja/historial?id_negocio=N */
async function historial(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await CajaService.getHistorial(Number(req.query.id_negocio), {
            limite: req.query.limite,
        });
        return Respuesta.success(res, 'Historial de cajas', data);
    } catch (err) {
        return fallo(res, err, 'historial', 'Error al consultar el historial.');
    }
}

/** GET /reserva/caja/pendientes?id_negocio=N — citas cobradas sin caja abierta. */
async function pendientes(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await CajaService.getCitasSinCaja(Number(req.query.id_negocio));
        return Respuesta.success(res, 'Citas sin caja', data);
    } catch (err) {
        return fallo(res, err, 'pendientes', 'Error al consultar las citas pendientes.');
    }
}

/** GET /reserva/caja/:id?id_negocio=N — detalle de un turno concreto. */
async function getDetalle(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await CajaService.getDetalleCaja({
            idCaja: Number(req.params.id),
            idNegocio: Number(req.query.id_negocio),
        });
        if (!data) return Respuesta.error(res, 'Caja no encontrada', 404);
        return Respuesta.success(res, 'Detalle de caja', data);
    } catch (err) {
        return fallo(res, err, 'getDetalle', 'Error al consultar la caja.');
    }
}

module.exports = {
    getEstado, abrir, cerrar, registrarMovimiento, historial, pendientes, getDetalle,
};
