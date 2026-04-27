'use strict';
const { validationResult } = require('express-validator');
const ProveedorService = require('../services/proveedorService');
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
        const r = await ProveedorService.listar({
            idNegocio,
            q:          req.query.q,
            soloActivos: req.query.incluir_inactivos !== 'true',
        });
        return Respuesta.success(res, 'Proveedores obtenidos', r);
    } catch (err) {
        console.error('[Tienda/Proveedores] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener proveedores.');
    }
}

async function getById(req, res) {
    try {
        const p = await ProveedorService.getById(Number(req.params.id), Number(req.query.id_negocio));
        if (!p) return Respuesta.error(res, 'Proveedor no encontrado', 404);
        return Respuesta.success(res, 'Proveedor obtenido', p);
    } catch (err) {
        console.error('[Tienda/Proveedores] getById:', err.message);
        return Respuesta.error(res, 'Error al obtener el proveedor.');
    }
}

async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const p = await ProveedorService.crear(req.body);
        return Respuesta.success(res, 'Proveedor creado', p, 201);
    } catch (err) {
        console.error('[Tienda/Proveedores] crear:', err.message);
        return Respuesta.error(res, 'Error al crear el proveedor.');
    }
}

async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const p = await ProveedorService.actualizar(Number(req.params.id), Number(req.body.id_negocio), req.body);
        if (!p) return Respuesta.error(res, 'Proveedor no encontrado', 404);
        return Respuesta.success(res, 'Proveedor actualizado', p);
    } catch (err) {
        console.error('[Tienda/Proveedores] actualizar:', err.message);
        return Respuesta.error(res, 'Error al actualizar el proveedor.');
    }
}

async function inactivar(req, res) {
    try {
        const p = await ProveedorService.inactivar(Number(req.params.id), Number(req.query.id_negocio));
        if (!p) return Respuesta.error(res, 'Proveedor no encontrado', 404);
        return Respuesta.success(res, 'Proveedor inactivado', p);
    } catch (err) {
        console.error('[Tienda/Proveedores] inactivar:', err.message);
        return Respuesta.error(res, 'Error al inactivar el proveedor.');
    }
}

module.exports = { listar, getById, crear, actualizar, inactivar };
