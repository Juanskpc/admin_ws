const { validationResult } = require('express-validator');

const PlanDao = require('../../app_core/dao/planDao');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * Listar todos los planes activos.
 */
async function getListaPlanes(req, res) {
    try {
        const planes = await PlanDao.getListaPlanes();
        return Respuesta.success(res, 'Planes obtenidos', planes);
    } catch (error) {
        console.error('Error en getListaPlanes:', error);
        return Respuesta.error(res, 'Error al obtener los planes');
    }
}

/**
 * Crear un nuevo plan.
 */
async function createPlan(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const { nombre, descripcion, precio, moneda } = req.body;
        const plan = await PlanDao.createPlan({ nombre, descripcion, precio, moneda });

        return Respuesta.success(res, 'Plan creado exitosamente', plan, 201);
    } catch (error) {
        console.error('Error en createPlan:', error);
        return Respuesta.error(res, 'Error al crear el plan');
    }
}

/**
 * Inactivar un plan (borrado lógico).
 */
async function inactivarPlan(req, res) {
    try {
        const { id } = req.params;
        const [filasAfectadas] = await PlanDao.inactivarPlan(id);

        if (filasAfectadas === 0) {
            return Respuesta.error(res, 'Plan no encontrado', 404);
        }

        return Respuesta.success(res, 'Plan inactivado exitosamente');
    } catch (error) {
        console.error('Error en inactivarPlan:', error);
        return Respuesta.error(res, 'Error al inactivar el plan');
    }
}

/**
 * Actualizar los datos de un plan.
 */
async function updatePlan(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const { id } = req.params;
        const datosActualizados = req.body;
        const [filasAfectadas] = await PlanDao.updatePlan({ id_plan: id, ...datosActualizados });

        if (filasAfectadas === 0) {
            return Respuesta.error(res, 'Plan no encontrado', 404);
        }

        return Respuesta.success(res, 'Plan actualizado exitosamente');
    } catch (error) {
        console.error('Error en updatePlan:', error);
        return Respuesta.error(res, 'Error al actualizar el plan');
    }
}

module.exports = { getListaPlanes, createPlan, inactivarPlan, updatePlan };
