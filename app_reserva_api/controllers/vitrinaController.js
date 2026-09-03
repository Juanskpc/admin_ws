'use strict';
const { validationResult } = require('express-validator');
const VitrinaService = require('../services/vitrinaService');
const Respuesta = require('../../app_core/helpers/respuesta');

/** Lado privado de la página pública: lo que el dueño edita desde Configuración. */

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

function fallo(res, err, contexto, porDefecto) {
    if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
    console.error(`[Reserva/Vitrina] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

/** GET /reserva/vitrina?id_negocio=N */
async function get(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await VitrinaService.getVitrinaEdicion(Number(req.query.id_negocio));
        return Respuesta.success(res, 'Datos de la página pública', data);
    } catch (err) {
        return fallo(res, err, 'get', 'Error al consultar la página pública.');
    }
}

/** PUT /reserva/vitrina */
async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await VitrinaService.guardarVitrina(Number(req.body.id_negocio), req.body);
        return Respuesta.success(res, 'Página pública actualizada', data);
    } catch (err) {
        return fallo(res, err, 'actualizar', 'Error al guardar la página pública.');
    }
}

module.exports = { get, actualizar };
