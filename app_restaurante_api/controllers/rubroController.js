'use strict';
const { validationResult } = require('express-validator');

const Respuesta = require('../../app_core/helpers/respuesta');
const rubroService = require('../services/rubroService');

/**
 * Sectores de ingreso del restaurante (rubros).
 *
 * El negocio que no crea ninguno no ve nada nuevo: `GET /rubros` le devuelve una lista vacía y
 * el frontend esconde la pestaña de informes y el desglose del cierre de caja. Ver
 * `rubroService` para por qué esto no son las cajas.
 */

function validar(req, res) {
    const errores = validationResult(req);
    if (!errores.isEmpty()) {
        Respuesta.error(res, 'Parametros invalidos', 422, errores.array());
        return true;
    }
    return false;
}

function fallar(res, error, fallback) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) {
        console.error('[Restaurante][Rubros]', error);
    }
    return Respuesta.error(res, error?.message || fallback, status);
}

async function listar(req, res) {
    if (validar(req, res)) return;
    try {
        const data = await rubroService.listarAdmin({ idNegocio: Number(req.query.id_negocio) });
        return Respuesta.success(res, 'Sectores de ingreso', data);
    } catch (error) {
        return fallar(res, error, 'No se pudieron cargar los sectores de ingreso.');
    }
}

async function crear(req, res) {
    if (validar(req, res)) return;
    try {
        const rubro = await rubroService.crear({
            idNegocio: Number(req.body.id_negocio),
            idUsuario: req.usuario.id_usuario,
            nombre: req.body.nombre,
            descripcion: req.body.descripcion,
            color: req.body.color,
        });
        return Respuesta.success(res, 'Sector creado', rubro, 201);
    } catch (error) {
        return fallar(res, error, 'No se pudo crear el sector.');
    }
}

async function actualizar(req, res) {
    if (validar(req, res)) return;
    try {
        const rubro = await rubroService.actualizar({
            idRubro: Number(req.params.id_rubro),
            idNegocio: Number(req.body.id_negocio),
            idUsuario: req.usuario.id_usuario,
            nombre: req.body.nombre,
            descripcion: req.body.descripcion,
            color: req.body.color,
            estado: req.body.estado,
        });
        return Respuesta.success(res, 'Sector actualizado', rubro);
    } catch (error) {
        return fallar(res, error, 'No se pudo actualizar el sector.');
    }
}

async function fijarCategorias(req, res) {
    if (validar(req, res)) return;
    try {
        const data = await rubroService.fijarCategorias({
            idRubro: Number(req.params.id_rubro),
            idNegocio: Number(req.body.id_negocio),
            idUsuario: req.usuario.id_usuario,
            idsCategoria: req.body.id_categorias,
        });
        return Respuesta.success(res, 'Categorias del sector actualizadas', data);
    } catch (error) {
        return fallar(res, error, 'No se pudieron guardar las categorias del sector.');
    }
}

async function eliminar(req, res) {
    if (validar(req, res)) return;
    try {
        const data = await rubroService.eliminar({
            idRubro: Number(req.params.id_rubro),
            idNegocio: Number(req.query.id_negocio),
            idUsuario: req.usuario.id_usuario,
        });
        return Respuesta.success(res, 'Sector eliminado', data);
    } catch (error) {
        return fallar(res, error, 'No se pudo eliminar el sector.');
    }
}

module.exports = {
    listar,
    crear,
    actualizar,
    fijarCategorias,
    eliminar,
};
