'use strict';
const { validationResult } = require('express-validator');
const PagoService = require('../services/pagoService');
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
        const r = await PagoService.listar({
            idNegocio,
            idMiembro: req.query.id_miembro ? Number(req.query.id_miembro) : null,
            desde: req.query.desde, hasta: req.query.hasta,
            page: Number(req.query.page) || 1,
            pageSize: Math.min(Number(req.query.page_size) || 50, 100),
        });
        return Respuesta.success(res, 'Pagos obtenidos', r);
    } catch (err) {
        console.error('[Gym/Pagos] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener pagos.');
    }
}

async function registrar(req, res) {
    if (!check(req, res)) return;
    try {
        const p = await PagoService.registrar({
            idNegocio:    Number(req.body.id_negocio),
            idMiembro:    Number(req.body.id_miembro),
            idPlan:       req.body.id_plan ? Number(req.body.id_plan) : null,
            idMembresia:  req.body.id_membresia ? Number(req.body.id_membresia) : null,
            monto:        Number(req.body.monto),
            metodo:       req.body.metodo,
            concepto:     req.body.concepto || null,
            idUsuarioCobro: req.usuario?.id_usuario,
        });
        return Respuesta.success(res, 'Pago registrado', p, 201);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Gym/Pagos] registrar:', err.message);
        return Respuesta.error(res, 'Error al registrar el pago.');
    }
}

async function anular(req, res) {
    try {
        const p = await PagoService.anular({
            idPago:    Number(req.params.id),
            idNegocio: Number(req.body.id_negocio),
        });
        if (!p) return Respuesta.error(res, 'Pago no encontrado', 404);
        return Respuesta.success(res, 'Pago anulado', p);
    } catch (err) {
        console.error('[Gym/Pagos] anular:', err.message);
        return Respuesta.error(res, 'Error al anular el pago.');
    }
}

module.exports = { listar, registrar, anular };
