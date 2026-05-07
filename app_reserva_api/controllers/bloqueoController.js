'use strict';
const { validationResult } = require('express-validator');
const BloqueoService = require('../services/bloqueoService');
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
        const idProfesional = req.query.id_profesional !== undefined
            ? (req.query.id_profesional === '' || req.query.id_profesional === 'null'
                ? null
                : Number(req.query.id_profesional))
            : undefined;
        const r = await BloqueoService.listar({
            idNegocio, idProfesional,
            desde: req.query.desde, hasta: req.query.hasta,
        });
        return Respuesta.success(res, 'Bloqueos obtenidos', r);
    } catch (err) {
        console.error('[Reserva/Bloqueos] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener bloqueos.');
    }
}

async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const b = await BloqueoService.crear({
            id_negocio:     Number(req.body.id_negocio),
            id_profesional: req.body.id_profesional == null ? null : Number(req.body.id_profesional),
            fecha_inicio:   new Date(req.body.fecha_inicio),
            fecha_fin:      new Date(req.body.fecha_fin),
            motivo:         req.body.motivo || null,
        });
        return Respuesta.success(res, 'Bloqueo creado', b, 201);
    } catch (err) {
        console.error('[Reserva/Bloqueos] crear:', err.message);
        return Respuesta.error(res, 'Error al crear el bloqueo.');
    }
}

async function eliminar(req, res) {
    try {
        const b = await BloqueoService.eliminar(Number(req.params.id), Number(req.query.id_negocio));
        if (!b) return Respuesta.error(res, 'Bloqueo no encontrado', 404);
        return Respuesta.success(res, 'Bloqueo eliminado');
    } catch (err) {
        console.error('[Reserva/Bloqueos] eliminar:', err.message);
        return Respuesta.error(res, 'Error al eliminar el bloqueo.');
    }
}

module.exports = { listar, crear, eliminar };
