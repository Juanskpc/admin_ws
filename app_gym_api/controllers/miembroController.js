'use strict';
const { validationResult } = require('express-validator');
const MiembroService = require('../services/miembroService');
const Respuesta = require('../../app_core/helpers/respuesta');

function checkValidation(req, res) {
    const errs = validationResult(req);
    if (!errs.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, errs.array()); return false; }
    return true;
}

async function listar(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const result = await MiembroService.listar({
            idNegocio,
            q: req.query.q,
            estado: req.query.estado,
            page: Number(req.query.page) || 1,
            pageSize: Math.min(Number(req.query.page_size) || 20, 100),
        });
        return Respuesta.success(res, 'Miembros obtenidos', result);
    } catch (err) {
        console.error('[Gym/Miembros] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener miembros.');
    }
}

async function getById(req, res) {
    try {
        const idMiembro = Number(req.params.id);
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const m = await MiembroService.getById(idMiembro, idNegocio);
        if (!m) return Respuesta.error(res, 'Miembro no encontrado', 404);
        return Respuesta.success(res, 'Miembro obtenido', m);
    } catch (err) {
        console.error('[Gym/Miembros] getById:', err.message);
        return Respuesta.error(res, 'Error al obtener el miembro.');
    }
}

async function getByQr(req, res) {
    try {
        const codigo = String(req.params.codigo);
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const m = await MiembroService.getByQr(codigo, idNegocio);
        if (!m) return Respuesta.error(res, 'Miembro no encontrado', 404);
        return Respuesta.success(res, 'Miembro obtenido', m);
    } catch (err) {
        console.error('[Gym/Miembros] getByQr:', err.message);
        return Respuesta.error(res, 'Error al obtener el miembro.');
    }
}

async function getByIdentificacion(req, res) {
    try {
        const num = String(req.params.num);
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const m = await MiembroService.getByIdentificacion(num, idNegocio);
        if (!m) return Respuesta.error(res, 'Miembro no encontrado', 404);
        return Respuesta.success(res, 'Miembro obtenido', m);
    } catch (err) {
        console.error('[Gym/Miembros] getByIdentificacion:', err.message);
        return Respuesta.error(res, 'Error al obtener el miembro.');
    }
}

async function crear(req, res) {
    if (!checkValidation(req, res)) return;
    try {
        const m = await MiembroService.crear(req.body);
        return Respuesta.success(res, 'Miembro creado', m, 201);
    } catch (err) {
        if (err.parent?.code === '23505') {
            return Respuesta.error(res, 'Código QR duplicado, intente nuevamente.', 409);
        }
        console.error('[Gym/Miembros] crear:', err.message);
        return Respuesta.error(res, 'Error al crear el miembro.');
    }
}

async function actualizar(req, res) {
    if (!checkValidation(req, res)) return;
    try {
        const idMiembro = Number(req.params.id);
        const idNegocio = Number(req.body.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const m = await MiembroService.actualizar(idMiembro, idNegocio, req.body);
        if (!m) return Respuesta.error(res, 'Miembro no encontrado', 404);
        return Respuesta.success(res, 'Miembro actualizado', m);
    } catch (err) {
        console.error('[Gym/Miembros] actualizar:', err.message);
        return Respuesta.error(res, 'Error al actualizar el miembro.');
    }
}

async function cambiarEstado(req, res) {
    try {
        const idMiembro = Number(req.params.id);
        const { id_negocio, estado } = req.body;
        if (!id_negocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const m = await MiembroService.cambiarEstado(idMiembro, Number(id_negocio), estado);
        if (!m) return Respuesta.error(res, 'Miembro no encontrado', 404);
        return Respuesta.success(res, 'Estado actualizado', m);
    } catch (err) {
        if (err.statusCode === 422) return Respuesta.error(res, err.message, 422);
        console.error('[Gym/Miembros] cambiarEstado:', err.message);
        return Respuesta.error(res, 'Error al cambiar el estado.');
    }
}

module.exports = { listar, getById, getByQr, getByIdentificacion, crear, actualizar, cambiarEstado };
