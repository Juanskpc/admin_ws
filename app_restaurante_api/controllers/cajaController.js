'use strict';
const { validationResult } = require('express-validator');
const CajaService = require('../services/cajaService');
const Respuesta = require('../../app_core/helpers/respuesta');

function handleValidation(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        Respuesta.error(res, 'Datos inválidos', 422, errors.array());
        return false;
    }
    return true;
}

/** GET /restaurante/caja/abierta?id_negocio=N */
async function getCajaAbierta(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const caja = await CajaService.getCajaAbierta(idNegocio);
        return Respuesta.success(res, caja ? 'Caja abierta encontrada' : 'No hay caja abierta', caja);
    } catch (err) {
        console.error('[Caja] Error getCajaAbierta:', err.message);
        return Respuesta.error(res, 'Error al consultar la caja.');
    }
}

/** POST /restaurante/caja/abrir */
async function abrirCaja(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const { id_negocio, monto_apertura, observaciones } = req.body;
        const caja = await CajaService.abrirCaja({
            idNegocio: id_negocio,
            idUsuario: req.usuario.id_usuario,
            montoApertura: Number(monto_apertura) || 0,
            observaciones,
        });
        return Respuesta.success(res, 'Caja abierta', caja, 201);
    } catch (err) {
        if (err.code === 'CAJA_YA_ABIERTA') {
            return Respuesta.error(res, err.message, err.statusCode || 409, { code: err.code });
        }
        console.error('[Caja] Error abrirCaja:', err.message);
        return Respuesta.error(res, 'Error al abrir la caja.');
    }
}

/** PUT /restaurante/caja/:id/cerrar */
async function cerrarCaja(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const idCaja = Number(req.params.id);
        const { id_negocio, monto_reportado, observaciones } = req.body;

        const caja = await CajaService.cerrarCaja({
            idCaja,
            idNegocio: Number(id_negocio),
            montoReportado: monto_reportado,
            observaciones,
        });
        if (!caja) return Respuesta.error(res, 'Caja no encontrada o ya cerrada.', 404);
        return Respuesta.success(res, 'Caja cerrada', caja);
    } catch (err) {
        if (err.code === 'PENDIENTES_ACTIVOS') {
            return Respuesta.error(res, err.message, err.statusCode || 409, {
                code: err.code,
                pendientes: err.pendientes,
            });
        }
        console.error('[Caja] Error cerrarCaja:', err.message);
        return Respuesta.error(res, 'Error al cerrar la caja.');
    }
}

/** GET /restaurante/caja/:id/movimientos */
async function getMovimientos(req, res) {
    try {
        const idCaja = Number(req.params.id);
        const movimientos = await CajaService.getMovimientos(idCaja);
        return Respuesta.success(res, 'Movimientos obtenidos', movimientos);
    } catch (err) {
        console.error('[Caja] Error getMovimientos:', err.message);
        return Respuesta.error(res, 'Error al obtener movimientos.');
    }
}

/** GET /restaurante/caja/domiciliarios?id_negocio=N */
async function getResumenDomiciliarios(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const resumen = await CajaService.getResumenDomiciliarios(idNegocio);
        return Respuesta.success(res, 'Resumen de domiciliarios obtenido', resumen);
    } catch (err) {
        console.error('[Caja] Error getResumenDomiciliarios:', err.message);
        return Respuesta.error(res, 'Error al obtener el resumen de domiciliarios.');
    }
}

/** POST /restaurante/caja/movimientos */
async function registrarMovimiento(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const { id_caja, tipo, monto, concepto } = req.body;
        const mov = await CajaService.registrarMovimiento({
            idCaja: Number(id_caja),
            tipo,
            monto: Number(monto),
            concepto,
            idUsuario: req.usuario.id_usuario,
        });
        return Respuesta.success(res, 'Movimiento registrado', mov, 201);
    } catch (err) {
        if (err.statusCode === 422) return Respuesta.error(res, err.message, 422);
        console.error('[Caja] Error registrarMovimiento:', err.message);
        return Respuesta.error(res, 'Error al registrar movimiento.');
    }
}

module.exports = {
    getCajaAbierta,
    abrirCaja,
    cerrarCaja,
    getMovimientos,
    getResumenDomiciliarios,
    registrarMovimiento,
};
