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
 * Listar los oficios que se pueden ofrecer, con el módulo que los atiende.
 *
 * Es PÚBLICA: la landing la necesita para pintar sus chips antes de que nadie tenga sesión.
 * No expone nada sensible — es el catálogo comercial, lo mismo que ya se ve en la página.
 */
async function getRubros(req, res) {
    try {
        const rubros = await TipoNegocioDao.getRubros();
        return Respuesta.success(res, 'Rubros obtenidos', rubros);
    } catch (error) {
        console.error('Error en getRubros:', error);
        return Respuesta.error(res, 'Error al obtener los rubros');
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

/**
 * Crear un nuevo tipo de negocio.
 * POST /admin/tipos-negocio
 */
async function createTipoNegocio(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const { nombre, descripcion, icono, color_hex } = req.body;
        const tipo = await TipoNegocioDao.createTipoNegocio({ nombre, descripcion, icono, color_hex });

        return Respuesta.success(res, 'Tipo de negocio creado exitosamente', tipo, 201);
    } catch (error) {
        if (error?.name === 'SequelizeUniqueConstraintError') {
            return Respuesta.error(res, 'Ya existe un tipo de negocio con ese nombre', 409);
        }
        console.error('Error en createTipoNegocio:', error);
        return Respuesta.error(res, 'Error al crear el tipo de negocio');
    }
}

module.exports = { getListaTiposNegocio, getRubros, getTipoNegocioById, createTipoNegocio };
