const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

/**
 * dashboardService — Lógica de negocio para el módulo restaurante.
 */

function normalizeRoutePath(url) {
    if (!url) return '/';
    const raw = String(url).split('?')[0].split('#')[0].trim();
    if (!raw) return '/';

    const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
    const normalized = withLeadingSlash.replace(/\/+/g, '/').replace(/\/+$/, '');
    return normalized || '/';
}

async function getPermisosVistaNegocio({ idUsuario, idNegocio, idTipoNegocio, rolesNegocio }) {
    const roleIds = [...new Set((rolesNegocio || []).map((r) => Number(r.id_rol)).filter(Number.isInteger))];

    let rolePermisos = [];
    if (roleIds.length > 0 && idNegocio) {
        rolePermisos = await Models.GenerNivelNegocio.findAll({
            where: {
                id_negocio: idNegocio,
                id_rol: roleIds,
                estado: 'A',
                puede_ver: true,
            },
            attributes: ['id_rol', 'id_nivel', 'puede_ver'],
            include: [
                {
                    model: Models.GenerNivel,
                    as: 'nivel',
                    required: true,
                    where: {
                        estado: 'A',
                        id_tipo_negocio: idTipoNegocio,
                        id_tipo_nivel: 1,
                        url: { [Op.ne]: null },
                    },
                    attributes: ['id_nivel', 'descripcion', 'url'],
                },
                {
                    model: Models.GenerRol,
                    as: 'rol',
                    required: false,
                    attributes: ['descripcion'],
                },
            ],
        });
    }

    // Compatibilidad: si no hay parametrización en gener_nivel_negocio,
    // usa la matriz global por rol para no bloquear accesos existentes.
    if (rolePermisos.length === 0 && roleIds.length > 0) {
        rolePermisos = await Models.GenerRolNivel.findAll({
            where: {
                id_rol: roleIds,
                estado: 'A',
                puede_ver: true,
            },
            attributes: ['id_rol', 'id_nivel', 'puede_ver', 'puede_crear', 'puede_editar', 'puede_eliminar'],
            include: [
                {
                    model: Models.GenerNivel,
                    as: 'nivel',
                    required: true,
                    where: {
                        estado: 'A',
                        id_tipo_negocio: idTipoNegocio,
                        id_tipo_nivel: 1,
                        url: { [Op.ne]: null },
                    },
                    attributes: ['id_nivel', 'descripcion', 'url'],
                },
                {
                    model: Models.GenerRol,
                    as: 'rol',
                    required: false,
                    attributes: ['descripcion'],
                },
            ],
        });
    }

    const permisosUsuarioDirectos = await Models.GenerNivelUsuario.findAll({
        where: { id_usuario: idUsuario },
        attributes: ['id_nivel'],
        include: [
            {
                model: Models.GenerNivel,
                required: true,
                where: {
                    estado: 'A',
                    id_tipo_negocio: idTipoNegocio,
                    url: { [Op.ne]: null },
                },
                attributes: ['id_nivel', 'descripcion', 'url'],
            },
        ],
    });

    const groupedByUrl = new Map();

    rolePermisos.forEach((permiso) => {
        const urlRaw = permiso.nivel?.url;
        const normalizedUrl = normalizeRoutePath(urlRaw);
        if (!normalizedUrl || normalizedUrl === '/auth') return;

        const current = groupedByUrl.get(normalizedUrl) || {
            id_nivel: permiso.nivel?.id_nivel,
            vista: permiso.nivel?.descripcion || 'Vista',
            url: normalizedUrl,
            roles: new Set(),
            puede_ver: false,
            puede_crear: false,
            puede_editar: false,
            puede_eliminar: false,
        };

        if (permiso.rol?.descripcion) {
            current.roles.add(permiso.rol.descripcion);
        }
        current.puede_ver = current.puede_ver || Boolean(permiso.puede_ver);
        current.puede_crear = current.puede_crear || Boolean(permiso.puede_crear);
        current.puede_editar = current.puede_editar || Boolean(permiso.puede_editar);
        current.puede_eliminar = current.puede_eliminar || Boolean(permiso.puede_eliminar);

        groupedByUrl.set(normalizedUrl, current);
    });

    permisosUsuarioDirectos.forEach((permisoDirecto) => {
        const nivel = permisoDirecto.GenerNivel;
        const normalizedUrl = normalizeRoutePath(nivel?.url);
        if (!normalizedUrl || normalizedUrl === '/auth') return;

        const current = groupedByUrl.get(normalizedUrl) || {
            id_nivel: nivel?.id_nivel,
            vista: nivel?.descripcion || 'Vista',
            url: normalizedUrl,
            roles: new Set(),
            puede_ver: false,
            puede_crear: false,
            puede_editar: false,
            puede_eliminar: false,
        };

        current.puede_ver = true;
        groupedByUrl.set(normalizedUrl, current);
    });

    return [...groupedByUrl.values()]
        .map((permiso) => ({
            id_nivel: permiso.id_nivel,
            vista: permiso.vista,
            url: permiso.url,
            roles: [...permiso.roles].sort(),
            puede_ver: permiso.puede_ver,
            puede_crear: permiso.puede_crear,
            puede_editar: permiso.puede_editar,
            puede_eliminar: permiso.puede_eliminar,
        }))
        .sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * Verifica que el usuario tenga acceso a al menos un negocio de tipo restaurante.
 * Retorna los datos del usuario, su negocio(s) de restaurante y roles.
 *
 * @param {number} idUsuario
 * @returns {Object|null} { usuario, negocio, roles } o null si no tiene acceso
 */
async function verificarAccesoRestaurante(idUsuario) {
    // 1. Obtener datos del usuario
    const usuario = await Models.GenerUsuario.findOne({
        where: { id_usuario: idUsuario, estado: 'A' },
        attributes: ['id_usuario', 'primer_nombre', 'segundo_nombre', 'primer_apellido',
                     'segundo_apellido', 'email', 'num_identificacion'],
    });

    if (!usuario) return null;

    // 2. Obtener negocios del usuario que sean de tipo restaurante
    // (tipo_negocio con nombre que contenga "restaurante" o similar)
    const negociosUsuario = await Models.GenerNegocioUsuario.findAll({
        where: { id_usuario: idUsuario, estado: 'A' },
        include: [{
            model: Models.GenerNegocio,
            as: 'negocio',
            where: { estado: 'A' },
            required: true,
            include: [
                {
                    model: Models.GenerTipoNegocio,
                    as: 'tipoNegocio',
                    attributes: ['id_tipo_negocio', 'nombre'],
                },
                {
                    model: Models.GenerPaletaColor,
                    as: 'paletaColor',
                    attributes: ['id_paleta', 'nombre', 'colores'],
                },
            ],
            attributes: ['id_negocio', 'nombre', 'id_tipo_negocio', 'id_paleta'],
        }],
    });

    if (!negociosUsuario || negociosUsuario.length === 0) return null;

    // 3. Obtener roles del usuario en esos negocios
    const idNegocios = negociosUsuario.map(nu => nu.negocio.id_negocio);

    const rolesUsuario = await Models.GenerUsuarioRol.findAll({
        where: { id_usuario: idUsuario, estado: 'A', id_negocio: idNegocios },
        include: [{
            model: Models.GenerRol,
            as: 'rol',
            attributes: ['id_rol', 'descripcion'],
        }],
    });

    // Roles globales (sin negocio asociado, ej: Super Admin)
    const rolesGlobales = await Models.GenerUsuarioRol.findAll({
        where: { id_usuario: idUsuario, estado: 'A', id_negocio: null },
        include: [{ model: Models.GenerRol, as: 'rol', attributes: ['id_rol', 'descripcion'] }],
    });

    const rolesGlobalesMap = rolesGlobales.map(r => ({
        id_rol: r.rol.id_rol,
        descripcion: r.rol.descripcion,
    }));

    // Agrupar por negocio
    const negocios = await Promise.all(negociosUsuario.map(async (nu) => {
        const negocio = nu.negocio;
        const roles = rolesUsuario
            .filter(r => r.id_negocio === negocio.id_negocio)
            .map(r => ({ id_rol: r.rol.id_rol, descripcion: r.rol.descripcion }));

        const permisosVista = await getPermisosVistaNegocio({
            idUsuario,
            idNegocio: negocio.id_negocio,
            idTipoNegocio: negocio.id_tipo_negocio,
            rolesNegocio: [...roles, ...rolesGlobalesMap],
        });

        return {
            id_negocio: negocio.id_negocio,
            nombre: negocio.nombre,
            tipo_negocio: negocio.tipoNegocio
                ? negocio.tipoNegocio.nombre
                : null,
            paleta: negocio.paletaColor || null,
            roles,
            permisos_vista: permisosVista,
        };
    }));

    return {
        usuario: {
            id_usuario: usuario.id_usuario,
            nombre_completo: `${usuario.primer_nombre} ${usuario.primer_apellido}`,
            primer_nombre: usuario.primer_nombre,
            primer_apellido: usuario.primer_apellido,
            email: usuario.email,
        },
        permisos_cargados: true,
        negocios,
        negocio: negocios[0] || null, // Negocio principal (el primero)
        roles: negocios[0]?.roles || [],
        permisos_vista: negocios[0]?.permisos_vista || [],
        roles_globales: rolesGlobalesMap,
    };
}

function dayRange(daysOffset = 0) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + daysOffset);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
}

