'use strict';
const { validationResult } = require('express-validator');
const DisponibilidadService = require('../services/disponibilidadService');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * Disponibilidad para la **vista del negocio** (rutas autenticadas).
 *
 * Los mismos cálculos que expone el flujo público, pero bajo token y con `id_negocio` por
 * query en vez de por path. Existe porque la agenda interna venía consumiendo el endpoint
 * público: funcionaba, pero ataba una pantalla de gestión a un contrato pensado para el
 * enlace que se le manda al cliente final, y dejaba el multi-inquilino sin el
 * `exigirPertenenciaNegocio` que protege al resto del módulo.
 */

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

/** GET /reserva/disponibilidad?id_negocio&id_profesional&fecha&id_servicios=1,2 */
async function getSlots(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await DisponibilidadService.calcularSlots({
            idNegocio:     Number(req.query.id_negocio),
            idProfesional: Number(req.query.id_profesional),
            idServicios:   req.query.id_servicios,
            idServicio:    req.query.id_servicio ? Number(req.query.id_servicio) : undefined,
            fechaISO:      String(req.query.fecha),
        });
        return Respuesta.success(res, 'Slots calculados', data);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Disponibilidad] slots:', err.message);
        return Respuesta.error(res, 'Error al calcular disponibilidad.');
    }
}

/** GET /reserva/disponibilidad/dias?id_negocio&id_profesional&desde&hasta */
async function getDias(req, res) {
    if (!check(req, res)) return;
    try {
        const idProfesional = req.query.id_profesional && req.query.id_profesional !== 'null'
            ? Number(req.query.id_profesional)
            : null;
        const data = await DisponibilidadService.diasDisponibles({
            idNegocio: Number(req.query.id_negocio),
            idProfesional,
            desde: String(req.query.desde),
            hasta: String(req.query.hasta),
        });
        return Respuesta.success(res, 'Días calculados', data);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Disponibilidad] dias:', err.message);
        return Respuesta.error(res, 'Error al calcular los días disponibles.');
    }
}

module.exports = { getSlots, getDias };
