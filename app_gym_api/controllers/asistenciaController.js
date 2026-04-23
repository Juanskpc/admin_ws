'use strict';
const { validationResult } = require('express-validator');
const AsistenciaService = require('../services/asistenciaService');
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
        const r = await AsistenciaService.listar({
            idNegocio,
            idMiembro: req.query.id_miembro ? Number(req.query.id_miembro) : null,
            desde: req.query.desde, hasta: req.query.hasta,
            page: Number(req.query.page) || 1,
            pageSize: Math.min(Number(req.query.page_size) || 50, 100),
        });
        return Respuesta.success(res, 'Asistencias obtenidas', r);
    } catch (err) {
        console.error('[Gym/Asistencias] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener asistencias.');
    }
}

async function registrarEntrada(req, res) {
    if (!check(req, res)) return;
    try {
        const r = await AsistenciaService.registrarEntrada({
            idNegocio: Number(req.body.id_negocio),
            idMiembro: Number(req.body.id_miembro),
            metodo:    req.body.metodo || 'MANUAL',
        });
        return Respuesta.success(
            res,
            r.ya_estaba_dentro ? 'El miembro ya tenía una asistencia abierta' : 'Entrada registrada',
            r,
            201,
        );
    } catch (err) {
        if (err.statusCode) {
            return Respuesta.error(res, err.message, err.statusCode, err.code ? { code: err.code } : null);
        }
        console.error('[Gym/Asistencias] registrarEntrada:', err.message);
        return Respuesta.error(res, 'Error al registrar entrada.');
    }
}

async function registrarSalida(req, res) {
    try {
        const r = await AsistenciaService.registrarSalida({
            idAsistencia: req.params.id ? Number(req.params.id) : null,
            idMiembro:    req.body.id_miembro ? Number(req.body.id_miembro) : null,
            idNegocio:    Number(req.body.id_negocio),
        });
        if (!r) return Respuesta.error(res, 'Asistencia no encontrada o ya cerrada', 404);
        return Respuesta.success(res, 'Salida registrada', r);
    } catch (err) {
        console.error('[Gym/Asistencias] registrarSalida:', err.message);
        return Respuesta.error(res, 'Error al registrar salida.');
    }
}

module.exports = { listar, registrarEntrada, registrarSalida };
