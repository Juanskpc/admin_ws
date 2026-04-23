'use strict';
const { validationResult } = require('express-validator');
const PlanService = require('../services/planService');
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
        const planes = await PlanService.listar(idNegocio, !incluirInactivos);
        return Respuesta.success(res, 'Planes obtenidos', planes);
    } catch (err) {
        console.error('[Gym/Planes] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener planes.');
    }
}

async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const p = await PlanService.crear(req.body);
        return Respuesta.success(res, 'Plan creado', p, 201);
    } catch (err) {
        console.error('[Gym/Planes] crear:', err.message);
        return Respuesta.error(res, 'Error al crear el plan.');
    }
}

async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const idPlan = Number(req.params.id);
        const idNegocio = Number(req.body.id_negocio);
        const p = await PlanService.actualizar(idPlan, idNegocio, req.body);
        if (!p) return Respuesta.error(res, 'Plan no encontrado', 404);
        return Respuesta.success(res, 'Plan actualizado', p);
    } catch (err) {
        console.error('[Gym/Planes] actualizar:', err.message);
        return Respuesta.error(res, 'Error al actualizar el plan.');
    }
}

async function inactivar(req, res) {
    try {
        const idPlan = Number(req.params.id);
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const p = await PlanService.inactivar(idPlan, idNegocio);
        if (!p) return Respuesta.error(res, 'Plan no encontrado', 404);
        return Respuesta.success(res, 'Plan inactivado', p);
    } catch (err) {
        console.error('[Gym/Planes] inactivar:', err.message);
        return Respuesta.error(res, 'Error al inactivar el plan.');
    }
}

module.exports = { listar, crear, actualizar, inactivar };
