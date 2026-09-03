'use strict';
const { validationResult } = require('express-validator');
const CategoriaService = require('../services/categoriaService');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

function fallo(res, err, contexto, porDefecto) {
    if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
    console.error(`[Reserva/Categorias] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

/** GET /reserva/categorias?id_negocio=N&incluir_inactivas= */
async function listar(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);
        const categorias = await CategoriaService.listar(idNegocio, {
            incluirInactivas: req.query.incluir_inactivas === 'true',
        });
        const conteo = await CategoriaService.conteoServicios(idNegocio);
        return Respuesta.success(res, 'Categorías', categorias.map(c => ({
            ...c.toJSON(),
            total_servicios: conteo.get(c.id_categoria) ?? 0,
        })));
    } catch (err) {
        return fallo(res, err, 'listar', 'Error al listar las categorías.');
    }
}

/** POST /reserva/categorias */
async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const cat = await CategoriaService.crear({
            idNegocio: Number(req.body.id_negocio),
            nombre: req.body.nombre,
            descripcion: req.body.descripcion,
        });
        return Respuesta.success(res, 'Categoría creada', cat, 201);
    } catch (err) {
        return fallo(res, err, 'crear', 'Error al crear la categoría.');
    }
}

/** PUT /reserva/categorias/:id */
async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const cat = await CategoriaService.actualizar(
            Number(req.params.id), Number(req.body.id_negocio), req.body);
        return Respuesta.success(res, 'Categoría actualizada', cat);
    } catch (err) {
        return fallo(res, err, 'actualizar', 'Error al actualizar la categoría.');
    }
}

/** PATCH /reserva/categorias/:id/inactivar?id_negocio=N */
async function inactivar(req, res) {
    if (!check(req, res)) return;
    try {
        const cat = await CategoriaService.inactivar(
            Number(req.params.id), Number(req.query.id_negocio));
        return Respuesta.success(res, 'Categoría eliminada. Sus servicios quedaron sin categoría.', cat);
    } catch (err) {
        return fallo(res, err, 'inactivar', 'Error al eliminar la categoría.');
    }
}

/** PUT /reserva/categorias/orden */
async function reordenar(req, res) {
    if (!check(req, res)) return;
    try {
        const cats = await CategoriaService.reordenar(
            Number(req.body.id_negocio), req.body.id_categorias);
        return Respuesta.success(res, 'Orden actualizado', cats);
    } catch (err) {
        return fallo(res, err, 'reordenar', 'Error al reordenar las categorías.');
    }
}

module.exports = { listar, crear, actualizar, inactivar, reordenar };
