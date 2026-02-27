const { validationResult } = require('express-validator');

const RolDao = require('../../app_core/dao/rolDao');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * Listar todos los roles activos.
 * Query params opcionales: id_tipo_negocio (filtra por tipo de negocio)
 */
async function getListaRoles(req, res) {
    try {
        const { id_tipo_negocio } = req.query;
        const roles = await RolDao.getListaRoles(id_tipo_negocio || null);
        return Respuesta.success(res, 'Roles obtenidos', roles);
    } catch (error) {
        console.error('Error en getListaRoles:', error);
        return Respuesta.error(res, 'Error al obtener los roles');
    }
}

/**
 * Obtener un rol por ID con sus permisos.
 */
async function getRolById(req, res) {
    try {
        const { id } = req.params;
        const rol = await RolDao.getRolById(id);

        if (!rol) {
            return Respuesta.error(res, 'Rol no encontrado', 404);
        }

        return Respuesta.success(res, 'Rol obtenido', rol);
    } catch (error) {
        console.error('Error en getRolById:', error);
        return Respuesta.error(res, 'Error al obtener el rol');
    }
}

/**
 * Crear un nuevo rol.
 */
async function createRol(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const { descripcion, id_tipo_negocio } = req.body;
        const rol = await RolDao.createRol({ descripcion: descripcion.toUpperCase(), id_tipo_negocio });

        return Respuesta.success(res, 'Rol creado exitosamente', rol, 201);
    } catch (error) {
        console.error('Error en createRol:', error);
        return Respuesta.error(res, 'Error al crear el rol');
    }
}

/**
 * Inactivar un rol (cambiar estado a 'I').
 */
async function inactivarRol(req, res) {
    try {
        const { id } = req.params;
        const [affectedRows] = await RolDao.inactivarRol(id);

        if (affectedRows === 0) {
            return Respuesta.error(res, 'Rol no encontrado o ya está inactivo', 404);
        }

        return Respuesta.success(res, 'Rol inactivado exitosamente');
    } catch (error) {
        console.error('Error en inactivarRol:', error);
        return Respuesta.error(res, 'Error al inactivar el rol');
    }
}

module.exports = { getListaRoles, getRolById, createRol, inactivarRol };
