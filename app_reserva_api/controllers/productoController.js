'use strict';
const { validationResult } = require('express-validator');
const ProductoService = require('../services/productoService');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

function fallo(res, err, contexto, porDefecto) {
    if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode, err.code ? [{ code: err.code }] : null);
    console.error(`[Reserva/Productos] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

// ── Categorías ──

async function listarCategorias(req, res) {
    if (!check(req, res)) return;
    try {
        const categorias = await ProductoService.listarCategorias(Number(req.query.id_negocio), {
            incluirInactivas: req.query.incluir_inactivas === 'true',
        });
        return Respuesta.success(res, 'Categorías de productos', categorias);
    } catch (err) { return fallo(res, err, 'listarCategorias', 'Error al listar las categorías.'); }
}

async function crearCategoria(req, res) {
    if (!check(req, res)) return;
    try {
        const cat = await ProductoService.crearCategoria({
            idNegocio: Number(req.body.id_negocio), nombre: req.body.nombre, descripcion: req.body.descripcion,
        });
        return Respuesta.success(res, 'Categoría creada', cat, 201);
    } catch (err) { return fallo(res, err, 'crearCategoria', 'Error al crear la categoría.'); }
}

async function actualizarCategoria(req, res) {
    if (!check(req, res)) return;
    try {
        const cat = await ProductoService.actualizarCategoria(Number(req.params.id), Number(req.body.id_negocio), req.body);
        return Respuesta.success(res, 'Categoría actualizada', cat);
    } catch (err) { return fallo(res, err, 'actualizarCategoria', 'Error al actualizar la categoría.'); }
}

async function inactivarCategoria(req, res) {
    if (!check(req, res)) return;
    try {
        const cat = await ProductoService.inactivarCategoria(Number(req.params.id), Number(req.query.id_negocio));
        return Respuesta.success(res, 'Categoría eliminada. Sus productos quedaron sin categoría.', cat);
    } catch (err) { return fallo(res, err, 'inactivarCategoria', 'Error al eliminar la categoría.'); }
}

// ── Productos ──

async function listar(req, res) {
    if (!check(req, res)) return;
    try {
        const productos = await ProductoService.listar(Number(req.query.id_negocio), {
            incluirInactivos: req.query.incluir_inactivos === 'true',
        });
        return Respuesta.success(res, 'Productos', productos);
    } catch (err) { return fallo(res, err, 'listar', 'Error al listar los productos.'); }
}

async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const prod = await ProductoService.crear({
            idNegocio: Number(req.body.id_negocio),
            idCategoria: req.body.id_categoria ? Number(req.body.id_categoria) : null,
            nombre: req.body.nombre,
            descripcion: req.body.descripcion,
            precio: req.body.precio,
            controlaStock: req.body.controla_stock,
            stockActual: req.body.stock_actual,
            publicoActivo: req.body.publico_activo,
        });
        return Respuesta.success(res, 'Producto creado', prod, 201);
    } catch (err) { return fallo(res, err, 'crear', 'Error al crear el producto.'); }
}

async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const prod = await ProductoService.actualizar(Number(req.params.id), Number(req.body.id_negocio), {
            nombre: req.body.nombre,
            descripcion: req.body.descripcion,
            precio: req.body.precio,
            idCategoria: req.body.id_categoria !== undefined
                ? (req.body.id_categoria ? Number(req.body.id_categoria) : null) : undefined,
            controlaStock: req.body.controla_stock,
            stockActual: req.body.stock_actual,
            publicoActivo: req.body.publico_activo,
        });
        return Respuesta.success(res, 'Producto actualizado', prod);
    } catch (err) { return fallo(res, err, 'actualizar', 'Error al actualizar el producto.'); }
}

async function inactivar(req, res) {
    if (!check(req, res)) return;
    try {
        const prod = await ProductoService.inactivar(Number(req.params.id), Number(req.query.id_negocio));
        return Respuesta.success(res, 'Producto eliminado', prod);
    } catch (err) { return fallo(res, err, 'inactivar', 'Error al eliminar el producto.'); }
}

async function subirImagen(req, res) {
    if (!check(req, res)) return;
    try {
        if (!req.file) return Respuesta.error(res, 'No se recibió ninguna imagen.', 400);
        const data = await ProductoService.guardarImagen({
            idProducto: Number(req.params.id), idNegocio: Number(req.body.id_negocio),
            buffer: req.file.buffer, mimetype: req.file.mimetype,
        });
        return Respuesta.success(res, 'Imagen guardada', data);
    } catch (err) { return fallo(res, err, 'subirImagen', 'Error al guardar la imagen.'); }
}

async function eliminarImagen(req, res) {
    if (!check(req, res)) return;
    try {
        await ProductoService.eliminarImagen(Number(req.params.id), Number(req.query.id_negocio));
        return Respuesta.success(res, 'Imagen eliminada', null);
    } catch (err) { return fallo(res, err, 'eliminarImagen', 'Error al eliminar la imagen.'); }
}

module.exports = {
    listarCategorias, crearCategoria, actualizarCategoria, inactivarCategoria,
    listar, crear, actualizar, inactivar, subirImagen, eliminarImagen,
};
