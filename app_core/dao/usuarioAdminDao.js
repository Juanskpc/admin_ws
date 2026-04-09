const { Op } = require('sequelize');
const Models = require('../models/conection');

function isAdminRoleName(nombreRol = '') {
    return nombreRol.toUpperCase().includes('ADMINISTRADOR');
}

function buildNombreCompleto(usuario) {
    return [
        usuario.primer_nombre,
        usuario.segundo_nombre,
        usuario.primer_apellido,
        usuario.segundo_apellido,
    ].filter(Boolean).join(' ').trim();
}

async function getUsuarios({ search = '', idRol = null, estado = null } = {}) {
    const where = {};

    if (estado === 'A' || estado === 'I') {
        where.estado = estado;
    }

    if (search.trim()) {
        const term = `%${search.trim()}%`;
        where[Op.or] = [
            { primer_nombre: { [Op.iLike]: term } },
            { segundo_nombre: { [Op.iLike]: term } },
            { primer_apellido: { [Op.iLike]: term } },
            { segundo_apellido: { [Op.iLike]: term } },
            { email: { [Op.iLike]: term } },
            { num_identificacion: { [Op.iLike]: term } },
        ];
    }

    const usuarios = await Models.GenerUsuario.findAll({
        where,
        attributes: [
            'id_usuario',
            'primer_nombre',
            'segundo_nombre',
            'primer_apellido',
            'segundo_apellido',
            'num_identificacion',
            'email',
            'estado',
            'fecha_creacion',
            'es_admin_principal',
        ],
        include: [
            {
                model: Models.GenerUsuarioRol,
                as: 'roles',
                where: { estado: 'A' },
                required: false,
                attributes: ['id_usuario_rol', 'id_rol', 'id_negocio', 'fecha_creacion'],
                include: [
                    {
                        model: Models.GenerRol,
                        as: 'rol',
                        attributes: ['id_rol', 'descripcion', 'id_tipo_negocio', 'estado'],
                        required: false,
                    },
                    {
                        model: Models.GenerNegocio,
                        as: 'negocio',
                        attributes: ['id_negocio', 'nombre'],
                        required: false,
                    }
                ],
            },
        ],
        order: [['fecha_creacion', 'DESC']],
    });

    const mapped = usuarios.map((usuario) => {
        const rolesActivos = (usuario.roles || [])
            .filter((item) => item.rol && item.rol.estado === 'A')
            .map((item) => ({
                id_usuario_rol: item.id_usuario_rol,
                id_rol: item.rol.id_rol,
                descripcion: item.rol.descripcion,
                id_tipo_negocio: item.rol.id_tipo_negocio,
                id_negocio: item.id_negocio,
                negocio_nombre: item.negocio?.nombre || null,
            }));

        const rolPrincipal = rolesActivos[0] || null;

        return {
            id_usuario: usuario.id_usuario,
            nombre_completo: buildNombreCompleto(usuario),
            primer_nombre: usuario.primer_nombre,
            segundo_nombre: usuario.segundo_nombre,
            primer_apellido: usuario.primer_apellido,
            segundo_apellido: usuario.segundo_apellido,
            num_identificacion: usuario.num_identificacion,
            email: usuario.email,
            estado: usuario.estado,
            fecha_creacion: usuario.fecha_creacion,
            es_admin_principal: Boolean(usuario.es_admin_principal),
            rol_principal: rolPrincipal,
            roles: rolesActivos,
        };
    });

    if (!idRol) return mapped;
    return mapped.filter((u) => u.roles.some((r) => Number(r.id_rol) === Number(idRol)));
}

async function getUsuarioById(idUsuario) {
    const usuarios = await getUsuarios({});
    return usuarios.find((u) => u.id_usuario === Number(idUsuario)) || null;
}

function getUsuarioByIdRaw(idUsuario) {
    return Models.GenerUsuario.findByPk(idUsuario, {
        attributes: [
            'id_usuario',
            'primer_nombre',
            'segundo_nombre',
            'primer_apellido',
            'segundo_apellido',
            'num_identificacion',
            'email',
            'estado',
            'es_admin_principal',
        ],
    });
}

function findUsuarioDuplicado({ email, num_identificacion, excludeId = null }) {
    const where = {
        [Op.or]: [
            { email },
            { num_identificacion },
        ],
    };

    if (excludeId) {
        where.id_usuario = { [Op.ne]: excludeId };
    }

    return Models.GenerUsuario.findOne({
        where,
        attributes: ['id_usuario', 'email', 'num_identificacion'],
    });
}

