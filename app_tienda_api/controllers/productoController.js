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
            q:           req.query.q,
            id_categoria: req.query.id_categoria ? Number(req.query.id_categoria) : undefined,
            id_proveedor: req.query.id_proveedor ? Number(req.query.id_proveedor) : undefined,
            soloActivos:  req.query.incluir_inactivos !== 'true',
            stockBajo:    req.query.stock_bajo === 'true',
            page:         Number(req.query.page) || 1,
            pageSize:     Math.min(Number(req.query.page_size) || 50, 200),
        });
        return Respuesta.success(res, 'Productos obtenidos', r);
    } catch (err) {
        console.error('[Tienda/Productos] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener productos.');
    }
}

async function getById(req, res) {
    try {
        const p = await ProductoService.getById(Number(req.params.id), Number(req.query.id_negocio));
        if (!p) return Respuesta.error(res, 'Producto no encontrado', 404);
        return Respuesta.success(res, 'Producto obtenido', p);
    } catch (err) {
        console.error('[Tienda/Productos] getById:', err.message);
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
        console.error('[Tienda/Productos] crear:', err.message);
        return Respuesta.error(res, 'Error al crear el producto.');
    }
}

async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const p = await ProductoService.actualizar(Number(req.params.id), Number(req.body.id_negocio), req.body);
        if (!p) return Respuesta.error(res, 'Producto no encontrado', 404);
        return Respuesta.success(res, 'Producto actualizado', p);
    } catch (err) {
        if (err.parent?.code === '23505') return Respuesta.error(res, 'SKU ya existe en este negocio.', 409);
        console.error('[Tienda/Productos] actualizar:', err.message);
        return Respuesta.error(res, 'Error al actualizar el producto.');
    }
}

async function inactivar(req, res) {
    try {
        const p = await ProductoService.inactivar(Number(req.params.id), Number(req.query.id_negocio));
        if (!p) return Respuesta.error(res, 'Producto no encontrado', 404);
        return Respuesta.success(res, 'Producto inactivado', p);
    } catch (err) {
        console.error('[Tienda/Productos] inactivar:', err.message);
        return Respuesta.error(res, 'Error al inactivar el producto.');
    }
}

async function ajustarStock(req, res) {
    if (!check(req, res)) return;
    try {
        const p = await ProductoService.ajustarStock({
            idProducto: Number(req.params.id),
            idNegocio:  Number(req.body.id_negocio),
            delta:      Number(req.body.delta),
        });
        if (!p) return Respuesta.error(res, 'Producto no encontrado', 404);
        return Respuesta.success(res, 'Stock ajustado', p);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Tienda/Productos] ajustarStock:', err.message);
        return Respuesta.error(res, 'Error al ajustar el stock.');
    }
}

module.exports = { listar, getById, crear, actualizar, inactivar, ajustarStock };
