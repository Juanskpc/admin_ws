'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

/**
 * dashboardService — acceso, sesión y KPIs del módulo Reserva.
 *
 * Filtra estrictamente a negocios con id_tipo_negocio = (RESERVA) para que
 * usuarios multi-rubro no vean restaurantes/gym al entrar al módulo de reservas.
 */

const TIPO_NEGOCIO_NOMBRE = 'RESERVA';

function normalizeRoutePath(url) {
    if (!url) return '/';
    const raw = String(url).split('?')[0].split('#')[0].trim();
    if (!raw) return '/';
    const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
    return withSlash.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
}

/**
 * Permisos de vista de un usuario dentro de un negocio.
 *
 * ## Las dos tablas responden preguntas distintas, y confundirlas dejaba la app en solo lectura
 *
 * - `gener_rol_nivel` es la **plantilla del rol**: qué puede *hacer* un ADMINISTRADOR. Tiene las
 *   cuatro banderas (ver, crear, editar, eliminar).
 * - `gener_nivel_negocio` es el **ajuste por negocio**: qué vistas están habilitadas en *este*
 *   negocio. Solo tiene `puede_ver` — no existen columnas para las otras tres.
 *
 * Antes se leía la segunda tabla **en lugar de** la primera cuando había filas, y como de ahí solo
 * sale `puede_ver`, las otras tres quedaban en `false` para todo el mundo, incluido el
 * administrador. En la interfaz eso se ve como una pantalla sin un solo botón de acción: se puede
 * mirar la agenda y no se puede confirmar ni cancelar una cita. La plantilla del rol decía que sí
 * y nadie la leía.
 *
 * Y no saltaba siempre, que es lo que lo hizo difícil de ver: la consulta de respaldo solo corría
 * **cuando la primera no devolvía nada**. Un negocio sin ajustes propios funcionaba perfecto; uno
 * con ajustes —los que crea `migrate_reserva.js` para cada negocio del tipo— quedaba mudo.
 *
 * Ahora cada tabla hace lo suyo: la plantilla del rol aporta **lo que se puede hacer**, y los
 * ajustes del negocio actúan como **filtro de qué vistas se ven**. Sin ajustes, se ve todo lo que
 * el rol permita, que es el comportamiento que ya había.
 *
 * ⚠️ Esta misma función está copiada en `app_gym_api`, `app_restaurante_api` y `app_tienda_api`
 * con el mismo fallo. Se arregla aquí porque es donde se detectó; las otras tres siguen igual.
 */
async function getPermisosVistaNegocio({ idNegocio, idTipoNegocio, rolesNegocio }) {
    const roleIds = [...new Set((rolesNegocio || []).map(r => Number(r.id_rol)).filter(Number.isInteger))];
    if (roleIds.length === 0) return [];

    // Qué puede hacer cada rol. Única fuente de las cuatro banderas.
    const rolePermisos = await Models.GenerRolNivel.findAll({
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

    // Qué vistas habilita este negocio. Si no dice nada, no recorta nada.
    let habilitadasPorNegocio = null;
    if (idNegocio) {
        const ajustes = await Models.GenerNivelNegocio.findAll({
            where: { id_negocio: idNegocio, id_rol: roleIds, estado: 'A', puede_ver: true },
            attributes: ['id_rol', 'id_nivel'],
        });
        if (ajustes.length > 0) {
            habilitadasPorNegocio = new Set(ajustes.map(a => `${a.id_rol}:${a.id_nivel}`));
        }
    }

    const grouped = new Map();
    rolePermisos.forEach((p) => {
        const url = normalizeRoutePath(p.nivel?.url);
        if (!url || url === '/reserva') return;
        if (habilitadasPorNegocio && !habilitadasPorNegocio.has(`${p.id_rol}:${p.id_nivel}`)) return;
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

async function verificarAccesoReserva(idUsuario) {
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
            idNegocio: neg.id_negocio,
            idTipoNegocio: neg.id_tipo_negocio,
            rolesNegocio: rolesContexto,
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

async function getResumenDashboard(idNegocio) {
    if (!idNegocio) throw new Error('id_negocio requerido');

    const inicioHoy = startOfTodayLocal();
    const finHoy = (() => { const d = new Date(inicioHoy); d.setDate(d.getDate() + 1); return d; })();

    const [
        citasHoy,
        citasConfirmadas,
        citasPendientes,
        ingresosHoyRow,
        totalServicios,
        totalProfesionales,
        pagosPendientes,
    ] = await Promise.all([
        Models.ReservaCita.count({
            where: { id_negocio: idNegocio,
                     fecha_hora_inicio: { [Op.gte]: inicioHoy, [Op.lt]: finHoy },
                     estado: { [Op.notIn]: ['cancelada'] } },
        }),
        Models.ReservaCita.count({
            where: { id_negocio: idNegocio, estado: 'confirmada',
                     fecha_hora_inicio: { [Op.gte]: inicioHoy, [Op.lt]: finHoy } },
        }),
        Models.ReservaCita.count({
            where: { id_negocio: idNegocio, estado: 'pendiente',
                     fecha_hora_inicio: { [Op.gte]: inicioHoy, [Op.lt]: finHoy } },
        }),
        Models.ReservaCita.findOne({
            attributes: [[Models.sequelize.fn('COALESCE', Models.sequelize.fn('SUM', Models.sequelize.col('monto_total')), 0), 'total']],
            where: {
                id_negocio: idNegocio,
                estado: { [Op.in]: ['confirmada', 'completada'] },
                fecha_hora_inicio: { [Op.gte]: inicioHoy, [Op.lt]: finHoy },
            },
            raw: true,
        }),
        Models.ReservaServicio.count({ where: { id_negocio: idNegocio, estado: 'A' } }),
        Models.ReservaProfesional.count({ where: { id_negocio: idNegocio, estado: 'A' } }),
        Models.ReservaCita.count({
            where: { id_negocio: idNegocio, pago_estado: 'pendiente_validacion' },
        }),
    ]);

    return {
        citas_hoy:          citasHoy,
        citas_confirmadas:  citasConfirmadas,
        citas_pendientes:   citasPendientes,
        ingresos_hoy:       Number(ingresosHoyRow?.total ?? 0),
        total_servicios:    totalServicios,
        total_profesionales: totalProfesionales,
        pagos_pendientes_validacion: pagosPendientes,
    };
}

module.exports = { verificarAccesoReserva, getResumenDashboard };
