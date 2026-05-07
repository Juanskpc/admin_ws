'use strict';
const { validationResult } = require('express-validator');
const ServicioService = require('../services/servicioService');
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
        const r = await ServicioService.listar({
            idNegocio,
            soloActivos: req.query.incluir_inactivos !== 'true',
        });
        return Respuesta.success(res, 'Servicios obtenidos', r);
    } catch (err) {
        console.error('[Reserva/Servicios] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener servicios.');
    }
}

async function getById(req, res) {
    try {
        const s = await ServicioService.getById(Number(req.params.id), Number(req.query.id_negocio));
        if (!s) return Respuesta.error(res, 'Servicio no encontrado', 404);
        return Respuesta.success(res, 'Servicio obtenido', s);
    } catch (err) {
        console.error('[Reserva/Servicios] getById:', err.message);
        return Respuesta.error(res, 'Error al obtener el servicio.');
    }
}

async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const s = await ServicioService.crear(req.body);
        return Respuesta.success(res, 'Servicio creado', s, 201);
    } catch (err) {
        console.error('[Reserva/Servicios] crear:', err.message);
        return Respuesta.error(res, 'Error al crear el servicio.');
    }
}

async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const s = await ServicioService.actualizar(Number(req.params.id), Number(req.body.id_negocio), req.body);
        if (!s) return Respuesta.error(res, 'Servicio no encontrado', 404);
        return Respuesta.success(res, 'Servicio actualizado', s);
    } catch (err) {
        console.error('[Reserva/Servicios] actualizar:', err.message);
        return Respuesta.error(res, 'Error al actualizar el servicio.');
    }
}

async function inactivar(req, res) {
    try {
        const s = await ServicioService.inactivar(Number(req.params.id), Number(req.query.id_negocio));
        if (!s) return Respuesta.error(res, 'Servicio no encontrado', 404);
        return Respuesta.success(res, 'Servicio inactivado', s);
    } catch (err) {
        console.error('[Reserva/Servicios] inactivar:', err.message);
        return Respuesta.error(res, 'Error al inactivar el servicio.');
    }
}

module.exports = { listar, getById, crear, actualizar, inactivar };
