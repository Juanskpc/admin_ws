'use strict';
const { validationResult } = require('express-validator');
const MetodoPagoService = require('../services/metodoPagoService');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

function fallo(res, err, contexto, porDefecto) {
    if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
    console.error(`[Reserva/MetodoPago] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

/** GET /reserva/metodos-pago?id_negocio=N[&incluir_inactivos=true] */
async function listar(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await MetodoPagoService.listar(Number(req.query.id_negocio), {
            incluirInactivos: req.query.incluir_inactivos === 'true',
        });
        return Respuesta.success(res, 'Formas de pago', data);
    } catch (err) {
        return fallo(res, err, 'listar', 'Error al obtener las formas de pago.');
    }
}

/** POST /reserva/metodos-pago */
async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const m = await MetodoPagoService.crear({
            idNegocio: Number(req.body.id_negocio),
            nombre: req.body.nombre,
            orden: req.body.orden != null ? Number(req.body.orden) : undefined,
        });
        return Respuesta.success(res, 'Forma de pago creada', m);
    } catch (err) {
        return fallo(res, err, 'crear', 'Error al crear la forma de pago.');
    }
}

/** PUT /reserva/metodos-pago/:id */
async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const m = await MetodoPagoService.actualizar({
            idMetodo: Number(req.params.id),
            idNegocio: Number(req.body.id_negocio),
            nombre: req.body.nombre,
            orden: req.body.orden != null ? Number(req.body.orden) : undefined,
        });
        if (!m) return Respuesta.error(res, 'Forma de pago no encontrada', 404);
        return Respuesta.success(res, 'Forma de pago actualizada', m);
    } catch (err) {
        return fallo(res, err, 'actualizar', 'Error al actualizar la forma de pago.');
    }
}

/**
 * PATCH /reserva/metodos-pago/:id/estado
 *
 * No hay DELETE a propósito: borrar una forma de pago dejaría sin referencia los cobros ya
 * hechos con ella y el desglose de una caja cerrada dejaría de cuadrar.
 */
async function cambiarEstado(req, res) {
    if (!check(req, res)) return;
    try {
        const m = await MetodoPagoService.cambiarEstado({
            idMetodo: Number(req.params.id),
            idNegocio: Number(req.body.id_negocio),
            estado: String(req.body.estado || '').toUpperCase(),
        });
        if (!m) return Respuesta.error(res, 'Forma de pago no encontrada', 404);
        return Respuesta.success(res, 'Estado actualizado', m);
    } catch (err) {
        return fallo(res, err, 'cambiarEstado', 'Error al cambiar el estado.');
    }
}

module.exports = { listar, crear, actualizar, cambiarEstado };
