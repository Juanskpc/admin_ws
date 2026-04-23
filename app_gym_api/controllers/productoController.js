'use strict';
const { validationResult } = require('express-validator');
const ProductoService = require('../services/productoService');
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
        const r = await ProductoService.listar({
            idNegocio,
            q: req.query.q,
            categoria: req.query.categoria,
            page: Number(req.query.page) || 1,
            pageSize: Math.min(Number(req.query.page_size) || 50, 200),
            soloActivos: req.query.incluir_inactivos !== 'true',
        });
        return Respuesta.success(res, 'Productos obtenidos', r);
    } catch (err) {
        console.error('[Gym/Productos] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener productos.');
    }
}

async function getById(req, res) {
    try {
        const idProducto = Number(req.params.id);
        const idNegocio = Number(req.query.id_negocio);
        const p = await ProductoService.getById(idProducto, idNegocio);
        if (!p) return Respuesta.error(res, 'Producto no encontrado', 404);
        return Respuesta.success(res, 'Producto obtenido', p);
    } catch (err) {
        console.error('[Gym/Productos] getById:', err.message);
        return Respuesta.error(res, 'Error al obtener el producto.');
    }
}

async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const p = await ProductoService.crear(req.body);
        return Respuesta.success(res, 'Producto creado', p, 201);
    } catch (err) {
        if (err.parent?.code === '23505') return Respuesta.error(res, 'SKU ya existe en este negocio.', 409);
        console.error('[Gym/Productos] crear:', err.message);
        return Respuesta.error(res, 'Error al crear el producto.');
    }
}

async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const idProducto = Number(req.params.id);
        const idNegocio = Number(req.body.id_negocio);
        const p = await ProductoService.actualizar(idProducto, idNegocio, req.body);
        if (!p) return Respuesta.error(res, 'Producto no encontrado', 404);
        return Respuesta.success(res, 'Producto actualizado', p);
    } catch (err) {
        if (err.parent?.code === '23505') return Respuesta.error(res, 'SKU ya existe en este negocio.', 409);
        console.error('[Gym/Productos] actualizar:', err.message);
        return Respuesta.error(res, 'Error al actualizar el producto.');
    }
}

async function inactivar(req, res) {
    try {
        const idProducto = Number(req.params.id);
        const idNegocio = Number(req.query.id_negocio);
        const p = await ProductoService.inactivar(idProducto, idNegocio);
        if (!p) return Respuesta.error(res, 'Producto no encontrado', 404);
        return Respuesta.success(res, 'Producto inactivado', p);
    } catch (err) {
        console.error('[Gym/Productos] inactivar:', err.message);
        return Respuesta.error(res, 'Error al inactivar el producto.');
    }
}

async function ajustarStock(req, res) {
    try {
        const idProducto = Number(req.params.id);
        const idNegocio = Number(req.body.id_negocio);
        const delta = Number(req.body.delta);
        const p = await ProductoService.ajustarStock({ idProducto, idNegocio, delta });
        if (!p) return Respuesta.error(res, 'Producto no encontrado', 404);
        return Respuesta.success(res, 'Stock ajustado', p);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Gym/Productos] ajustarStock:', err.message);
        return Respuesta.error(res, 'Error al ajustar el stock.');
    }
}

module.exports = { listar, getById, crear, actualizar, inactivar, ajustarStock };
