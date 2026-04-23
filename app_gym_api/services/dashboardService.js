'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

/**
 * dashboardService — acceso, sesión y KPIs del módulo Gimnasio.
 *
 * Filtra estrictamente a negocios con id_tipo_negocio = (GIMNASIO) para que
 * usuarios multi-rubro no vean restaurantes/parqueaderos al entrar al gym.
 */

const TIPO_NEGOCIO_NOMBRE = 'GIMNASIO';

function normalizeRoutePath(url) {
    if (!url) return '/';
    const raw = String(url).split('?')[0].split('#')[0].trim();
    if (!raw) return '/';
    const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
    return withSlash.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
}

async function getPermisosVistaNegocio({ idUsuario, idNegocio, idTipoNegocio, rolesNegocio }) {
    const roleIds = [...new Set((rolesNegocio || []).map(r => Number(r.id_rol)).filter(Number.isInteger))];
    let rolePermisos = [];

    if (idNegocio && roleIds.length > 0) {
        rolePermisos = await Models.GenerNivelNegocio.findAll({
            where: { id_negocio: idNegocio, id_rol: roleIds, estado: 'A', puede_ver: true },
            attributes: ['id_rol', 'id_nivel', 'puede_ver'],
            include: [
                {
                    model: Models.GenerNivel, as: 'nivel', required: true,
                    where: { estado: 'A', id_tipo_negocio: idTipoNegocio, id_tipo_nivel: 1, url: { [Op.ne]: null } },
                    attributes: ['id_nivel', 'descripcion', 'url'],
                },
                { model: Models.GenerRol, as: 'rol', required: false, attributes: ['descripcion'] },
            ],
        });
    }

    if (rolePermisos.length === 0 && roleIds.length > 0) {
        rolePermisos = await Models.GenerRolNivel.findAll({
            where: { id_rol: roleIds, estado: 'A', puede_ver: true },
            attributes: ['id_rol', 'id_nivel', 'puede_ver', 'puede_crear', 'puede_editar', 'puede_eliminar'],
            include: [
                {
                    model: Models.GenerNivel, as: 'nivel', required: true,
                    where: { estado: 'A', id_tipo_negocio: idTipoNegocio, id_tipo_nivel: 1, url: { [Op.ne]: null } },
                    attributes: ['id_nivel', 'descripcion', 'url'],
                },
                { model: Models.GenerRol, as: 'rol', required: false, attributes: ['descripcion'] },
            ],
        });
    }

    const grouped = new Map();
    rolePermisos.forEach((p) => {
        const url = normalizeRoutePath(p.nivel?.url);
        if (!url || url === '/gimnasio') return;
        const cur = grouped.get(url) || {
            id_nivel: p.nivel?.id_nivel,
            vista: p.nivel?.descripcion || 'Vista',
            url,
            roles: new Set(),
            puede_ver: false, puede_crear: false, puede_editar: false, puede_eliminar: false,
        };
        if (p.rol?.descripcion) cur.roles.add(p.rol.descripcion);
        cur.puede_ver      = cur.puede_ver      || Boolean(p.puede_ver);
        cur.puede_crear    = cur.puede_crear    || Boolean(p.puede_crear);
        cur.puede_editar   = cur.puede_editar   || Boolean(p.puede_editar);
        cur.puede_eliminar = cur.puede_eliminar || Boolean(p.puede_eliminar);
        grouped.set(url, cur);
    });

    return [...grouped.values()].map(p => ({
        id_nivel: p.id_nivel, vista: p.vista, url: p.url,
        roles: [...p.roles].sort(),
        puede_ver: p.puede_ver, puede_crear: p.puede_crear,
        puede_editar: p.puede_editar, puede_eliminar: p.puede_eliminar,
    })).sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * Verifica acceso del usuario a negocios de tipo GIMNASIO.
 * Devuelve la sesión completa con negocios + permisos por negocio.
 */
async function verificarAccesoGym(idUsuario) {
    const usuario = await Models.GenerUsuario.findOne({
        where: { id_usuario: idUsuario, estado: 'A' },
        attributes: ['id_usuario', 'primer_nombre', 'segundo_nombre', 'primer_apellido', 'segundo_apellido', 'email'],
    });
    if (!usuario) return null;

    const negociosUsuario = await Models.GenerNegocioUsuario.findAll({
        where: { id_usuario: idUsuario, estado: 'A' },
        include: [{
            model: Models.GenerNegocio, as: 'negocio', required: true,
            where: { estado: 'A' },
            include: [
                {
                    model: Models.GenerTipoNegocio, as: 'tipoNegocio',
                    where: { nombre: TIPO_NEGOCIO_NOMBRE },
                    required: true,
                    attributes: ['id_tipo_negocio', 'nombre'],
                },
                { model: Models.GenerPaletaColor, as: 'paletaColor', attributes: ['id_paleta', 'nombre', 'colores'] },
            ],
            attributes: ['id_negocio', 'nombre', 'id_tipo_negocio', 'id_paleta'],
        }],
    });

    if (!negociosUsuario.length) return null;

    const idNegocios = negociosUsuario.map(nu => nu.negocio.id_negocio);

    const rolesUsuario = await Models.GenerUsuarioRol.findAll({
        where: { id_usuario: idUsuario, estado: 'A', id_negocio: idNegocios },
        include: [{ model: Models.GenerRol, as: 'rol', attributes: ['id_rol', 'descripcion'] }],
    });
    const rolesGlobales = await Models.GenerUsuarioRol.findAll({
        where: { id_usuario: idUsuario, estado: 'A', id_negocio: null },
        include: [{ model: Models.GenerRol, as: 'rol', attributes: ['id_rol', 'descripcion'] }],
    });
    const rolesGlobalesMap = rolesGlobales.map(r => ({ id_rol: r.rol.id_rol, descripcion: r.rol.descripcion }));

    const negocios = await Promise.all(negociosUsuario.map(async (nu) => {
        const neg = nu.negocio;
        const roles = rolesUsuario
            .filter(r => r.id_negocio === neg.id_negocio)
            .map(r => ({ id_rol: r.rol.id_rol, descripcion: r.rol.descripcion }));
        const rolesContexto = [...roles, ...rolesGlobalesMap];

        const permisos_vista = await getPermisosVistaNegocio({
            idUsuario, idNegocio: neg.id_negocio,
            idTipoNegocio: neg.id_tipo_negocio, rolesNegocio: rolesContexto,
        });

        return {
            id_negocio: neg.id_negocio,
            nombre: neg.nombre,
            tipo_negocio: neg.tipoNegocio?.nombre || null,
            paleta: neg.paletaColor || null,
            roles,
            permisos_vista,
            permisos_subnivel: [],
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
        negocio: negocios[0] || null,
        roles: negocios[0]?.roles || [],
        permisos_vista: negocios[0]?.permisos_vista || [],
        permisos_subnivel: [],
        roles_globales: rolesGlobalesMap,
    };
}

// ────────────────────────── KPIs del dashboard ──────────────────────────

function startOfTodayLocal() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}
function startOfDaysAgo(days) {
    const d = startOfTodayLocal();
    d.setDate(d.getDate() - days);
    return d;
}

async function getResumenDashboard(idNegocio) {
    if (!idNegocio) throw new Error('id_negocio requerido');

    const inicioHoy = startOfTodayLocal();
    const inicioMes = (() => { const d = startOfTodayLocal(); d.setDate(1); return d; })();
    const en5dias = (() => { const d = startOfTodayLocal(); d.setDate(d.getDate() + 5); return d; })();
    const finHoy = (() => { const d = new Date(inicioHoy); d.setDate(d.getDate() + 1); return d; })();

    const [
        totalActivos,
        asistenciasHoy,
        ingresosHoyRow,
        ingresosMesRow,
        proximosVencen,
        ocupacionActual,
    ] = await Promise.all([
        Models.GymMiembro.count({ where: { id_negocio: idNegocio, estado: 'ACTIVO' } }),
        Models.GymAsistencia.count({
            where: { id_negocio: idNegocio, fecha_entrada: { [Op.gte]: inicioHoy, [Op.lt]: finHoy } },
        }),
        Models.GymPago.findOne({
            attributes: [[Models.sequelize.fn('COALESCE', Models.sequelize.fn('SUM', Models.sequelize.col('monto')), 0), 'total']],
            where: { id_negocio: idNegocio, estado: 'PAGADO', fecha_pago: { [Op.gte]: inicioHoy, [Op.lt]: finHoy } },
            raw: true,
        }),
        Models.GymPago.findOne({
            attributes: [[Models.sequelize.fn('COALESCE', Models.sequelize.fn('SUM', Models.sequelize.col('monto')), 0), 'total']],
            where: { id_negocio: idNegocio, estado: 'PAGADO', fecha_pago: { [Op.gte]: inicioMes } },
            raw: true,
        }),
        Models.GymMembresia.count({
            where: {
                id_negocio: idNegocio,
                estado: 'ACTIVA',
                fecha_fin: { [Op.gte]: inicioHoy, [Op.lt]: en5dias },
            },
        }),
        Models.GymAsistencia.count({
            where: { id_negocio: idNegocio, fecha_salida: null },
        }),
    ]);

    return {
        miembros_activos: totalActivos,
        asistencias_hoy: asistenciasHoy,
        ingresos_hoy: Number(ingresosHoyRow?.total ?? 0),
        ingresos_mes: Number(ingresosMesRow?.total ?? 0),
        proximos_vencen_5d: proximosVencen,
        ocupacion_actual: ocupacionActual,
    };
}

module.exports = { verificarAccesoGym, getResumenDashboard };