function calcTrend(current, previous) {
    if (!previous) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
}

function formatHora(fecha) {
    if (!fecha) return '--:--';
    const dt = new Date(fecha);
    const hh = String(dt.getHours()).padStart(2, '0');
    const mm = String(dt.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

function mapEstadoOrden(orden) {
    if (orden.estado === 'CERRADA') return 'cobrado';
    if (orden.estado_cocina === 'LISTO') return 'listo';
    if (orden.estado_cocina === 'EN_PREPARACION' || orden.estado_cocina === 'PENDIENTE') return 'preparando';
    return 'pendiente';
}

/**
 * Obtiene datos resumidos reales para el dashboard.
 *
 * @param {number} idUsuario
 * @param {number|null} idNegocio
 * @returns {Object}
 */
async function getResumenDashboard(idUsuario, idNegocio = null) {
    const acceso = await verificarAccesoRestaurante(idUsuario);
    if (!acceso?.negocios?.length) {
        throw new Error('Usuario sin acceso a negocios restaurante');
    }

    const negocioActivo = idNegocio
        ? acceso.negocios.find((n) => n.id_negocio === Number(idNegocio))
        : acceso.negocio;

    if (!negocioActivo) {
        throw new Error('El negocio solicitado no pertenece al usuario');
    }

    const negocioId = negocioActivo.id_negocio;
    const hoy = dayRange(0);
    const ayer = dayRange(-1);

    const [
        ventasHoyRaw,
        ventasAyerRaw,
        pedidosHoy,
        pedidosAyer,
        ordenesAbiertas,
        cocinaPendiente,
        cocinaPreparacion,
        cocinaListo,
        mesasActivas,
        mesasOcupadas,
        mesasPorCobrar,
        ultimasOrdenes,
        ventasPorHoraRaw,
    ] = await Promise.all([
        Models.PedidOrden.sum('total', {
            where: {
                id_negocio: negocioId,
                estado: 'CERRADA',
                fecha_cierre: { [Op.gte]: hoy.start, [Op.lt]: hoy.end },
            },
        }),
        Models.PedidOrden.sum('total', {
            where: {
                id_negocio: negocioId,
                estado: 'CERRADA',
                fecha_cierre: { [Op.gte]: ayer.start, [Op.lt]: ayer.end },
            },
        }),
        Models.PedidOrden.count({
            where: {
                id_negocio: negocioId,
                fecha_creacion: { [Op.gte]: hoy.start, [Op.lt]: hoy.end },
            },
        }),
        Models.PedidOrden.count({
            where: {
                id_negocio: negocioId,
                fecha_creacion: { [Op.gte]: ayer.start, [Op.lt]: ayer.end },
            },
        }),
        Models.PedidOrden.count({ where: { id_negocio: negocioId, estado: 'ABIERTA' } }),
        Models.PedidOrden.count({ where: { id_negocio: negocioId, estado: 'ABIERTA', estado_cocina: 'PENDIENTE' } }),
        Models.PedidOrden.count({ where: { id_negocio: negocioId, estado: 'ABIERTA', estado_cocina: 'EN_PREPARACION' } }),
        Models.PedidOrden.count({ where: { id_negocio: negocioId, estado: 'ABIERTA', estado_cocina: 'LISTO' } }),
        Models.RestMesa.count({ where: { id_negocio: negocioId, estado: 'A' } }),
        Models.RestMesa.count({ where: { id_negocio: negocioId, estado: 'A', estado_servicio: 'OCUPADA' } }),
        Models.RestMesa.count({ where: { id_negocio: negocioId, estado: 'A', estado_servicio: 'POR_COBRAR' } }),
        Models.PedidOrden.findAll({
            where: { id_negocio: negocioId },
            attributes: ['id_orden', 'numero_orden', 'total', 'estado', 'estado_cocina', 'fecha_creacion'],
            include: [
                {
                    model: Models.RestMesa,
                    as: 'mesaRef',
                    attributes: ['nombre', 'numero'],
                    required: false,
                },
                {
                    model: Models.PedidDetalle,
                    as: 'detalles',
                    attributes: ['cantidad'],
                    include: [{
                        model: Models.CartaProducto,
                        as: 'producto',
                        attributes: ['nombre'],
                    }],
                },
            ],
            order: [['fecha_creacion', 'DESC']],
            limit: 8,
        }),
        Models.sequelize.query(
            `
              SELECT TO_CHAR(fecha_cierre, 'HH24:00') AS hora,
                     COALESCE(SUM(total), 0)::numeric AS total
              FROM restaurante.pedid_orden
              WHERE id_negocio = :idNegocio
                AND estado = 'CERRADA'
                AND fecha_cierre >= :inicio
                AND fecha_cierre < :fin
              GROUP BY 1
              ORDER BY 1
            `,
            {
                replacements: {
                    idNegocio: negocioId,
                    inicio: hoy.start,
                    fin: hoy.end,
                },
                type: Models.sequelize.QueryTypes.SELECT,
            }
        ),
    ]);

    const ventasHoy = Number(ventasHoyRaw || 0);
    const ventasAyer = Number(ventasAyerRaw || 0);

    return {
        negocio: {
            id_negocio: negocioActivo.id_negocio,
            nombre: negocioActivo.nombre,
        },
        kpis: {
            ventas_hoy: {
                valor: ventasHoy,
                valor_ayer: ventasAyer,
                tendencia: calcTrend(ventasHoy, ventasAyer),
            },
            pedidos_hoy: {
                valor: pedidosHoy,
                valor_ayer: pedidosAyer,
                tendencia: calcTrend(pedidosHoy, pedidosAyer),
            },
            ordenes_abiertas: {
                valor: ordenesAbiertas,
            },
            mesas_ocupadas: {
                ocupadas: mesasOcupadas,
                total: mesasActivas,
                porcentaje: mesasActivas > 0 ? Math.round((mesasOcupadas / mesasActivas) * 100) : 0,
            },
            mesas_por_cobrar: {
                valor: mesasPorCobrar,
            },
        },
        estado_cocina: {
            pendiente: cocinaPendiente,
            en_preparacion: cocinaPreparacion,
            listo: cocinaListo,
        },
        ultimos_pedidos: ultimasOrdenes.map((orden) => {
            const itemsResumen = (orden.detalles || [])
                .map((d) => {
                    const cantidad = Number(d.cantidad || 1);
                    const nombre = d.producto?.nombre || 'Producto';
                    return `${cantidad}x ${nombre}`;
                })
                .slice(0, 3)
                .join(', ');

            return {
                id: orden.numero_orden || `#${orden.id_orden}`,
                mesa: orden.mesaRef
                    ? `Mesa ${orden.mesaRef.numero}`
                    : 'Para llevar',
                items: itemsResumen || 'Sin items',
                total: Number(orden.total || 0),
                estado: mapEstadoOrden(orden),
                hora: formatHora(orden.fecha_creacion),
            };
        }),
        ventas_por_hora: ventasPorHoraRaw.map((v) => ({
            hora: v.hora,
            total: Number(v.total || 0),
        })),
    };
}

module.exports = {
    verificarAccesoRestaurante,
    getResumenDashboard,
};
