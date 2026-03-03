const { validationResult } = require('express-validator');

const NegocioDao = require('../../app_core/dao/negocioDao');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * Listar todos los negocios activos.
 */
async function getListaNegocios(req, res) {
    try {
        const negocios = await NegocioDao.getListaNegocios();
        return Respuesta.success(res, 'Negocios obtenidos', negocios);
    } catch (error) {
        console.error('Error en getListaNegocios:', error);
        return Respuesta.error(res, 'Error al obtener los negocios');
    }
}

/**
 * Obtener un negocio específico por ID.
 */
async function getNegocioById(req, res) {
    try {
        const { id } = req.params;
        const negocio = await NegocioDao.getNegocioById(id);

        if (!negocio) {
            return Respuesta.error(res, 'Negocio no encontrado', 404);
        }

        return Respuesta.success(res, 'Negocio obtenido', negocio);
    } catch (error) {
        console.error('Error en getNegocioById:', error);
        return Respuesta.error(res, 'Error al obtener el negocio');
    }
}

/**
 * Crear un nuevo negocio.
 */
async function createNegocio(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const { nombre, nit, email_contacto, telefono } = req.body;
        const negocio = await NegocioDao.createNegocio({ nombre, nit, email_contacto, telefono });

        return Respuesta.success(res, 'Negocio creado exitosamente', negocio, 201);
    } catch (error) {
        console.error('Error en createNegocio:', error);
        return Respuesta.error(res, 'Error al crear el negocio');
    }
}

/**
 * Obtener los negocios del usuario autenticado filtrados por tipo.
 * GET /admin/mis-negocios?id_tipo_negocio=2
 */
async function getMisNegocios(req, res) {
    try {
        const idUsuario = req.usuario.id_usuario;
        const idTipoNegocio = parseInt(req.query.id_tipo_negocio, 10);

        if (!idTipoNegocio || isNaN(idTipoNegocio)) {
            return Respuesta.error(res, 'El parámetro id_tipo_negocio es requerido y debe ser un número', 400);
        }

        const negocios = await NegocioDao.getNegociosByUsuarioAndTipo(idUsuario, idTipoNegocio);
        return Respuesta.success(res, 'Negocios del usuario obtenidos', negocios);
    } catch (error) {
        console.error('Error en getMisNegocios:', error);
        return Respuesta.error(res, 'Error al obtener los negocios del usuario');
    }
}

module.exports = { getListaNegocios, getNegocioById, createNegocio, getMisNegocios };



