'use strict';
const { validationResult } = require('express-validator');
const MovimientoService = require('../services/movimientoService');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

async function listar(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const r = await MovimientoService.listar({
            idNegocio,
            tipo:     req.query.tipo,
            desde:    req.query.desde,
            hasta:    req.query.hasta,
            page:     Number(req.query.page) || 1,
            pageSize: Math.min(Number(req.query.page_size) || 50, 100),
        });
        return Respuesta.success(res, 'Movimientos obtenidos', r);
    } catch (err) {
        console.error('[Tienda/Movimientos] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener movimientos.');
    }
}

async function getById(req, res) {
    try {
        const m = await MovimientoService.getById(Number(req.params.id), Number(req.query.id_negocio));
        if (!m) return Respuesta.error(res, 'Movimiento no encontrado', 404);
        return Respuesta.success(res, 'Movimiento obtenido', m);
    } catch (err) {
        console.error('[Tienda/Movimientos] getById:', err.message);
        return Respuesta.error(res, 'Error al obtener el movimiento.');
    }
}

async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const m = await MovimientoService.crear({
            idNegocio:   Number(req.body.id_negocio),
            tipo:        req.body.tipo,
            referencia:  req.body.referencia,
            observacion: req.body.observacion,
            idUsuario:   req.usuario?.id_usuario,
            items:       req.body.items,
        });
        return Respuesta.success(res, 'Movimiento creado', m, 201);
    } catch (err) {
        if (err.code === 'STOCK_INSUFICIENTE') {
            return Respuesta.error(res, err.message, err.statusCode || 409, {
                code: err.code, faltantes: err.faltantes || [],
            });
        }
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Tienda/Movimientos] crear:', err.message);
        return Respuesta.error(res, 'Error al crear el movimiento.');
    }
}

async function confirmar(req, res) {
    try {
        const m = await MovimientoService.confirmar(Number(req.params.id), Number(req.body.id_negocio));
        if (!m) return Respuesta.error(res, 'Movimiento no encontrado o no está en borrador', 404);
        return Respuesta.success(res, 'Movimiento confirmado', m);
    } catch (err) {
        console.error('[Tienda/Movimientos] confirmar:', err.message);
        return Respuesta.error(res, 'Error al confirmar el movimiento.');
    }
}

async function anular(req, res) {
    try {
        const m = await MovimientoService.anular(Number(req.params.id), Number(req.body.id_negocio));
        if (!m) return Respuesta.error(res, 'Movimiento no encontrado o ya anulado', 404);
        return Respuesta.success(res, 'Movimiento anulado', m);
    } catch (err) {
        console.error('[Tienda/Movimientos] anular:', err.message);
        return Respuesta.error(res, 'Error al anular el movimiento.');
    }
}

module.exports = { listar, getById, crear, confirmar, anular };
