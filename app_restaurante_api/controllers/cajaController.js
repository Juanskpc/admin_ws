'use strict';
const { validationResult } = require('express-validator');
const CajaService = require('../services/cajaService');
const Respuesta = require('../../app_core/helpers/respuesta');
const Audit = require('../../app_core/helpers/auditHelper');
const { setAuditNegocio } = require('../../app_core/middleware/auditContext');

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
        setAuditNegocio(id_negocio);
        const caja = await CajaService.abrirCaja({
            idNegocio: id_negocio,
            idUsuario: req.usuario.id_usuario,
            montoApertura: Number(monto_apertura) || 0,
            observaciones,
        });
        await Audit.registrarEvento({
            modulo: 'caja', accion: 'caja_abierta', idNegocio: id_negocio,
            detalle: { id_caja: caja?.id_caja, monto_apertura: Number(monto_apertura) || 0 },
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

        setAuditNegocio(Number(id_negocio));
        const caja = await CajaService.cerrarCaja({
            idCaja,
            idNegocio: Number(id_negocio),
            montoReportado: monto_reportado,
            observaciones,
        });
        if (!caja) return Respuesta.error(res, 'Caja no encontrada o ya cerrada.', 404);
        await Audit.registrarEvento({
            modulo: 'caja', accion: 'caja_cerrada', idNegocio: Number(id_negocio),
            detalle: { id_caja: idCaja, monto_reportado },
        });
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
        console.log('idNegocio domiciliarios ----->', idNegocio);
        
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

/** POST /restaurante/caja/domiciliarios/transferir */
async function transferirDomiciliario(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const { id_negocio, id_domiciliario } = req.body;
        setAuditNegocio(Number(id_negocio));
        const result = await CajaService.transferirDomiciliarioACaja({
            idNegocio: Number(id_negocio),
            idDomiciliario: Number(id_domiciliario),
            idUsuario: req.usuario?.id_usuario,
        });
        await Audit.registrarEvento({
            modulo: 'caja', accion: 'domiciliario_transferido', idNegocio: Number(id_negocio),
            detalle: { id_domiciliario: Number(id_domiciliario) },
        });
        return Respuesta.success(res, 'Pedidos transferidos a caja', result);
    } catch (err) {
        console.error('[Caja] Error transferirDomiciliario:', err.message);
        return Respuesta.error(res, 'Error al transferir pedidos a caja.');
    }
}

/**
 * POST /restaurante/caja/ordenes/:id/anular
 * Elimina de la caja un pedido ya cobrado, sin borrar su historial.
 * El permiso `caja_eliminar_pedido` se vuelve a verificar en el servicio.
 */
async function anularPedido(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const idOrden = Number(req.params.id);
        const idNegocio = Number(req.body.id_negocio);
        setAuditNegocio(idNegocio);

        const result = await CajaService.anularOrdenCobrada({
            idNegocio,
            idOrden,
            idUsuario: req.usuario?.id_usuario,
        });

        await Audit.registrarEvento({
            modulo: 'caja', accion: 'pedido_anulado', idNegocio,
            detalle: {
                id_orden: idOrden,
                numero_orden: result.numero_orden,
                monto_revertido: result.monto_revertido,
                movimientos_revertidos: result.movimientos_revertidos,
            },
        });

        return Respuesta.success(res, 'Pedido eliminado de la caja', result);
    } catch (err) {
        if (['SIN_PERMISO_ANULAR', 'ORDEN_NO_ENCONTRADA', 'ORDEN_YA_ANULADA',
             'SIN_MOVIMIENTOS_EN_CAJA', 'CAJA_CERRADA'].includes(err.code)) {
            return Respuesta.error(res, err.message, err.statusCode || 409, { code: err.code });
        }
        console.error('[Caja] Error anularPedido:', err.message);
        return Respuesta.error(res, 'Error al eliminar el pedido de la caja.');
    }
}

/**
 * POST /restaurante/caja/movimientos/:id/anular
 * Devuelve a la caja un egreso (o un ingreso manual), dejándolo marcado.
 */
async function anularMovimiento(req, res) {
    if (!handleValidation(req, res)) return;
    try {
        const idMovimiento = Number(req.params.id);
        const idNegocio = Number(req.body.id_negocio);
        setAuditNegocio(idNegocio);

        const result = await CajaService.anularMovimientoCaja({
            idNegocio,
            idMovimiento,
            idUsuario: req.usuario?.id_usuario,
        });

        await Audit.registrarEvento({
            modulo: 'caja', accion: 'movimiento_anulado', idNegocio,
            detalle: {
                id_movimiento: idMovimiento,
                tipo: result.tipo,
                monto: result.monto,
                concepto: result.concepto,
            },
        });

        return Respuesta.success(res, 'Movimiento eliminado de la caja', result);
    } catch (err) {
        if (['SIN_PERMISO_ANULAR', 'MOVIMIENTO_NO_ENCONTRADO', 'MOVIMIENTO_ES_REVERSA',
             'USAR_ANULAR_PEDIDO', 'MOVIMIENTO_YA_ANULADO', 'CAJA_CERRADA'].includes(err.code)) {
            return Respuesta.error(res, err.message, err.statusCode || 409, { code: err.code });
        }
        console.error('[Caja] Error anularMovimiento:', err.message);
        return Respuesta.error(res, 'Error al eliminar el movimiento de la caja.');
    }
}

module.exports = {
    getCajaAbierta,
    abrirCaja,
    cerrarCaja,
    getMovimientos,
    getResumenDomiciliarios,
    registrarMovimiento,
    transferirDomiciliario,
    anularPedido,
    anularMovimiento,
};
