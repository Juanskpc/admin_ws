const Models = require('../models/conection');
const { initTransaction } = require('../helpers/funcionesAdicionales');
const planHelper = require('../helpers/planHelper');
const usuarioAdminDao = require('./usuarioAdminDao');

/**
 * Obtiene la lista de negocios activos.
 * @returns {Array} Lista de negocios
 */
function getListaNegocios() {
    return Models.GenerNegocio.findAll({
        where: { estado: 'A' },
        attributes: ['id_negocio', 'nombre', 'nit', 'email_contacto', 'telefono', 'fecha_registro']
    });
}

/**
 * Obtiene un negocio por su ID.
 * @param {number} idNegocio
 * @returns {Object|null}
 */
function getNegocioById(idNegocio) {
    return Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio, estado: 'A' }
    });
}

/**
 * Crea un nuevo negocio.
 * @param {Object} negocio Datos del negocio
 * @param {Object} t Transacción (opcional)
 */
function createNegocio(negocio, t) {
    const options = t ? { transaction: t } : {};
    return Models.GenerNegocio.create(negocio, options);
}

/**
 * Obtiene todos los negocios activos asociados a un usuario.
 * JOIN con gener_negocio_usuario para verificar membresía.
 * @param {number} idUsuario
 * @returns {Array}
 */
function getNegociosByUsuario(idUsuario) {
    return Models.GenerNegocio.findAll({
        where: { estado: 'A' },
        include: [{
            model: Models.GenerNegocioUsuario,
            as: 'usuarios',
            where: { id_usuario: idUsuario, estado: 'A' },
            attributes: [],
            required: true,
        }],
        attributes: [
            'id_negocio', 'nombre', 'nit',
            'email_contacto', 'telefono',
            'id_tipo_negocio', 'id_paleta',
            'estado', 'fecha_registro',
        ],
        order: [['nombre', 'ASC']],
    });
}

/**
 * Obtiene los negocios a los que un usuario tiene acceso, filtrados por tipo de negocio.
 * JOIN con gener_negocio_usuario para verificar membresía.
 * @param {number} idUsuario
 * @param {number} idTipoNegocio
 * @returns {Array}
 */
function getNegociosByUsuarioAndTipo(idUsuario, idTipoNegocio) {
    return Models.GenerNegocio.findAll({
        where: { estado: 'A', id_tipo_negocio: idTipoNegocio },
        include: [{
            model: Models.GenerNegocioUsuario,
            as: 'usuarios',
            where: { id_usuario: idUsuario, estado: 'A' },
            attributes: [],
            required: true,
        }],
        attributes: [
            'id_negocio', 'nombre', 'nit',
            'email_contacto', 'telefono',
            'id_tipo_negocio', 'id_paleta',
            'estado', 'fecha_registro',
        ],
        order: [['nombre', 'ASC']],
    });
}

/**
 * Convierte una fecha 'YYYY-MM-DD' (o ISO) a un Date anclado a Bogotá (-05:00),
 * para que se almacene con la pared horaria correcta (sin corrimiento de día).
 */
function fechaBogota(valor, finDeDia = false) {
    if (!valor) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
        return new Date(`${valor}T${finDeDia ? '23:59:59' : '00:00:00'}-05:00`);
    }
    return new Date(valor);
}

/**
 * Asigna (o cambia) el plan de un negocio.
 * Desactiva el plan vigente y crea una nueva vigencia, todo en una transacción.
 *
 * @param {number} idNegocio
 * @param {number} idPlan
 * @param {Object} [opts]
 * @param {number} [opts.meses=1]        Duración si no se da fecha de fin.
 * @param {string} [opts.fechaInicio]    Fecha de inicio ('YYYY-MM-DD' o ISO).
 * @param {string} [opts.fechaFin]       Fecha de fin ('YYYY-MM-DD' o ISO).
 * @returns {Promise<Object>} La fila gener_negocio_plan creada.
 */
