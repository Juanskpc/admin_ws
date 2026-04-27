'use strict';
const { validationResult } = require('express-validator');
const ClienteService = require('../services/clienteService');
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
        const r = await ClienteService.listar({
            idNegocio,
            q:          req.query.q,
            soloActivos: req.query.incluir_inactivos !== 'true',
        });
        return Respuesta.success(res, 'Clientes obtenidos', r);
    } catch (err) {
        console.error('[Tienda/Clientes] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener clientes.');
    }
}

async function getById(req, res) {
    try {
        const c = await ClienteService.getById(Number(req.params.id), Number(req.query.id_negocio));
        if (!c) return Respuesta.error(res, 'Cliente no encontrado', 404);
        return Respuesta.success(res, 'Cliente obtenido', c);
    } catch (err) {
        console.error('[Tienda/Clientes] getById:', err.message);
        return Respuesta.error(res, 'Error al obtener el cliente.');
    }
}

async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const c = await ClienteService.crear(req.body);
        return Respuesta.success(res, 'Cliente creado', c, 201);
    } catch (err) {
        console.error('[Tienda/Clientes] crear:', err.message);
        return Respuesta.error(res, 'Error al crear el cliente.');
    }
}

async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const c = await ClienteService.actualizar(Number(req.params.id), Number(req.body.id_negocio), req.body);
        if (!c) return Respuesta.error(res, 'Cliente no encontrado', 404);
        return Respuesta.success(res, 'Cliente actualizado', c);
    } catch (err) {
        console.error('[Tienda/Clientes] actualizar:', err.message);
        return Respuesta.error(res, 'Error al actualizar el cliente.');
    }
}

module.exports = { listar, getById, crear, actualizar };
