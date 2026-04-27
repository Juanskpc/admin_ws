'use strict';
const { validationResult } = require('express-validator');
const CategoriaService = require('../services/categoriaService');
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
        const r = await CategoriaService.listar({
            idNegocio,
            q: req.query.q,
            soloActivos: req.query.incluir_inactivos !== 'true',
        });
        return Respuesta.success(res, 'Categorías obtenidas', r);
    } catch (err) {
        console.error('[Tienda/Categorias] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener categorías.');
    }
}

async function getById(req, res) {
    try {
        const c = await CategoriaService.getById(Number(req.params.id), Number(req.query.id_negocio));
        if (!c) return Respuesta.error(res, 'Categoría no encontrada', 404);
        return Respuesta.success(res, 'Categoría obtenida', c);
    } catch (err) {
        console.error('[Tienda/Categorias] getById:', err.message);
        return Respuesta.error(res, 'Error al obtener la categoría.');
    }
}

async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const c = await CategoriaService.crear(req.body);
        return Respuesta.success(res, 'Categoría creada', c, 201);
    } catch (err) {
        if (err.parent?.code === '23505') return Respuesta.error(res, 'Ya existe una categoría con ese nombre en este negocio.', 409);
        console.error('[Tienda/Categorias] crear:', err.message);
        return Respuesta.error(res, 'Error al crear la categoría.');
    }
}

async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const c = await CategoriaService.actualizar(Number(req.params.id), Number(req.body.id_negocio), req.body);
        if (!c) return Respuesta.error(res, 'Categoría no encontrada', 404);
        return Respuesta.success(res, 'Categoría actualizada', c);
    } catch (err) {
        if (err.parent?.code === '23505') return Respuesta.error(res, 'Ya existe una categoría con ese nombre en este negocio.', 409);
        console.error('[Tienda/Categorias] actualizar:', err.message);
        return Respuesta.error(res, 'Error al actualizar la categoría.');
    }
}

async function inactivar(req, res) {
    try {
        const c = await CategoriaService.inactivar(Number(req.params.id), Number(req.query.id_negocio));
        if (!c) return Respuesta.error(res, 'Categoría no encontrada', 404);
        return Respuesta.success(res, 'Categoría inactivada', c);
    } catch (err) {
        console.error('[Tienda/Categorias] inactivar:', err.message);
        return Respuesta.error(res, 'Error al inactivar la categoría.');
    }
}

module.exports = { listar, getById, crear, actualizar, inactivar };
