const { param } = require('express-validator');
const { validationResult } = require('express-validator');

const TipoNegocioDao = require('../../app_core/dao/tipoNegocioDao');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * Listar todos los tipos de negocio activos.
 */
async function getListaTiposNegocio(req, res) {
    try {
        const tipos = await TipoNegocioDao.getListaTiposNegocio();
        return Respuesta.success(res, 'Tipos de negocio obtenidos', tipos);
    } catch (error) {
        console.error('Error en getListaTiposNegocio:', error);
        return Respuesta.error(res, 'Error al obtener los tipos de negocio');
    }
}

/**
 * Obtener un tipo de negocio por ID.
 */
async function getTipoNegocioById(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const { id } = req.params;
        const tipo = await TipoNegocioDao.getTipoNegocioById(id);

        if (!tipo) {
            return Respuesta.error(res, 'Tipo de negocio no encontrado', 404);
        }

        return Respuesta.success(res, 'Tipo de negocio obtenido', tipo);
    } catch (error) {
        console.error('Error en getTipoNegocioById:', error);
        return Respuesta.error(res, 'Error al obtener el tipo de negocio');
    }
}

module.exports = { getListaTiposNegocio, getTipoNegocioById };