function getRolesActivos() {
    return Models.GenerRol.findAll({
        where: { estado: 'A' },
        attributes: ['id_rol', 'descripcion', 'id_tipo_negocio'],
        include: [
            {
                model: Models.GenerTipoNegocio,
                as: 'tipoNegocio',
                required: false,
                attributes: ['id_tipo_negocio', 'nombre'],
            },
        ],
        order: [['descripcion', 'ASC']],
    });
}

async function countAdminsActivos(excludeUserId = null) {
    const replacements = {};
    let excludeClause = '';

    if (excludeUserId) {
        excludeClause = 'AND u.id_usuario <> :excludeUserId';
        replacements.excludeUserId = Number(excludeUserId);
    }

    const [rows] = await Models.sequelize.query(
        `
        SELECT COUNT(DISTINCT u.id_usuario)::int AS total
        FROM general.gener_usuario u
        JOIN general.gener_usuario_rol ur
          ON ur.id_usuario = u.id_usuario
         AND ur.estado = 'A'
        JOIN general.gener_rol r
          ON r.id_rol = ur.id_rol
         AND r.estado = 'A'
        WHERE u.estado = 'A'
          AND UPPER(r.descripcion) LIKE '%ADMINISTRADOR%'
          ${excludeClause}
        `,
        { replacements }
    );

    return rows?.[0]?.total || 0;
}

async function createUsuario(payload, transaction) {
    const nuevoUsuario = await Models.GenerUsuario.create(
        {
            primer_nombre: payload.primer_nombre,
            segundo_nombre: payload.segundo_nombre || null,
            primer_apellido: payload.primer_apellido,
            segundo_apellido: payload.segundo_apellido || null,
            num_identificacion: payload.num_identificacion,
            telefono: payload.telefono || null,
            email: payload.email,
            password: payload.password,
            estado: payload.estado || 'A',
            es_admin_principal: Boolean(payload.es_admin_principal),
        },
        { transaction }
    );

    await Models.GenerUsuarioRol.create(
        {
            id_usuario: nuevoUsuario.id_usuario,
            id_rol: payload.id_rol,
            id_negocio: payload.id_negocio || null,
            estado: 'A',
        },
        { transaction }
    );

    return nuevoUsuario.id_usuario;
}

async function updateUsuario(idUsuario, payload, transaction) {
    const usuario = await Models.GenerUsuario.findByPk(idUsuario, { transaction });
    if (!usuario) return null;

    const patch = {
        primer_nombre: payload.primer_nombre,
        segundo_nombre: payload.segundo_nombre || null,
        primer_apellido: payload.primer_apellido,
        segundo_apellido: payload.segundo_apellido || null,
        num_identificacion: payload.num_identificacion,
        telefono: payload.telefono || null,
        email: payload.email,
        estado: payload.estado,
        es_admin_principal: Boolean(payload.es_admin_principal),
    };

    if (payload.password) {
        patch.password = payload.password;
    }

    await usuario.update(patch, { transaction });

    await Models.GenerUsuarioRol.update(
        { estado: 'I' },
        {
            where: { id_usuario: idUsuario, estado: 'A' },
            transaction,
        }
    );

    await Models.GenerUsuarioRol.create(
        {
            id_usuario: idUsuario,
            id_rol: payload.id_rol,
            id_negocio: payload.id_negocio || null,
            estado: 'A',
        },
        { transaction }
    );

    return idUsuario;
}

async function updateEstadoUsuario(idUsuario, estado, transaction) {
    const [affectedRows] = await Models.GenerUsuario.update(
        { estado },
        {
            where: { id_usuario: idUsuario },
            transaction,
        }
    );

    return affectedRows;
}

async function softDeleteUsuario(idUsuario, transaction) {
    await Models.GenerUsuarioRol.update(
        { estado: 'I' },
        {
            where: { id_usuario: idUsuario, estado: 'A' },
            transaction,
        }
    );

    const [affectedRows] = await Models.GenerUsuario.update(
        { estado: 'I' },
        {
            where: { id_usuario: idUsuario },
            transaction,
        }
    );

    return affectedRows;
}

