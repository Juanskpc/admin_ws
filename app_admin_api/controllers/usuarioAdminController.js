const { body, param, query, validationResult } = require('express-validator');

const UsuarioAdminDao = require('../../app_core/dao/usuarioAdminDao');
const Respuesta = require('../../app_core/helpers/respuesta');
const { initTransaction } = require('../../app_core/helpers/funcionesAdicionales');

const usuarioAdminValidators = {
    list: [
        query('search').optional().isString(),
        query('id_rol').optional().isInt({ min: 1 }),
        query('estado').optional().isIn(['A', 'I', 'ALL']),
    ],
    create: [
        body('primer_nombre').trim().notEmpty().isLength({ max: 100 }),
        body('primer_apellido').trim().notEmpty().isLength({ max: 100 }),
        body('num_identificacion').trim().notEmpty().isLength({ max: 50 }),
        body('email').isEmail().normalizeEmail(),
        body('password').isLength({ min: 8 }),
        body('id_rol').isInt({ min: 1 }),
        body('id_negocio').optional({ nullable: true }).isInt({ min: 1 }),
        body('estado').optional().isIn(['A', 'I']),
        body('es_admin_principal').optional().isBoolean(),
    ],
    update: [
        param('id').isInt({ min: 1 }),
        body('primer_nombre').trim().notEmpty().isLength({ max: 100 }),
        body('primer_apellido').trim().notEmpty().isLength({ max: 100 }),
        body('num_identificacion').trim().notEmpty().isLength({ max: 50 }),
        body('email').isEmail().normalizeEmail(),
        body('password').optional({ nullable: true }).isLength({ min: 8 }),
        body('id_rol').isInt({ min: 1 }),
        body('id_negocio').optional({ nullable: true }).isInt({ min: 1 }),
        body('estado').isIn(['A', 'I']),
        body('es_admin_principal').optional().isBoolean(),
    ],
    setEstado: [
        param('id').isInt({ min: 1 }),
        body('estado').isIn(['A', 'I']),
    ],
    remove: [
        param('id').isInt({ min: 1 }),
    ],
    getPermisosUsuario: [
        param('id').isInt({ min: 1 }),
    ],
    getPermisosRol: [
        param('id').isInt({ min: 1 }),
    ],
    savePermisosRol: [
        param('id').isInt({ min: 1 }),
        body('modulos').isArray({ min: 1 }),
        body('modulos.*.id_nivel').isInt({ min: 1 }),
        body('modulos.*.puede_ver').isBoolean(),
        body('modulos.*.puede_crear').isBoolean(),
        body('modulos.*.puede_editar').isBoolean(),
        body('modulos.*.puede_eliminar').isBoolean(),
    ],
};

function getValidationErrors(req, res) {
    const errors = validationResult(req);
    if (errors.isEmpty()) return null;
    return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
}

function esRolAdministrador(rol) {
    return UsuarioAdminDao.isAdminRoleName(rol?.descripcion || '');
}

async function validarReglaAdministradoresActivos(usuarioActual, payload, res) {
    const rolNuevo = (await UsuarioAdminDao.getRolesActivos()).find((r) => r.id_rol === Number(payload.id_rol));

    const eraAdmin = esRolAdministrador(usuarioActual.rol_principal);
    const seraAdmin = esRolAdministrador(rolNuevo);

    const seguiraActivo = payload.estado === 'A';
    const dejaSerAdminActivo = eraAdmin && (!seraAdmin || !seguiraActivo);

    if (!dejaSerAdminActivo) return false;

    const adminsActivos = await UsuarioAdminDao.countAdminsActivos(usuarioActual.id_usuario);
    if (adminsActivos <= 0) {
        Respuesta.error(res, 'No puedes dejar el sistema sin administradores activos.', 409);
        return true;
    }

    return false;
}

