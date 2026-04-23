'use strict';
const { validationResult } = require('express-validator');
const MembresiaService = require('../services/membresiaService');
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
        const r = await MembresiaService.listar({
            idNegocio,
            idMiembro: req.query.id_miembro ? Number(req.query.id_miembro) : null,
            estado:    req.query.estado || null,
            page:      Number(req.query.page) || 1,
            pageSize:  Math.min(Number(req.query.page_size) || 50, 100),
        });
        return Respuesta.success(res, 'Membresías obtenidas', r);
    } catch (err) {
        console.error('[Gym/Membresias] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener membresías.');
    }
}

async function asignar(req, res) {
    if (!check(req, res)) return;
    try {
        const m = await MembresiaService.asignarOrenovar({
            idMiembro: Number(req.body.id_miembro),
            idPlan:    Number(req.body.id_plan),
            idNegocio: Number(req.body.id_negocio),
        });
        return Respuesta.success(res, 'Membresía asignada/renovada', m, 201);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Gym/Membresias] asignar:', err.message);
        return Respuesta.error(res, 'Error al asignar la membresía.');
    }
}

async function pausar(req, res) {
    try {
        const m = await MembresiaService.pausar({
            idMembresia: Number(req.params.id),
            idNegocio:   Number(req.body.id_negocio),
            hasta:       req.body.hasta || null,
        });
        if (!m) return Respuesta.error(res, 'Membresía no encontrada o no está activa', 404);
        return Respuesta.success(res, 'Membresía pausada', m);
    } catch (err) {
        console.error('[Gym/Membresias] pausar:', err.message);
        return Respuesta.error(res, 'Error al pausar la membresía.');
    }
}

async function reanudar(req, res) {
    try {
        const m = await MembresiaService.reanudar({
            idMembresia: Number(req.params.id),
            idNegocio:   Number(req.body.id_negocio),
        });
        if (!m) return Respuesta.error(res, 'Membresía no encontrada o no está pausada', 404);
        return Respuesta.success(res, 'Membresía reanudada', m);
    } catch (err) {
        console.error('[Gym/Membresias] reanudar:', err.message);
        return Respuesta.error(res, 'Error al reanudar la membresía.');
    }
}

async function cancelar(req, res) {
    try {
        const m = await MembresiaService.cancelar({
            idMembresia: Number(req.params.id),
            idNegocio:   Number(req.body.id_negocio),
        });
        if (!m) return Respuesta.error(res, 'Membresía no encontrada', 404);
        return Respuesta.success(res, 'Membresía cancelada', m);
    } catch (err) {
        console.error('[Gym/Membresias] cancelar:', err.message);
        return Respuesta.error(res, 'Error al cancelar la membresía.');
    }
}

module.exports = { listar, asignar, pausar, reanudar, cancelar };