async function getPermisosMatrizRol(idRol) {
    const rol = await Models.GenerRol.findByPk(idRol, {
        attributes: ['id_rol', 'descripcion', 'id_tipo_negocio'],
    });
    if (!rol) return null;

    const nivelesWhere = {
        estado: 'A',
        id_tipo_nivel: 1,
    };

    if (rol.id_tipo_negocio) {
        nivelesWhere.id_tipo_negocio = rol.id_tipo_negocio;
    }

    const niveles = await Models.GenerNivel.findAll({
        where: nivelesWhere,
        attributes: ['id_nivel', 'descripcion', 'id_tipo_negocio'],
        order: [['descripcion', 'ASC']],
    });

    const permisos = await Models.GenerRolNivel.findAll({
        where: {
            id_rol: idRol,
            estado: 'A',
            id_nivel: niveles.map((n) => n.id_nivel),
        },
        attributes: ['id_nivel', 'puede_ver', 'puede_crear', 'puede_editar', 'puede_eliminar'],
    });

    const byNivel = new Map(permisos.map((p) => [p.id_nivel, p]));

    const modulos = niveles.map((nivel) => {
        const permiso = byNivel.get(nivel.id_nivel);

        return {
            id_nivel: nivel.id_nivel,
            modulo: nivel.descripcion,
            puede_ver: Boolean(permiso?.puede_ver),
            puede_crear: Boolean(permiso?.puede_crear),
            puede_editar: Boolean(permiso?.puede_editar),
            puede_eliminar: Boolean(permiso?.puede_eliminar),
        };
    });

    return {
        id_rol: rol.id_rol,
        descripcion: rol.descripcion,
        id_tipo_negocio: rol.id_tipo_negocio,
        modulos,
    };
}

async function savePermisosRol(idRol, modulos, transaction) {
    for (const modulo of modulos) {
        const values = {
            id_rol: idRol,
            id_nivel: modulo.id_nivel,
            puede_ver: Boolean(modulo.puede_ver),
            puede_crear: Boolean(modulo.puede_crear),
            puede_editar: Boolean(modulo.puede_editar),
            puede_eliminar: Boolean(modulo.puede_eliminar),
            estado: 'A',
            fecha_actualizacion: new Date(),
        };

        const existing = await Models.GenerRolNivel.findOne({
            where: { id_rol: idRol, id_nivel: modulo.id_nivel },
            transaction,
        });

        if (existing) {
            await existing.update(values, { transaction });
        } else {
            await Models.GenerRolNivel.create(
                {
                    ...values,
                    fecha_creacion: new Date(),
                },
                { transaction }
            );
        }
    }
}

async function getPermisosEfectivosUsuario(idUsuario) {
    const usuario = await getUsuarioById(idUsuario);
    if (!usuario) return null;

    const rolesAsignados = (usuario.roles || []).map((r) => r.id_rol);
    if (rolesAsignados.length === 0) {
        return {
            usuario,
            permisos_vista: [],
        };
    }

    const permisos = await Models.GenerRolNivel.findAll({
        where: {
            id_rol: rolesAsignados,
            estado: 'A',
        },
        attributes: ['id_rol', 'id_nivel', 'puede_ver', 'puede_crear', 'puede_editar', 'puede_eliminar'],
        include: [
            {
                model: Models.GenerNivel,
                as: 'nivel',
                where: { estado: 'A', id_tipo_nivel: 3 },
                required: true,
                attributes: ['id_nivel', 'descripcion', 'url', 'id_tipo_negocio'],
            },
            {
                model: Models.GenerRol,
                as: 'rol',
                required: true,
                attributes: ['id_rol', 'descripcion'],
            }
        ],
    });

    const grouped = new Map();

    for (const permiso of permisos) {
        const key = permiso.nivel?.id_nivel;
        if (!key) continue;

        const existing = grouped.get(key) || {
            id_nivel: permiso.nivel.id_nivel,
            vista: permiso.nivel.descripcion,
            url: permiso.nivel.url,
            roles: new Set(),
            puede_ver: false,
            puede_crear: false,
            puede_editar: false,
            puede_eliminar: false,
        };

        existing.roles.add(permiso.rol.descripcion);
        existing.puede_ver = existing.puede_ver || Boolean(permiso.puede_ver);
        existing.puede_crear = existing.puede_crear || Boolean(permiso.puede_crear);
        existing.puede_editar = existing.puede_editar || Boolean(permiso.puede_editar);
        existing.puede_eliminar = existing.puede_eliminar || Boolean(permiso.puede_eliminar);

        grouped.set(key, existing);
    }

    const permisosVista = [...grouped.values()]
        .map((item) => ({
            ...item,
            roles: [...item.roles].sort(),
        }))
        .sort((a, b) => a.vista.localeCompare(b.vista));

    return {
        usuario,
        permisos_vista: permisosVista,
    };
}

module.exports = {
    isAdminRoleName,
    getUsuarios,
    getUsuarioById,
    getUsuarioByIdRaw,
    findUsuarioDuplicado,
    getRolesActivos,
    countAdminsActivos,
    createUsuario,
    updateUsuario,
    updateEstadoUsuario,
    softDeleteUsuario,
    getPermisosMatrizRol,
    savePermisosRol,
    getPermisosEfectivosUsuario,
};
