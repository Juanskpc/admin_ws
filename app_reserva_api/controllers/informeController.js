'use strict';
const { validationResult } = require('express-validator');
const InformeService = require('../services/informeService');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

/** GET /reserva/informes?id_negocio&desde&hasta[&id_profesional] */
async function getInforme(req, res) {
    if (!check(req, res)) return;
    try {
        const idProfesional = req.query.id_profesional && req.query.id_profesional !== 'null'
            ? Number(req.query.id_profesional)
            : null;
        const data = await InformeService.getInforme({
            idNegocio: Number(req.query.id_negocio),
            desde: String(req.query.desde),
            hasta: String(req.query.hasta),
            idProfesional,
        });
        return Respuesta.success(res, 'Informe generado', data);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Informes] getInforme:', err.message);
        return Respuesta.error(res, 'Error al generar el informe.');
    }
}

module.exports = { getInforme };
