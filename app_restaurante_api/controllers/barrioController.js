'use strict';
const { validationResult } = require('express-validator');
const BarrioService = require('../services/barrioService');
const Respuesta = require('../../app_core/helpers/respuesta');

function invalido(req, res) {
    const e = validationResult(req);
    if (e.isEmpty()) return false;
    Respuesta.error(res, 'Datos de entrada invalidos', 400, e.array());
    return true;
}

function fallo(res, err, etiqueta) {
    if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode, [{ code: err.code }]);
    console.error(`[Restaurante/Barrios] ${etiqueta}:`, err.message);
    return Respuesta.error(res, 'Error al procesar los barrios.');
}

function idNegocioDe(req) {
    return req.query.id_negocio ? Number(req.query.id_negocio) : null;
}

async function listar(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await BarrioService.listar(req.usuario.id_usuario, idNegocioDe(req));
        return Respuesta.success(res, 'Barrios obtenidos', data);
    } catch (err) { return fallo(res, err, 'listar'); }
}

async function crear(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await BarrioService.crear(req.usuario.id_usuario, req.body);
        return Respuesta.success(res, 'Barrio creado', data, 201);
    } catch (err) { return fallo(res, err, 'crear'); }
}

async function editar(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await BarrioService.editar(req.usuario.id_usuario, Number(req.params.id), req.body);
        return Respuesta.success(res, 'Barrio actualizado', data);
    } catch (err) { return fallo(res, err, 'editar'); }
}

async function eliminar(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await BarrioService.eliminar(
            req.usuario.id_usuario, Number(req.params.id), idNegocioDe(req),
        );
        return Respuesta.success(res, 'Barrio eliminado', data);
    } catch (err) { return fallo(res, err, 'eliminar'); }
}

module.exports = { listar, crear, editar, eliminar };