async function listUsuarios(req, res) {
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const estado = req.query.estado === 'ALL' ? null : req.query.estado;
        const usuarios = await UsuarioAdminDao.getUsuarios({
            search: req.query.search || '',
            idRol: req.query.id_rol || null,
            estado,
        });

        return Respuesta.success(res, 'Usuarios obtenidos', usuarios);
    } catch (error) {
        console.error('Error en listUsuarios:', error);
        return Respuesta.error(res, 'Error al consultar usuarios');
    }
}

async function getRoles(req, res) {
    try {
        const roles = await UsuarioAdminDao.getRolesActivos();
        return Respuesta.success(res, 'Roles obtenidos', roles);
    } catch (error) {
        console.error('Error en getRoles:', error);
        return Respuesta.error(res, 'Error al consultar roles');
    }
}

async function createUsuario(req, res) {
    let transaction;
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const payload = {
            ...req.body,
            email: req.body.email.toLowerCase().trim(),
            estado: req.body.estado || 'A',
            es_admin_principal: Boolean(req.body.es_admin_principal),
        };

        const existe = await UsuarioAdminDao.findUsuarioDuplicado({
            email: payload.email,
            num_identificacion: payload.num_identificacion,
        });

        if (existe) {
            const campo = existe.email === payload.email ? 'email' : 'número de identificación';
            return Respuesta.error(res, `Ya existe un usuario con ese ${campo}`, 409);
        }

        transaction = await initTransaction();
        const idUsuario = await UsuarioAdminDao.createUsuario(payload, transaction);
        await transaction.commit();

        return Respuesta.success(res, 'Usuario creado correctamente', { id_usuario: idUsuario }, 201);
    } catch (error) {
        if (transaction) await transaction.rollback();
        console.error('Error en createUsuario:', error);
        return Respuesta.error(res, 'Error al crear el usuario');
    }
}

async function updateUsuario(req, res) {
    let transaction;
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idUsuario = Number(req.params.id);
        const usuarioActual = await UsuarioAdminDao.getUsuarioById(idUsuario);

        if (!usuarioActual) {
            return Respuesta.error(res, 'Usuario no encontrado', 404);
        }

        const payload = {
            ...req.body,
            email: req.body.email.toLowerCase().trim(),
            es_admin_principal: Boolean(req.body.es_admin_principal),
        };

        const duplicado = await UsuarioAdminDao.findUsuarioDuplicado({
            email: payload.email,
            num_identificacion: payload.num_identificacion,
            excludeId: idUsuario,
        });

        if (duplicado) {
            const campo = duplicado.email === payload.email ? 'email' : 'número de identificación';
            return Respuesta.error(res, `Ya existe un usuario con ese ${campo}`, 409);
        }

        if (usuarioActual.es_admin_principal && payload.estado === 'I') {
            return Respuesta.error(res, 'No se puede desactivar el administrador principal.', 409);
        }

        const bloqueado = await validarReglaAdministradoresActivos(usuarioActual, payload, res);
        if (bloqueado) return;

        transaction = await initTransaction();
        await UsuarioAdminDao.updateUsuario(idUsuario, payload, transaction);
        await transaction.commit();

        return Respuesta.success(res, 'Usuario actualizado correctamente');
    } catch (error) {
        if (transaction) await transaction.rollback();
        console.error('Error en updateUsuario:', error);
        return Respuesta.error(res, 'Error al actualizar el usuario');
    }
}

