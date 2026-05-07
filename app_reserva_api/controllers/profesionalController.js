'use strict';
const { validationResult } = require('express-validator');
const ProfesionalService = require('../services/profesionalService');
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
        const r = await ProfesionalService.listar({
            idNegocio,
            idServicio:  req.query.id_servicio ? Number(req.query.id_servicio) : null,
            soloActivos: req.query.incluir_inactivos !== 'true',
        });
        return Respuesta.success(res, 'Profesionales obtenidos', r);
    } catch (err) {
        console.error('[Reserva/Profesionales] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener profesionales.');
    }
}

async function getById(req, res) {
    try {
        const p = await ProfesionalService.getById(Number(req.params.id), Number(req.query.id_negocio));
        if (!p) return Respuesta.error(res, 'Profesional no encontrado', 404);
        return Respuesta.success(res, 'Profesional obtenido', p);
    } catch (err) {
        console.error('[Reserva/Profesionales] getById:', err.message);
        return Respuesta.error(res, 'Error al obtener el profesional.');
    }
}

async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const p = await ProfesionalService.crear(req.body);
        return Respuesta.success(res, 'Profesional creado', p, 201);
    } catch (err) {
        console.error('[Reserva/Profesionales] crear:', err.message);
        return Respuesta.error(res, 'Error al crear el profesional.');
    }
}

async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const p = await ProfesionalService.actualizar(Number(req.params.id), Number(req.body.id_negocio), req.body);
        if (!p) return Respuesta.error(res, 'Profesional no encontrado', 404);
        return Respuesta.success(res, 'Profesional actualizado', p);
    } catch (err) {
        console.error('[Reserva/Profesionales] actualizar:', err.message);
        return Respuesta.error(res, 'Error al actualizar el profesional.');
    }
}

async function inactivar(req, res) {
    try {
        const p = await ProfesionalService.inactivar(Number(req.params.id), Number(req.query.id_negocio));
        if (!p) return Respuesta.error(res, 'Profesional no encontrado', 404);
        return Respuesta.success(res, 'Profesional inactivado', p);
    } catch (err) {
        console.error('[Reserva/Profesionales] inactivar:', err.message);
        return Respuesta.error(res, 'Error al inactivar el profesional.');
    }
}

async function setServicios(req, res) {
    if (!check(req, res)) return;
    try {
        const p = await ProfesionalService.setServicios(
            Number(req.params.id),
            Number(req.body.id_negocio),
            (req.body.id_servicios || []).map(Number),
        );
        if (!p) return Respuesta.error(res, 'Profesional no encontrado', 404);
        return Respuesta.success(res, 'Servicios actualizados', p);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Profesionales] setServicios:', err.message);
        return Respuesta.error(res, 'Error al asignar servicios.');
    }
}

module.exports = { listar, getById, crear, actualizar, inactivar, setServicios };
