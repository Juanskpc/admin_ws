'use strict';
const { validationResult } = require('express-validator');
const VentaService = require('../services/ventaService');
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
        const r = await VentaService.listar({
            idNegocio,
            desde:     req.query.desde,
            hasta:     req.query.hasta,
            idCliente: req.query.id_cliente ? Number(req.query.id_cliente) : undefined,
            page:      Number(req.query.page) || 1,
            pageSize:  Math.min(Number(req.query.page_size) || 50, 100),
        });
        return Respuesta.success(res, 'Ventas obtenidas', r);
    } catch (err) {
        console.error('[Tienda/Ventas] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener ventas.');
    }
}

async function getById(req, res) {
    try {
        const v = await VentaService.getById(Number(req.params.id), Number(req.query.id_negocio));
        if (!v) return Respuesta.error(res, 'Venta no encontrada', 404);
        return Respuesta.success(res, 'Venta obtenida', v);
    } catch (err) {
        console.error('[Tienda/Ventas] getById:', err.message);
        return Respuesta.error(res, 'Error al obtener la venta.');
    }
}

async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const v = await VentaService.crear({
            idNegocio:       Number(req.body.id_negocio),
            idCliente:       req.body.id_cliente ? Number(req.body.id_cliente) : null,
            idUsuario:       req.usuario?.id_usuario,
            metodoPago:      req.body.metodo_pago,
            descuentoGlobal: req.body.descuento ? Number(req.body.descuento) : 0,
            notas:           req.body.notas,
            items:           req.body.items,
        });
        return Respuesta.success(res, 'Venta registrada', v, 201);
    } catch (err) {
        if (err.code === 'STOCK_INSUFICIENTE') {
            return Respuesta.error(res, err.message, err.statusCode || 409, {
                code: err.code, faltantes: err.faltantes || [],
            });
        }
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Tienda/Ventas] crear:', err.message);
        return Respuesta.error(res, 'Error al registrar la venta.');
    }
}

async function anular(req, res) {
    try {
        const v = await VentaService.anular({
            idVenta:   Number(req.params.id),
            idNegocio: Number(req.body.id_negocio),
        });
        if (!v) return Respuesta.error(res, 'Venta no encontrada o ya anulada', 404);
        return Respuesta.success(res, 'Venta anulada', v);
    } catch (err) {
        console.error('[Tienda/Ventas] anular:', err.message);
        return Respuesta.error(res, 'Error al anular la venta.');
    }
}

module.exports = { listar, getById, crear, anular };
