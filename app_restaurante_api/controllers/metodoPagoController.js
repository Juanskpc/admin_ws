'use strict';
const { validationResult } = require('express-validator');
const MetodoPagoService = require('../services/metodoPagoService');
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
        const incluirInactivos = req.query.incluir_inactivos === 'true';
        const r = await MetodoPagoService.listar(idNegocio, !incluirInactivos);
        return Respuesta.success(res, 'Métodos de pago obtenidos', r);
    } catch (err) {
        console.error('[Restaurante/MetodoPago] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener métodos de pago.');
    }
}

async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const m = await MetodoPagoService.crear({
            idNegocio: Number(req.body.id_negocio),
            nombre: req.body.nombre,
        });
        return Respuesta.success(res, 'Método de pago creado', m, 201);
    } catch (err) {
        if (err.parent?.code === '23505') {
            return Respuesta.error(res, 'Ya existe un método de pago con ese nombre.', 409);
        }
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Restaurante/MetodoPago] crear:', err.message);
        return Respuesta.error(res, 'Error al crear el método de pago.');
    }
}

async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const m = await MetodoPagoService.actualizar({
            idMetodo: Number(req.params.id),
            idNegocio: Number(req.body.id_negocio),
            nombre: req.body.nombre,
        });
        if (!m) return Respuesta.error(res, 'Método de pago no encontrado', 404);
        return Respuesta.success(res, 'Método de pago actualizado', m);
    } catch (err) {
        if (err.parent?.code === '23505') {
            return Respuesta.error(res, 'Ya existe un método de pago con ese nombre.', 409);
        }
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Restaurante/MetodoPago] actualizar:', err.message);
        return Respuesta.error(res, 'Error al actualizar el método de pago.');
    }
}

async function inactivar(req, res) {
    try {
        const m = await MetodoPagoService.inactivar({
            idMetodo: Number(req.params.id),
            idNegocio: Number(req.query.id_negocio),
        });
        if (!m) return Respuesta.error(res, 'Método de pago no encontrado', 404);
        return Respuesta.success(res, 'Método de pago inactivado', m);
    } catch (err) {
        console.error('[Restaurante/MetodoPago] inactivar:', err.message);
        return Respuesta.error(res, 'Error al inactivar el método de pago.');
    }
}

module.exports = { listar, crear, actualizar, inactivar };
