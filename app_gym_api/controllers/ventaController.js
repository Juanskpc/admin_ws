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
            desde: req.query.desde, hasta: req.query.hasta,
            page: Number(req.query.page) || 1,
            pageSize: Math.min(Number(req.query.page_size) || 50, 100),
        });
        return Respuesta.success(res, 'Ventas obtenidas', r);
    } catch (err) {
        console.error('[Gym/Ventas] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener ventas.');
    }
}

async function registrar(req, res) {
    if (!check(req, res)) return;
    try {
        const v = await VentaService.registrar({
            idNegocio: Number(req.body.id_negocio),
            idMiembro: req.body.id_miembro ? Number(req.body.id_miembro) : null,
            idUsuarioCobro: req.usuario?.id_usuario,
            metodo: req.body.metodo,
            items: req.body.items,
        });
        return Respuesta.success(res, 'Venta registrada', v, 201);
    } catch (err) {
        if (err.code === 'STOCK_INSUFICIENTE') {
            return Respuesta.error(res, err.message, err.statusCode || 409, {
                code: err.code, faltantes: err.faltantes || [],
            });
        }
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Gym/Ventas] registrar:', err.message);
        return Respuesta.error(res, 'Error al registrar la venta.');
    }
}

async function anular(req, res) {
    try {
        const v = await VentaService.anular({
            idVenta: Number(req.params.id),
            idNegocio: Number(req.body.id_negocio),
        });
        if (!v) return Respuesta.error(res, 'Venta no encontrada o ya anulada', 404);
        return Respuesta.success(res, 'Venta anulada', v);
    } catch (err) {
        console.error('[Gym/Ventas] anular:', err.message);
        return Respuesta.error(res, 'Error al anular la venta.');
    }
}

module.exports = { listar, registrar, anular };