async function setEstadoUsuario(req, res) {
    let transaction;
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idUsuario = Number(req.params.id);
        const estado = req.body.estado;

        const usuario = await UsuarioAdminDao.getUsuarioById(idUsuario);
        if (!usuario) {
            return Respuesta.error(res, 'Usuario no encontrado', 404);
        }

        if (usuario.es_admin_principal && estado === 'I') {
            return Respuesta.error(res, 'No se puede desactivar el administrador principal.', 409);
        }

        if (estado === 'I') {
            const adminsActivos = await UsuarioAdminDao.countAdminsActivos(idUsuario);
            const esAdmin = esRolAdministrador(usuario.rol_principal);

            if (esAdmin && adminsActivos <= 0) {
                return Respuesta.error(res, 'No puedes desactivar el último administrador activo.', 409);
            }
        }

        transaction = await initTransaction();
        await UsuarioAdminDao.updateEstadoUsuario(idUsuario, estado, transaction);
        await transaction.commit();

        return Respuesta.success(res, 'Estado del usuario actualizado');
    } catch (error) {
        if (transaction) await transaction.rollback();
        console.error('Error en setEstadoUsuario:', error);
        return Respuesta.error(res, 'Error al actualizar estado del usuario');
    }
}

async function deleteUsuario(req, res) {
    let transaction;
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idUsuario = Number(req.params.id);
        const usuario = await UsuarioAdminDao.getUsuarioById(idUsuario);

        if (!usuario) {
            return Respuesta.error(res, 'Usuario no encontrado', 404);
        }

        if (usuario.es_admin_principal) {
            return Respuesta.error(res, 'No se puede eliminar el administrador principal.', 409);
        }

        const esAdmin = esRolAdministrador(usuario.rol_principal);
        const adminsActivos = await UsuarioAdminDao.countAdminsActivos(idUsuario);

        if (esAdmin && adminsActivos <= 0) {
            return Respuesta.error(res, 'No puedes eliminar el último administrador activo.', 409);
        }

        transaction = await initTransaction();
        await UsuarioAdminDao.softDeleteUsuario(idUsuario, transaction);
        await transaction.commit();

        return Respuesta.success(res, 'Usuario eliminado correctamente');
    } catch (error) {
        if (transaction) await transaction.rollback();
        console.error('Error en deleteUsuario:', error);
        return Respuesta.error(res, 'Error al eliminar usuario');
    }
}

async function getPermisosUsuario(req, res) {
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idUsuario = Number(req.params.id);
        const result = await UsuarioAdminDao.getPermisosEfectivosUsuario(idUsuario);

        if (!result) {
            return Respuesta.error(res, 'Usuario no encontrado', 404);
        }

        return Respuesta.success(res, 'Permisos del usuario obtenidos', result);
    } catch (error) {
        console.error('Error en getPermisosUsuario:', error);
        return Respuesta.error(res, 'Error al consultar permisos del usuario');
    }
}

async function getPermisosRol(req, res) {
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idRol = Number(req.params.id);
        const result = await UsuarioAdminDao.getPermisosMatrizRol(idRol);

        if (!result) {
            return Respuesta.error(res, 'Rol no encontrado', 404);
        }

        return Respuesta.success(res, 'Matriz de permisos obtenida', result);
    } catch (error) {
        console.error('Error en getPermisosRol:', error);
        return Respuesta.error(res, 'Error al consultar matriz de permisos');
    }
}

async function savePermisosRol(req, res) {
    let transaction;
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idRol = Number(req.params.id);
        const payload = req.body.modulos;

        const matriz = await UsuarioAdminDao.getPermisosMatrizRol(idRol);
        if (!matriz) {
            return Respuesta.error(res, 'Rol no encontrado', 404);
        }

        transaction = await initTransaction();
        await UsuarioAdminDao.savePermisosRol(idRol, payload, transaction);
        await transaction.commit();

        return Respuesta.success(res, 'Permisos del rol actualizados correctamente');
    } catch (error) {
        if (transaction) await transaction.rollback();
        console.error('Error en savePermisosRol:', error);
        return Respuesta.error(res, 'Error al guardar permisos del rol');
    }
}

module.exports = {
    usuarioAdminValidators,
    listUsuarios,
    getRoles,
    createUsuario,
    updateUsuario,
    setEstadoUsuario,
    deleteUsuario,
    getPermisosUsuario,
    getPermisosRol,
    savePermisosRol,
};
