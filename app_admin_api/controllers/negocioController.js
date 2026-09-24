const { validationResult } = require('express-validator');

const NegocioDao = require('../../app_core/dao/negocioDao');
const planHelper = require('../../app_core/helpers/planHelper');
const Respuesta = require('../../app_core/helpers/respuesta');
const CicloVida = require('../services/negocioCicloVidaService');
const { featuresDeNegocios } = require('../../intelligence/core/features');
const { getUsoUsuarios } = require('../../app_core/helpers/cupoUsuarios');

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

        const { nombre, nit, email_contacto, telefono, direccion, id_tipo_negocio, id_rubro, pais } = req.body;
        const negocio = await NegocioDao.createNegocio({
            nombre, nit, email_contacto, telefono, direccion,
            ...(id_tipo_negocio ? { id_tipo_negocio: Number(id_tipo_negocio) } : {}),
            ...(id_rubro ? { id_rubro: Number(id_rubro) } : {}),
            ...(pais ? { pais: String(pais).toUpperCase() } : {}),
        });

        return Respuesta.success(res, 'Negocio creado exitosamente', negocio, 201);
    } catch (error) {
        // Los errores de dominio (tipo sin módulo, p. ej.) traen su propio código y estado: se
        // reenvían tal cual en lugar de convertirlos en un 500 mudo.
        console.error('Error en createNegocio:', error);
        return Respuesta.error(
            res,
            error.statusCode ? error.message : 'Error al crear el negocio',
            error.statusCode || 500,
        );
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

        // Cada negocio viaja con su plan: el dashboard avisa (vencido, en gracia, por iniciar)
        // antes de mandar al usuario a una app que lo iba a rechazar sin explicarle por qué.
        const ids = negocios.map((n) => n.id_negocio);
        const planMap = await planHelper.getPlanesActivosPorNegocio(ids);
        // `features` = nombres de FEATURE que el negocio tiene habilitadas (ADR-021). Los clientes
        // preguntan por esto y nunca por el nombre del plan.
        const featuresMap = await featuresDeNegocios(ids);
        const conPlan = negocios.map((n) => ({
            ...(typeof n.get === 'function' ? n.get({ plain: true }) : n),
            plan: planMap.get(n.id_negocio) || null,
            features: featuresMap.get(Number(n.id_negocio)) ?? [],
        }));

        return Respuesta.success(res, 'Negocios del usuario obtenidos', conPlan);
    } catch (error) {
        console.error('Error en getMisNegocios:', error);
        return Respuesta.error(res, 'Error al obtener los negocios del usuario');
    }
}

/**
 * Asigna o cambia el plan de un negocio.
 * PATCH /admin/negocios/:id/plan   body: { id_plan?, prueba?, meses?, fecha_inicio?, fecha_fin? }
 */
async function cambiarPlan(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const idNegocio = Number(req.params.id);
        const { id_plan, meses, fecha_inicio, fecha_fin, prueba } = req.body;

        const row = await NegocioDao.asignarPlan(idNegocio, id_plan ? Number(id_plan) : null, {
            meses: meses ? Number(meses) : 1,
            fechaInicio: fecha_inicio || null,
            fechaFin: fecha_fin || null,
            prueba: prueba === true || prueba === 'true',
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

        const { estado, motivo } = req.body;
        await CicloVida.cambiarEstado(Number(req.params.id), estado, motivo?.trim() || null);
        return Respuesta.success(res, estado === 'A' ? 'Negocio activado' : 'Negocio desactivado');
    } catch (error) {
        return responderError(res, error, 'setEstadoNegocio', 'Error al cambiar el estado del negocio');
    }
}

/**
 * Qué se llevaría por delante eliminar el negocio (no modifica nada).
 * GET /admin/negocios/:id/eliminacion
 */
async function getPrevisualizacionEliminacion(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const resumen = await CicloVida.previsualizarEliminacion(Number(req.params.id));
        return Respuesta.success(res, 'Resumen de la eliminación', resumen);
    } catch (error) {
        return responderError(res, error, 'getPrevisualizacionEliminacion', 'Error al calcular lo que se eliminaría');
    }
}

/**
 * Elimina un negocio con TODOS sus datos, en una sola transacción.
 * DELETE /admin/negocios/:id   body: { confirmacion: <nombre exacto del negocio> }
 *   400 CONFIRMACION_INVALIDA · 404 NEGOCIO_NO_ENCONTRADO · 500 NEGOCIO_ELIMINACION_FALLIDA (sin cambios)
 */
async function eliminarNegocio(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const eliminado = await CicloVida.eliminarNegocio(Number(req.params.id), req.body?.confirmacion);
        return Respuesta.success(res, `Negocio «${eliminado.nombre}» eliminado`, eliminado);
    } catch (error) {
        return responderError(res, error, 'eliminarNegocio', 'Error al eliminar el negocio');
    }
}

/**
 * Cuántos usuarios usa el negocio y cuántos le caben («X de Y usuarios»).
 * GET /admin/negocios/:id/cupo-usuarios   →   { usados, total|null, incluidos, adicionales, plan }
 */
async function getCupoUsuarios(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const uso = await getUsoUsuarios(Number(req.params.id));
        return Respuesta.success(res, 'Uso de usuarios del negocio', uso);
    } catch (error) {
        return responderError(res, error, 'getCupoUsuarios', 'Error al consultar el cupo de usuarios');
    }
}

/**
 * Historial de inactivaciones, reactivaciones y demás cambios de ciclo de vida.
 * GET /admin/negocios/:id/historial
 */
async function getHistorialNegocio(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const eventos = await CicloVida.historial(Number(req.params.id));
        return Respuesta.success(res, 'Historial del negocio', eventos);
    } catch (error) {
        return responderError(res, error, 'getHistorialNegocio', 'Error al obtener el historial del negocio');
    }
}

/** Los errores de dominio traen `.code` y `.statusCode` y se reenvían tal cual; el resto es un 500. */
function responderError(res, error, contexto, mensajePorDefecto) {
    if (error.statusCode && error.code) {
        return Respuesta.error(res, error.message, error.statusCode, null, {
            code: error.code,
            data: error.data,
        });
    }
    console.error(`Error en ${contexto}:`, error);
    return Respuesta.error(res, mensajePorDefecto);
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

        const { negocio, plan, admin, id_usuario_existente } = req.body;
        // El correo del administrador es opcional: el login va por identificación.
        const adminNorm = admin
            ? { ...admin, email: admin.email ? String(admin.email).toLowerCase().trim() : null }
            : null;

        const result = await NegocioDao.registrarCliente({
            negocio,
            plan,
            admin: adminNorm,
            id_usuario_existente: id_usuario_existente ? Number(id_usuario_existente) : null,
        });
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
    eliminarNegocio,
    getPrevisualizacionEliminacion,
    getCupoUsuarios,
    getHistorialNegocio,
    registrarCliente,
};



