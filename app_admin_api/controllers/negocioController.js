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

        const { nombre, nit, email_contacto, telefono, direccion, id_tipo_negocio } = req.body;
        const negocio = await NegocioDao.createNegocio({
            nombre, nit, email_contacto, telefono, direccion,
            ...(id_tipo_negocio ? { id_tipo_negocio: Number(id_tipo_negocio) } : {}),
        });

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
        const hasTipoQuery = Object.prototype.hasOwnProperty.call(req.query, 'id_tipo_negocio');

        let negocios;
        if (hasTipoQuery) {
            const idTipoNegocio = parseInt(req.query.id_tipo_negocio, 10);
            if (!idTipoNegocio || Number.isNaN(idTipoNegocio)) {
                return Respuesta.error(res, 'El parámetro id_tipo_negocio debe ser un número válido', 400);
            }
            negocios = await NegocioDao.getNegociosByUsuarioAndTipo(idUsuario, idTipoNegocio);
        } else {
            negocios = await NegocioDao.getNegociosByUsuario(idUsuario);
        }

        return Respuesta.success(res, 'Negocios del usuario obtenidos', negocios);
    } catch (error) {
        console.error('Error en getMisNegocios:', error);
        return Respuesta.error(res, 'Error al obtener los negocios del usuario');
    }
}

/**
 * Asigna o cambia el plan de un negocio.
 * PATCH /admin/negocios/:id/plan   body: { id_plan, meses? }
 */
async function cambiarPlan(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const idNegocio = Number(req.params.id);
        const { id_plan, meses, fecha_inicio, fecha_fin } = req.body;

        const row = await NegocioDao.asignarPlan(idNegocio, Number(id_plan), {
            meses: meses ? Number(meses) : 1,
            fechaInicio: fecha_inicio || null,
            fechaFin: fecha_fin || null,
        });

        return Respuesta.success(res, 'Plan asignado correctamente', {
            id_negocio_plan: row.id_negocio_plan,
        });
    } catch (error) {
        console.error('Error en cambiarPlan:', error);
        return Respuesta.error(
            res,
            error.message || 'Error al asignar el plan',
            error.statusCode || 500,
        );
    }
}

/**
 * Lista todos los negocios (gestión Super Admin) con tipo y plan.
 * GET /admin/negocios/admin
 */
async function getListaNegociosAdmin(req, res) {
    try {
        const negocios = await NegocioDao.getListaNegociosAdmin();
        return Respuesta.success(res, 'Negocios obtenidos', negocios);
    } catch (error) {
        console.error('Error en getListaNegociosAdmin:', error);
        return Respuesta.error(res, 'Error al obtener los negocios');
    }
}

/**
 * Actualiza un negocio.
 * PUT /admin/negocios/:id
 */
async function updateNegocio(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        await NegocioDao.updateNegocio(Number(req.params.id), req.body);
        return Respuesta.success(res, 'Negocio actualizado correctamente');
    } catch (error) {
        if (error?.name === 'SequelizeUniqueConstraintError') {
            return Respuesta.error(res, 'El NIT ya está en uso por otro negocio', 409);
        }
        console.error('Error en updateNegocio:', error);
        return Respuesta.error(res, error.message || 'Error al actualizar el negocio', error.statusCode || 500);
    }
}

/**
 * Activa o desactiva un negocio.
 * PATCH /admin/negocios/:id/estado
 */
async function setEstadoNegocio(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const estado = req.body.estado;
        const affected = await NegocioDao.setEstadoNegocio(Number(req.params.id), estado);
        if (!affected) {
            return Respuesta.error(res, 'Negocio no encontrado', 404);
        }
        return Respuesta.success(res, estado === 'A' ? 'Negocio activado' : 'Negocio desactivado');
    } catch (error) {
        console.error('Error en setEstadoNegocio:', error);
        return Respuesta.error(res, 'Error al cambiar el estado del negocio');
    }
}

/**
 * Registra un cliente: negocio + plan (opcional) + usuario administrador.
 * POST /admin/negocios/registrar-cliente
 */
async function registrarCliente(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const { negocio, plan, admin } = req.body;
        const adminNorm = { ...admin, email: String(admin.email).toLowerCase().trim() };

        const result = await NegocioDao.registrarCliente({ negocio, plan, admin: adminNorm });
        return Respuesta.success(res, 'Cliente registrado correctamente', result, 201);
    } catch (error) {
        if (error?.name === 'SequelizeUniqueConstraintError') {
            return Respuesta.error(res, 'Ya existe un registro con esos datos (NIT, email o identificación)', 409);
        }
        console.error('Error en registrarCliente:', error);
        return Respuesta.error(res, error.message || 'Error al registrar el cliente', error.statusCode || 500);
    }
}

module.exports = {
    getListaNegocios,
    getNegocioById,
    createNegocio,
    getMisNegocios,
    cambiarPlan,
    getListaNegociosAdmin,
    updateNegocio,
    setEstadoNegocio,
    registrarCliente,
};



