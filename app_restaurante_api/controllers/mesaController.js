const MesaService = require('../services/mesaService');
const Respuesta   = require('../../app_core/helpers/respuesta');
const { validationResult } = require('express-validator');

const ESTADOS_SERVICIO = ['DISPONIBLE', 'OCUPADA', 'POR_COBRAR'];

/** GET /mesas?id_negocio=N */
async function getMesas(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const mesas = await MesaService.getMesas(idNegocio);
        return Respuesta.success(res, 'Mesas obtenidas', mesas);
    } catch (err) {
        console.error('[Mesas] Error getMesas:', err.message);
        return Respuesta.error(res, 'Error al obtener las mesas.');
    }
}

/** GET /mesas/dashboard?id_negocio=N */
async function getMesasDashboard(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const mesas = await MesaService.getMesasDashboard(idNegocio);
        return Respuesta.success(res, 'Mesas dashboard obtenidas', mesas);
    } catch (err) {
        console.error('[Mesas] Error getMesasDashboard:', err.message);
        return Respuesta.error(res, 'Error al obtener el dashboard de mesas.');
    }
}

/** POST /mesas */
async function crearMesa(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos inválidos', 422, errors.array());
    }

    try {
        const { id_negocio, nombre, numero, capacidad } = req.body;
        const mesa = await MesaService.crearMesa({
            idNegocio: Number(id_negocio),
            nombre: String(nombre).trim(),
            numero: Number(numero),
            capacidad: capacidad ? Number(capacidad) : 4,
        });
        return Respuesta.success(res, 'Mesa creada', mesa, 201);
    } catch (err) {
        console.error('[Mesas] Error crearMesa:', err.message);
        return Respuesta.error(res, 'No se pudo crear la mesa.');
    }
}

/** PUT /mesas/:id */
async function editarMesa(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos inválidos', 422, errors.array());
    }

    try {
        const idMesa = Number(req.params.id);
        const { nombre, numero, capacidad } = req.body;
        const mesa = await MesaService.actualizarMesa(idMesa, {
            nombre: nombre ? String(nombre).trim() : undefined,
            numero: numero ? Number(numero) : undefined,
            capacidad: capacidad ? Number(capacidad) : undefined,
        });
        if (!mesa) return Respuesta.error(res, 'Mesa no encontrada', 404);
        return Respuesta.success(res, 'Mesa actualizada', mesa);
    } catch (err) {
        console.error('[Mesas] Error editarMesa:', err.message);
        return Respuesta.error(res, 'No se pudo actualizar la mesa.');
    }
}

/** PATCH /mesas/:id/estado */
async function cambiarEstado(req, res) {
    try {
        const idMesa = Number(req.params.id);
        const { estado } = req.body;
        if (!['A', 'I'].includes(estado)) {
            return Respuesta.error(res, 'Estado inválido', 422);
        }

        const mesa = await MesaService.setMesaEstado(idMesa, estado);
        if (!mesa) return Respuesta.error(res, 'Mesa no encontrada', 404);
        return Respuesta.success(res, 'Estado de mesa actualizado', mesa);
    } catch (err) {
        console.error('[Mesas] Error cambiarEstado:', err.message);
        return Respuesta.error(res, 'No se pudo cambiar el estado de la mesa.');
    }
}

/** PATCH /mesas/:id/estado-servicio */
async function cambiarEstadoServicio(req, res) {
    try {
        const idMesa = Number(req.params.id);
        const { estado_servicio } = req.body;
        if (!ESTADOS_SERVICIO.includes(estado_servicio)) {
            return Respuesta.error(res, 'estado_servicio inválido', 422);
        }

        const mesa = await MesaService.setMesaEstadoServicio(idMesa, estado_servicio);
        if (!mesa) return Respuesta.error(res, 'Mesa no encontrada', 404);
        return Respuesta.success(res, 'Estado de servicio actualizado', mesa);
    } catch (err) {
        console.error('[Mesas] Error cambiarEstadoServicio:', err.message);
        return Respuesta.error(res, 'No se pudo cambiar estado de servicio.');
    }
}

/** PATCH /mesas/:id/liberar */
async function liberarMesa(req, res) {
    try {
        const idMesa = Number(req.params.id);
        const mesa = await MesaService.liberarMesa(idMesa);
        if (!mesa) return Respuesta.error(res, 'Mesa no encontrada', 404);
        return Respuesta.success(res, 'Mesa liberada', mesa);
    } catch (err) {
        if (err?.statusCode === 409 || err?.code === 'MESA_NO_COBRADA') {
            return Respuesta.error(res, err.message || 'La mesa tiene una cuenta pendiente de cobro.', 409);
        }
        console.error('[Mesas] Error liberarMesa:', err.message);
        return Respuesta.error(res, 'No se pudo liberar la mesa.');
    }
}

module.exports = {
    getMesas,
    getMesasDashboard,
    crearMesa,
    editarMesa,
    cambiarEstado,
    cambiarEstadoServicio,
    liberarMesa,
};
