'use strict';
const { validationResult } = require('express-validator');
const HorarioService = require('../services/horarioService');
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
        const idUsuario = req.query.id_usuario !== undefined
            ? (req.query.id_usuario === '' || req.query.id_usuario === 'null'
                ? null
                : Number(req.query.id_usuario))
            : null;
        const r = await HorarioService.listar({ idNegocio, idUsuario });
        return Respuesta.success(res, 'Horarios obtenidos', r);
    } catch (err) {
        console.error('[Restaurante/Horarios] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener horarios.');
    }
}

async function reemplazar(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        const idUsuario = req.body.id_usuario == null ? null : Number(req.body.id_usuario);
        const r = await HorarioService.reemplazar({
            idNegocio, idUsuario,
            bloques: req.body.bloques || [],
        });
        return Respuesta.success(res, 'Horario actualizado', r);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Restaurante/Horarios] reemplazar:', err.message);
        return Respuesta.error(res, 'Error al actualizar el horario.');
    }
}

module.exports = { listar, reemplazar };
