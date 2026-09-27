'use strict';
const { validationResult } = require('express-validator');
const Respuesta = require('../../app_core/helpers/respuesta');
const ServicioImagenService = require('../services/servicioImagenService');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

function fallo(res, err, contexto, porDefecto) {
    if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
    console.error(`[Reserva/ServicioGaleria] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

/** GET /reserva/servicios/:id/galeria */
async function listar(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await ServicioImagenService.listar(Number(req.query.id_negocio), Number(req.params.id));
        return Respuesta.success(res, 'Galería del servicio', data);
    } catch (err) {
        return fallo(res, err, 'listar', 'Error al obtener la galería.');
    }
}

/** POST /reserva/servicios/:id/galeria  (multipart) */
async function agregar(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await ServicioImagenService.agregar(
            Number(req.body.id_negocio), Number(req.params.id), req.file, req.body.descripcion,
        );
        return Respuesta.success(res, 'Foto agregada', data, 201);
    } catch (err) {
        return fallo(res, err, 'agregar', 'Error al subir la foto.');
    }
}

/** DELETE /reserva/servicios/galeria/:idImagen */
async function eliminar(req, res) {
    if (!check(req, res)) return;
    try {
        await ServicioImagenService.eliminar(Number(req.query.id_negocio), Number(req.params.idImagen));
        return Respuesta.success(res, 'Foto eliminada', null);
    } catch (err) {
        return fallo(res, err, 'eliminar', 'Error al eliminar la foto.');
    }
}

module.exports = { listar, agregar, eliminar };