async function asignarPlan(idNegocio, idPlan, { meses = 1, fechaInicio = null, fechaFin = null } = {}) {
    const negocio = await Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_negocio'],
    });
    if (!negocio) {
        const err = new Error('Negocio no encontrado');
        err.statusCode = 404;
        throw err;
    }

    const plan = await Models.GenerPlan.findOne({
        where: { id_plan: idPlan, estado: 'A' },
        attributes: ['id_plan'],
    });
    if (!plan) {
        const err = new Error('Plan no encontrado o inactivo');
        err.statusCode = 404;
        throw err;
    }

    const inicio = fechaInicio ? fechaBogota(fechaInicio, false) : new Date();
    let fin;
    if (fechaFin) {
        fin = fechaBogota(fechaFin, true);
    } else {
        fin = new Date(inicio);
        fin.setMonth(fin.getMonth() + Number(meses || 1));
    }

    if (fin < inicio) {
        const err = new Error('La fecha de fin no puede ser anterior a la de inicio');
        err.statusCode = 400;
        throw err;
    }

    const transaction = await initTransaction();
    try {
        // Cierra la vigencia anterior (solo puede haber un plan activo a la vez).
        await Models.GenerNegocioPlan.update(
            { estado: 'I' },
            { where: { id_negocio: idNegocio, estado: 'A' }, transaction },
        );

        const row = await Models.GenerNegocioPlan.create(
            {
                id_negocio: idNegocio,
                id_plan: idPlan,
                fecha_inicio: inicio,
                fecha_fin: fin,
                estado: 'A',
                auto_renovacion: true,
            },
            { transaction },
        );

        await transaction.commit();
        return row;
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

/**
 * Lista TODOS los negocios (activos e inactivos) con su tipo y plan vigente.
 * Para la vista de gestión del Super Admin.
 */
async function getListaNegociosAdmin() {
    const negocios = await Models.GenerNegocio.findAll({
        attributes: [
            'id_negocio', 'nombre', 'nit', 'email_contacto', 'telefono',
            'direccion', 'id_tipo_negocio', 'estado', 'fecha_registro',
        ],
        include: [{
            model: Models.GenerTipoNegocio,
            as: 'tipoNegocio',
            attributes: ['id_tipo_negocio', 'nombre', 'icono', 'color_hex'],
            required: false,
        }],
        order: [['fecha_registro', 'DESC']],
    });

    const ids = negocios.map((n) => n.id_negocio);
    const planMap = await planHelper.getPlanesActivosPorNegocio(ids);

    return negocios.map((n) => ({
        id_negocio: n.id_negocio,
        nombre: n.nombre,
        nit: n.nit,
        email_contacto: n.email_contacto,
        telefono: n.telefono,
        direccion: n.direccion,
        id_tipo_negocio: n.id_tipo_negocio,
        tipo_nombre: n.tipoNegocio?.nombre ?? null,
        tipo_icono: n.tipoNegocio?.icono ?? null,
        tipo_color: n.tipoNegocio?.color_hex ?? null,
        estado: n.estado,
        fecha_registro: n.fecha_registro,
        plan: planMap.get(n.id_negocio) || null,
    }));
}

/**
 * Actualiza los datos de un negocio.
 */
async function updateNegocio(idNegocio, data) {
    const negocio = await Models.GenerNegocio.findOne({ where: { id_negocio: idNegocio } });
    if (!negocio) {
        const err = new Error('Negocio no encontrado');
        err.statusCode = 404;
        throw err;
    }

    await negocio.update({
        nombre: data.nombre,
        nit: data.nit ?? null,
        email_contacto: data.email_contacto ?? null,
        telefono: data.telefono ?? null,
        direccion: data.direccion ?? null,
        ...(data.id_tipo_negocio ? { id_tipo_negocio: Number(data.id_tipo_negocio) } : {}),
    });

    return negocio;
}

/**
 * Cambia el estado (A/I) de un negocio.
 * @returns {number} filas afectadas
 */
async function setEstadoNegocio(idNegocio, estado) {
    const [affected] = await Models.GenerNegocio.update(
        { estado },
        { where: { id_negocio: idNegocio } },
    );
    return affected;
}

/**
 * Registra un cliente nuevo: crea el negocio, le asigna un plan (opcional)
 * y crea (o vincula) su usuario administrador — todo en una sola transacción.
 *
 * @param {Object} payload { negocio, plan, admin?, id_usuario_existente? }
 * @returns {Promise<{id_negocio:number, id_usuario:number}>}
 */
async function registrarCliente({ negocio, plan, admin, id_usuario_existente }) {
    // ── Validaciones previas (fallar rápido, fuera de la transacción) ──────────

    const tipo = await Models.GenerTipoNegocio.findOne({
        where: { id_tipo_negocio: negocio.id_tipo_negocio, estado: 'A' },
        attributes: ['id_tipo_negocio'],
    });
    if (!tipo) {
        const err = new Error('El tipo de negocio seleccionado no es válido');
        err.statusCode = 400;
        throw err;
    }

    const roles = await usuarioAdminDao.getRolesActivos({ idTipoNegocio: negocio.id_tipo_negocio });
    const rolAdmin = roles.find((r) => usuarioAdminDao.isAdminRoleName(r.descripcion));
    if (!rolAdmin) {
        const err = new Error('El tipo de negocio no tiene un rol de administrador definido');
        err.statusCode = 409;
        throw err;
    }

    if (id_usuario_existente) {
        // Modo "usuario existente": verificar que el usuario exista y esté activo.
        const existente = await Models.GenerUsuario.findOne({
            where: { id_usuario: id_usuario_existente, estado: 'A' },
            attributes: ['id_usuario'],
        });
        if (!existente) {
            const err = new Error('El usuario seleccionado no existe o está inactivo');
            err.statusCode = 404;
            throw err;
        }
    } else {
        // Modo "usuario nuevo": evitar duplicados de email / identificación.
        const duplicado = await usuarioAdminDao.findUsuarioDuplicado({
            email: admin.email,
            num_identificacion: admin.num_identificacion,
        });
        if (duplicado) {
            const campo = duplicado.email === admin.email ? 'email' : 'número de identificación';
            const err = new Error(`Ya existe un usuario con ese ${campo}`);
            err.statusCode = 409;
            throw err;
        }
    }

    if (plan?.id_plan) {
        const p = await Models.GenerPlan.findOne({
            where: { id_plan: plan.id_plan, estado: 'A' },
            attributes: ['id_plan'],
        });
        if (!p) {
            const err = new Error('Plan no encontrado o inactivo');
            err.statusCode = 404;
            throw err;
        }
    }

    const transaction = await initTransaction();
    try {
        // 1. Negocio
        const nuevo = await Models.GenerNegocio.create({
            nombre: negocio.nombre,
            nit: negocio.nit ?? null,
            email_contacto: negocio.email_contacto ?? null,
            telefono: negocio.telefono ?? null,
            direccion: negocio.direccion ?? null,
            id_tipo_negocio: Number(negocio.id_tipo_negocio),
            estado: 'A',
        }, { transaction });
        const idNegocio = nuevo.id_negocio;

        // 2. Plan (opcional)
        if (plan?.id_plan) {
            const inicio = plan.fecha_inicio ? new Date(plan.fecha_inicio) : new Date();
            const fin = new Date(inicio);
            fin.setMonth(fin.getMonth() + Number(plan.meses || 1));
            await Models.GenerNegocioPlan.create({
                id_negocio: idNegocio,
                id_plan: plan.id_plan,
                fecha_inicio: inicio,
                fecha_fin: fin,
                estado: 'A',
                auto_renovacion: true,
            }, { transaction });
        }

        // 3. Usuario: vincular existente O crear nuevo
        let idUsuario;
        if (id_usuario_existente) {
            await usuarioAdminDao.vincularUsuarioANegocio(
                id_usuario_existente, rolAdmin.id_rol, idNegocio, transaction,
            );
            idUsuario = id_usuario_existente;
        } else {
            idUsuario = await usuarioAdminDao.createUsuario({
                primer_nombre: admin.primer_nombre,
                segundo_nombre: admin.segundo_nombre || null,
                primer_apellido: admin.primer_apellido,
                segundo_apellido: admin.segundo_apellido || null,
                num_identificacion: admin.num_identificacion,
                telefono: admin.telefono || null,
                email: admin.email,
                password: admin.password,
                id_rol: rolAdmin.id_rol,
                id_negocio: idNegocio,
                estado: 'A',
                es_admin_principal: false,
            }, transaction);
        }

        await transaction.commit();
        return { id_negocio: idNegocio, id_usuario: idUsuario };
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

module.exports = {
    getListaNegocios,
    getNegocioById,
    createNegocio,
    getNegociosByUsuario,
    getNegociosByUsuarioAndTipo,
    asignarPlan,
    getListaNegociosAdmin,
    updateNegocio,
    setEstadoNegocio,
    registrarCliente,
};