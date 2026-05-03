const { Op } = require('sequelize');
const Models = require('../models/conection');

function isAdminRoleName(nombreRol = '') {
    return nombreRol.toUpperCase().includes('ADMINISTRADOR');
}

function isMeseroRoleName(nombreRol = '') {
    return nombreRol.toUpperCase().includes('MESERO');
}

function normalizePermissionCode(rawCode = '') {
    return String(rawCode)
        .trim()
        .toLowerCase()
        .replace(/^\/+/, '')
        .replace(/\//g, '_');
}

function resolveDefaultSubnivelPermission({ codigo, rolDescripcion, modulePermission }) {
    if (isAdminRoleName(rolDescripcion)) return true;
    if (!modulePermission) return false;

    if (codigo === 'pedidos_cobrar' && isMeseroRoleName(rolDescripcion)) {
        return false;
    }

    return true;
}

function buildNombreCompleto(usuario) {
    return [
        usuario.primer_nombre,
        usuario.segundo_nombre,
        usuario.primer_apellido,
        usuario.segundo_apellido,
    ].filter(Boolean).join(' ').trim();
}

function normalizeNegocioId(idNegocio) {
    const parsed = Number(idNegocio || 0);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function syncUsuarioNegocioActivo(idUsuario, idNegocio, transaction) {
    const normalizedNegocioId = normalizeNegocioId(idNegocio);

    await Models.GenerNegocioUsuario.update(
        { estado: 'I' },
        {
            where: {
                id_usuario: idUsuario,
                estado: 'A',
            },
            transaction,
        }
    );

    if (!normalizedNegocioId) {
        return null;
    }

    const existingRelation = await Models.GenerNegocioUsuario.findOne({
        where: {
            id_usuario: idUsuario,
            id_negocio: normalizedNegocioId,
        },
        transaction,
    });

    if (existingRelation) {
        await existingRelation.update({ estado: 'A' }, { transaction });
        return normalizedNegocioId;
    }

    await Models.GenerNegocioUsuario.create(
        {
            id_usuario: idUsuario,
            id_negocio: normalizedNegocioId,
            estado: 'A',
        },
        { transaction }
    );

    return normalizedNegocioId;
}

async function syncUsuarioRolActivo(idUsuario, idRol, idNegocio, transaction) {
    const normalizedNegocioId = normalizeNegocioId(idNegocio);

    await Models.GenerUsuarioRol.update(
        { estado: 'I' },
        {
            where: {
                id_usuario: idUsuario,
                estado: 'A',
            },
            transaction,
        }
    );

    const where = {
        id_usuario: idUsuario,
        id_rol: idRol,
        id_negocio: normalizedNegocioId,
    };

    const existingRole = await Models.GenerUsuarioRol.findOne({
        where,
        transaction,
    });

    if (existingRole) {
        await existingRole.update({ estado: 'A' }, { transaction });
        return;
    }

    await Models.GenerUsuarioRol.create(
        {
            ...where,
            estado: 'A',
        },
        { transaction }
    );
}

async function getUsuarios({ search = '', idRol = null, idNegocio = null, estado = null } = {}) {
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

    const rolesWhere = { estado: 'A' };
    if (idNegocio) {
        rolesWhere.id_negocio = Number(idNegocio);
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
                where: rolesWhere,
                required: Boolean(idNegocio),
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

async function getRolesActivos({ idNegocio = null, idTipoNegocio = null } = {}) {
    let tipoNegocioFiltro = idTipoNegocio ? Number(idTipoNegocio) : null;

    if (!tipoNegocioFiltro && idNegocio) {
        const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
            attributes: ['id_negocio', 'id_tipo_negocio'],
        });

        if (!negocio) {
            return [];
        }

        tipoNegocioFiltro = Number(negocio.id_tipo_negocio || 0) || null;
    }

    const where = { estado: 'A' };
    if (tipoNegocioFiltro) {
        where.id_tipo_negocio = tipoNegocioFiltro;
    }

    return Models.GenerRol.findAll({
        where,
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

async function getNivelIdsPlantillaRol({ idRol, idNegocio = null, idTipoNegocio = null, transaction }) {
    let tipoNegocio = idTipoNegocio ? Number(idTipoNegocio) : null;

    if (!tipoNegocio && idNegocio) {
        const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
            attributes: ['id_negocio', 'id_tipo_negocio'],
            transaction,
        });

        tipoNegocio = Number(negocio?.id_tipo_negocio || 0) || null;
    }

    if (idNegocio) {
        const nivelesNegocio = await Models.GenerNivelNegocio.findAll({
            where: {
                id_negocio: idNegocio,
                id_rol: idRol,
                estado: 'A',
                puede_ver: true,
            },
            attributes: ['id_nivel'],
            include: [
                {
                    model: Models.GenerNivel,
                    as: 'nivel',
                    required: true,
                    where: {
                        estado: 'A',
                        id_tipo_nivel: 1,
                        ...(tipoNegocio ? { id_tipo_negocio: tipoNegocio } : {}),
                    },
                    attributes: ['id_nivel'],
                },
            ],
            transaction,
        });

        if (nivelesNegocio.length > 0) {
            return [...new Set(
                nivelesNegocio
                    .map((item) => Number(item.id_nivel))
                    .filter((idNivel) => Number.isInteger(idNivel) && idNivel > 0)
            )];
        }
    }

    const nivelesWhere = {
        estado: 'A',
        id_tipo_nivel: 1,
        ...(tipoNegocio ? { id_tipo_negocio: tipoNegocio } : {}),
    };

    const fallback = await Models.GenerRolNivel.findAll({
        where: {
            id_rol: idRol,
            estado: 'A',
            puede_ver: true,
        },
        attributes: ['id_nivel'],
        include: [
            {
                model: Models.GenerNivel,
                as: 'nivel',
                required: true,
                where: nivelesWhere,
                attributes: ['id_nivel'],
            },
        ],
        transaction,
    });

    return [...new Set(
        fallback
            .map((item) => Number(item.id_nivel))
            .filter((idNivel) => Number.isInteger(idNivel) && idNivel > 0)
    )];
}

async function rebuildNivelesUsuario(idUsuario, transaction) {
    const asignacionesActivas = await Models.GenerUsuarioRol.findAll({
        where: {
            id_usuario: idUsuario,
            estado: 'A',
        },
        attributes: ['id_usuario', 'id_rol', 'id_negocio'],
        include: [
            {
                model: Models.GenerRol,
                as: 'rol',
                required: false,
                attributes: ['id_rol', 'id_tipo_negocio'],
            },
            {
                model: Models.GenerNegocio,
                as: 'negocio',
                required: false,
                attributes: ['id_negocio', 'id_tipo_negocio'],
            },
        ],
        transaction,
    });

    const nivelesAsignados = new Set();

    for (const asignacion of asignacionesActivas) {
        const idRol = Number(asignacion.id_rol);
        const idNegocio = Number(asignacion.id_negocio || 0) || null;
        const idTipoNegocio = Number(
            asignacion.negocio?.id_tipo_negocio
            || asignacion.rol?.id_tipo_negocio
            || 0
        ) || null;

        const nivelesRol = await getNivelIdsPlantillaRol({
            idRol,
            idNegocio,
            idTipoNegocio,
            transaction,
        });

        nivelesRol.forEach((idNivel) => nivelesAsignados.add(idNivel));
    }

    await Models.GenerNivelUsuario.destroy({
        where: { id_usuario: idUsuario },
        transaction,
    });

    if (nivelesAsignados.size === 0) {
        return;
    }

    const rows = [...nivelesAsignados].map((idNivel) => ({
        id_usuario: idUsuario,
        id_nivel: idNivel,
        fecha: new Date(),
    }));

    await Models.GenerNivelUsuario.bulkCreate(rows, { transaction });
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

    const idNegocio = await syncUsuarioNegocioActivo(
        nuevoUsuario.id_usuario,
        payload.id_negocio,
        transaction
    );

    await syncUsuarioRolActivo(
        nuevoUsuario.id_usuario,
        payload.id_rol,
        idNegocio,
        transaction
    );

    await rebuildNivelesUsuario(nuevoUsuario.id_usuario, transaction);

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

    const idNegocio = await syncUsuarioNegocioActivo(idUsuario, payload.id_negocio, transaction);

    await syncUsuarioRolActivo(idUsuario, payload.id_rol, idNegocio, transaction);

    await rebuildNivelesUsuario(idUsuario, transaction);

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

async function getPermisosMatrizRol(payload = {}) {
    const args = typeof payload === 'number'
        ? { idRol: payload, idNegocio: null }
        : payload;

    const idRol = Number(args.idRol);
    const idNegocio = Number(args.idNegocio || 0) || null;
    if (!idRol) return null;

    const rol = await Models.GenerRol.findByPk(idRol, {
        attributes: ['id_rol', 'descripcion', 'id_tipo_negocio'],
    });
    if (!rol) return null;

    let tipoNegocioMatriz = Number(rol.id_tipo_negocio || 0) || null;
    if (idNegocio) {
        const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
            attributes: ['id_negocio', 'id_tipo_negocio'],
        });
        if (!negocio) return null;

        const tipoNegocioNegocio = Number(negocio.id_tipo_negocio || 0) || null;
        if (tipoNegocioMatriz && tipoNegocioNegocio && tipoNegocioMatriz !== tipoNegocioNegocio) {
            return null;
        }

        if (!tipoNegocioMatriz) {
            tipoNegocioMatriz = tipoNegocioNegocio;
        }
    }

    const nivelesWhere = {
        estado: 'A',
        id_tipo_nivel: 1,
        ...(tipoNegocioMatriz ? { id_tipo_negocio: tipoNegocioMatriz } : {}),
    };

    const niveles = await Models.GenerNivel.findAll({
        where: nivelesWhere,
        attributes: ['id_nivel', 'descripcion', 'id_tipo_negocio', 'url'],
        order: [['descripcion', 'ASC']],
    });

    const moduloIds = niveles
        .map((item) => Number(item.id_nivel))
        .filter((idNivel) => Number.isInteger(idNivel) && idNivel > 0);

    const subniveles = moduloIds.length > 0
        ? await Models.GenerNivel.findAll({
            where: {
                estado: 'A',
                id_tipo_nivel: 4,
                id_nivel_padre: moduloIds,
                ...(tipoNegocioMatriz ? { id_tipo_negocio: tipoNegocioMatriz } : {}),
            },
            attributes: ['id_nivel', 'id_nivel_padre', 'descripcion', 'url'],
            order: [['descripcion', 'ASC']],
        })
        : [];

    const subnivelesByModulo = new Map();
    subniveles.forEach((subnivel) => {
        const idPadre = Number(subnivel.id_nivel_padre);
        if (!Number.isInteger(idPadre) || idPadre <= 0) return;

        const current = subnivelesByModulo.get(idPadre) || [];
        current.push(subnivel);
        subnivelesByModulo.set(idPadre, current);
    });

    const subnivelIds = subniveles
        .map((item) => Number(item.id_nivel))
        .filter((idNivel) => Number.isInteger(idNivel) && idNivel > 0);

    const nivelIds = [...new Set([...moduloIds, ...subnivelIds])];

    const permisosFallback = await Models.GenerRolNivel.findAll({
        where: {
            id_rol: idRol,
            estado: 'A',
            id_nivel: nivelIds,
        },
        attributes: ['id_nivel', 'puede_ver'],
    });
    const fallbackByNivel = new Map(permisosFallback.map((permiso) => [Number(permiso.id_nivel), permiso]));

    let permisosByNivel = fallbackByNivel;

    if (idNegocio) {
        let permisosNegocio = await Models.GenerNivelNegocio.findAll({
            where: {
                id_negocio: idNegocio,
                id_rol: idRol,
                estado: 'A',
                id_nivel: nivelIds,
            },
            attributes: ['id_nivel', 'puede_ver'],
        });

        const permisosNegocioMap = new Map(
            permisosNegocio.map((permiso) => [Number(permiso.id_nivel), permiso])
        );

        const missingNivelIds = nivelIds.filter((idNivel) => !permisosNegocioMap.has(Number(idNivel)));

        if (missingNivelIds.length > 0) {
            const seedRows = [];

            for (const idNivel of missingNivelIds) {
                const modulo = niveles.find((item) => Number(item.id_nivel) === Number(idNivel));

                if (modulo) {
                    seedRows.push({
                        id_negocio: idNegocio,
                        id_rol: idRol,
                        id_nivel: modulo.id_nivel,
                        puede_ver: Boolean(fallbackByNivel.get(Number(modulo.id_nivel))?.puede_ver),
                        estado: 'A',
                        fecha_creacion: new Date(),
                        fecha_actualizacion: new Date(),
                    });
                    continue;
                }

                const subnivel = subniveles.find((item) => Number(item.id_nivel) === Number(idNivel));
                if (!subnivel) continue;

                const parentId = Number(subnivel.id_nivel_padre);
                const parentPermission = Boolean(
                    permisosNegocioMap.get(parentId)?.puede_ver
                    ?? fallbackByNivel.get(parentId)?.puede_ver
                );

                seedRows.push({
                    id_negocio: idNegocio,
                    id_rol: idRol,
                    id_nivel: subnivel.id_nivel,
                    puede_ver: resolveDefaultSubnivelPermission({
                        codigo: normalizePermissionCode(subnivel.url),
                        rolDescripcion: rol.descripcion,
                        modulePermission: parentPermission,
                    }),
                    estado: 'A',
                    fecha_creacion: new Date(),
                    fecha_actualizacion: new Date(),
                });
            }

            if (seedRows.length > 0) {
                await Models.GenerNivelNegocio.bulkCreate(seedRows, {
                    ignoreDuplicates: true,
                });

                permisosNegocio = await Models.GenerNivelNegocio.findAll({
                    where: {
                        id_negocio: idNegocio,
                        id_rol: idRol,
                        estado: 'A',
                        id_nivel: nivelIds,
                    },
                    attributes: ['id_nivel', 'puede_ver'],
                });
            }
        }

        permisosByNivel = new Map(permisosNegocio.map((permiso) => [Number(permiso.id_nivel), permiso]));
    }

    const modulos = niveles.map((nivel) => {
        const permiso = permisosByNivel.get(Number(nivel.id_nivel));
        const subnivelesModulo = (subnivelesByModulo.get(Number(nivel.id_nivel)) || []).map((subnivel) => {
            const subPermiso = permisosByNivel.get(Number(subnivel.id_nivel));

            return {
                id_nivel: subnivel.id_nivel,
                codigo: normalizePermissionCode(subnivel.url),
                accion: subnivel.descripcion,
                puede_ver: Boolean(subPermiso?.puede_ver),
            };
        });

        return {
            id_nivel: nivel.id_nivel,
            modulo: nivel.descripcion,
            url: nivel.url,
            puede_ver: Boolean(permiso?.puede_ver),
            puede_crear: false,
            puede_editar: false,
            puede_eliminar: false,
            subniveles: subnivelesModulo,
        };
    });

    return {
        id_rol: rol.id_rol,
        descripcion: rol.descripcion,
        id_tipo_negocio: rol.id_tipo_negocio,
        id_negocio: idNegocio,
        modulos,
    };
}

async function syncPermisosUsuariosPorRol({ idRol, idNegocio = null, transaction }) {
    const where = {
        id_rol: idRol,
        estado: 'A',
    };

    if (idNegocio) {
        where.id_negocio = idNegocio;
    }

    const asignacionesRol = await Models.GenerUsuarioRol.findAll({
        where,
        attributes: ['id_usuario'],
        transaction,
    });

    const userIds = [...new Set(
        asignacionesRol
            .map((row) => Number(row.id_usuario))
            .filter((id) => Number.isInteger(id) && id > 0)
    )];

    for (const idUsuario of userIds) {
        await rebuildNivelesUsuario(idUsuario, transaction);
    }
}

async function savePermisosRol(idRol, modulos, transaction, { idNegocio = null } = {}) {
    const normalizedByNivel = new Map();

    for (const modulo of modulos || []) {
        const idNivel = Number(modulo?.id_nivel);
        if (!Number.isInteger(idNivel) || idNivel <= 0) continue;

        const puedeVerModulo = Boolean(modulo?.puede_ver);

        normalizedByNivel.set(idNivel, {
            id_nivel: idNivel,
            puede_ver: puedeVerModulo,
        });

        if (!Array.isArray(modulo?.subniveles)) continue;

        for (const subnivel of modulo.subniveles) {
            const idSubnivel = Number(subnivel?.id_nivel);
            if (!Number.isInteger(idSubnivel) || idSubnivel <= 0) continue;

            normalizedByNivel.set(idSubnivel, {
                id_nivel: idSubnivel,
                puede_ver: puedeVerModulo && Boolean(subnivel?.puede_ver),
            });
        }
    }

    let normalized = [...normalizedByNivel.values()];
    if (normalized.length === 0) return;

    const rol = await Models.GenerRol.findByPk(idRol, {
        attributes: ['id_rol', 'id_tipo_negocio'],
        transaction,
    });

    if (!rol) return;

    let tipoNegocio = Number(rol.id_tipo_negocio || 0) || null;

    if (idNegocio) {
        const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
            attributes: ['id_negocio', 'id_tipo_negocio'],
            transaction,
        });

        if (!negocio) return;

        const tipoNegocioNegocio = Number(negocio.id_tipo_negocio || 0) || null;
        if (tipoNegocio && tipoNegocioNegocio && tipoNegocio !== tipoNegocioNegocio) {
            return;
        }

        if (!tipoNegocio) {
            tipoNegocio = tipoNegocioNegocio;
        }
    }

    const validNiveles = await Models.GenerNivel.findAll({
        where: {
            estado: 'A',
            id_nivel: normalized.map((item) => item.id_nivel),
            ...(tipoNegocio ? { id_tipo_negocio: tipoNegocio } : {}),
        },
        attributes: ['id_nivel'],
        transaction,
    });

    const validIds = new Set(
        validNiveles
            .map((nivel) => Number(nivel.id_nivel))
            .filter((idNivel) => Number.isInteger(idNivel) && idNivel > 0)
    );

    normalized = normalized.filter((item) => validIds.has(Number(item.id_nivel)));
    if (normalized.length === 0) return;

    if (idNegocio) {
        for (const modulo of normalized) {
            const values = {
                id_negocio: idNegocio,
                id_rol: idRol,
                id_nivel: modulo.id_nivel,
                puede_ver: modulo.puede_ver,
                estado: 'A',
                fecha_actualizacion: new Date(),
            };

            const existing = await Models.GenerNivelNegocio.findOne({
                where: {
                    id_negocio: idNegocio,
                    id_rol: idRol,
                    id_nivel: modulo.id_nivel,
                },
                transaction,
            });

            if (existing) {
                await existing.update(values, { transaction });
            } else {
                await Models.GenerNivelNegocio.create(
                    {
                        ...values,
                        fecha_creacion: new Date(),
                    },
                    { transaction }
                );
            }
        }

        await syncPermisosUsuariosPorRol({ idRol, idNegocio, transaction });
        return;
    }

    // Compatibilidad legacy: si no llega negocio, actualiza la matriz global por rol.
    for (const modulo of normalized) {
        const values = {
            id_rol: idRol,
            id_nivel: modulo.id_nivel,
            puede_ver: modulo.puede_ver,
            puede_crear: false,
            puede_editar: false,
            puede_eliminar: false,
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

    await syncPermisosUsuariosPorRol({ idRol, transaction });
}

async function getPermisosEfectivosUsuario(idUsuario) {
    const usuario = await getUsuarioById(idUsuario);
    if (!usuario) return null;

    const rolesUsuario = [...new Set(
        (usuario.roles || [])
            .map((rol) => rol?.descripcion)
            .filter(Boolean)
    )].sort();

    const permisosUsuario = await Models.GenerNivelUsuario.findAll({
        where: {
            id_usuario: idUsuario,
        },
        attributes: ['id_nivel'],
        include: [
            {
                model: Models.GenerNivel,
                required: true,
                where: {
                    estado: 'A',
                    id_tipo_nivel: 1,
                    url: { [Op.ne]: null },
                },
                attributes: ['id_nivel', 'descripcion', 'url'],
            },
        ],
    });

    const grouped = new Map();
    for (const permiso of permisosUsuario) {
        const nivel = permiso.GenerNivel;
        const idNivel = Number(nivel?.id_nivel);
        if (!idNivel) continue;

        grouped.set(idNivel, {
            id_nivel: idNivel,
            vista: nivel.descripcion,
            url: nivel.url,
            roles: rolesUsuario,
            puede_ver: true,
            puede_crear: false,
            puede_editar: false,
            puede_eliminar: false,
        });
    }

    const permisosVista = [...grouped.values()].sort((a, b) => a.vista.localeCompare(b.vista));

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
    syncUsuarioRolActivo,
    rebuildNivelesUsuario,
};
