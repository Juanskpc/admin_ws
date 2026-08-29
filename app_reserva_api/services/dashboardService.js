'use strict';
const Models = require('../../app_core/models/conection');
const Reglas = require('./reglasAgenda');
const { getIdsConPlanActivo } = require('../../app_core/helpers/planHelper');
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

    // Que vistas habilita este negocio. Si no dice nada, no recorta nada.
    //
    // NO es una simple interseccion, y el motivo se midio en produccion el 2026-08-24: en
    // ZONA BURGER el CAJERO pasaba de 7 vistas a 2 y el MESERO de 3 a 1 (perdia MESAS y
    // PEDIDOS). `gener_nivel_negocio` habilita pares (rol, nivel) que `gener_rol_nivel` no
    // tiene, y la interseccion los tiraba. Que el dueño habilite una vista para un rol es una
    // decision explicita suya: el ajuste del negocio tambien puede AÑADIR. Sin plantilla de
    // rol, la vista se conserva con `puede_ver` y sin acciones -- el comportamiento actual.
    // Asi el arreglo es estrictamente aditivo. Ver app_restaurante_api para el detalle.
    let habilitadasPorNegocio = null;
    let ajustes = [];
    if (idNegocio) {
        ajustes = await Models.GenerNivelNegocio.findAll({
            where: { id_negocio: idNegocio, id_rol: roleIds, estado: 'A', puede_ver: true },
            attributes: ['id_rol', 'id_nivel'],
            include: [
                {
                    model: Models.GenerNivel, as: 'nivel', required: true,
                    where: {
                        estado: 'A', id_tipo_negocio: idTipoNegocio,
                        id_tipo_nivel: 1, url: { [Op.ne]: null },
                    },
                    attributes: ['id_nivel', 'descripcion', 'url'],
                },
                { model: Models.GenerRol, as: 'rol', required: false, attributes: ['descripcion'] },
            ],
        });
        if (ajustes.length > 0) {
            habilitadasPorNegocio = new Set(ajustes.map(a => `${a.id_rol}:${a.id_nivel}`));
        }
    }

    // Los pares que SI tienen plantilla de rol.
    const conPlantillaDeRol = new Set(rolePermisos.map(p => `${p.id_rol}:${p.id_nivel}`));

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

    // Vistas habilitadas por el negocio sin plantilla de rol: visibles, sin acciones.
    ajustes.forEach((a) => {
        if (conPlantillaDeRol.has(`${a.id_rol}:${a.id_nivel}`)) return;
        const url = normalizeRoutePath(a.nivel?.url);
        if (!url || url === '/reserva') return;
        const cur = grouped.get(url) || {
            id_nivel: a.nivel?.id_nivel,
            vista: a.nivel?.descripcion || 'Vista',
            url,
            roles: new Set(),
            puede_ver: false, puede_crear: false, puede_editar: false, puede_eliminar: false,
        };
        if (a.rol?.descripcion) cur.roles.add(a.rol.descripcion);
        cur.puede_ver = true;
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
 * Permisos **por acción** del usuario dentro de un negocio.
 *
 * Los subniveles (`gener_nivel` con `id_tipo_nivel = 4`) son las operaciones que hay dentro de
 * una vista: agendar, cancelar, cerrar caja… Su `url` es el código que consulta el frontend
 * (`/citas/cancelar` → `citas_cancelar`).
 *
 * Sigue la misma regla que las vistas: el ajuste del negocio manda si existe, y si el negocio no
 * ha dicho nada se cae a la plantilla del rol. La diferencia con `getPermisosVistaNegocio` es
 * que aquí el ajuste **no puede añadir** acciones que el rol no tenga: una vista de más solo
 * enseña información, una acción de más deja cancelar citas a quien no debía.
 */
async function getPermisosSubnivelNegocio({ idNegocio, idTipoNegocio, rolesNegocio }) {
    const roleIds = [...new Set((rolesNegocio || []).map(r => Number(r.id_rol)).filter(Number.isInteger))];
    if (roleIds.length === 0) return [];

    const incluirNivel = {
        model: Models.GenerNivel, as: 'nivel', required: true,
        where: {
            estado: 'A', id_tipo_negocio: idTipoNegocio,
            id_tipo_nivel: 4, url: { [Op.ne]: null },
        },
        attributes: ['id_nivel', 'descripcion', 'url', 'id_nivel_padre'],
    };

    const ajustes = idNegocio
        ? await Models.GenerNivelNegocio.findAll({
            where: { id_negocio: idNegocio, id_rol: roleIds, estado: 'A', puede_ver: true },
            attributes: ['id_rol', 'id_nivel', 'puede_ver'],
            include: [incluirNivel],
        })
        : [];

    const fuente = ajustes.length > 0
        ? ajustes
        : await Models.GenerRolNivel.findAll({
            where: { id_rol: roleIds, estado: 'A', puede_ver: true },
            attributes: ['id_rol', 'id_nivel', 'puede_ver'],
            include: [incluirNivel],
        });

    // Con varios roles gana el más permisivo: es la misma unión que ya aplica a las vistas.
    const porCodigo = new Map();
    for (const p of fuente) {
        const codigo = normalizarCodigoAccion(p.nivel?.url);
        if (!codigo) continue;
        const actual = porCodigo.get(codigo) ?? {
            id_nivel: p.nivel.id_nivel,
            codigo,
            accion: p.nivel.descripcion || 'Acción',
            id_nivel_padre: p.nivel.id_nivel_padre,
            puede_ver: false,
        };
        actual.puede_ver = actual.puede_ver || Boolean(p.puede_ver);
        porCodigo.set(codigo, actual);
    }

    return [...porCodigo.values()].sort((a, b) => a.codigo.localeCompare(b.codigo));
}

/**
 * `/citas/no-show` → `citas_no_show`.
 *
 * Se normaliza también el **guion**, no solo la barra. Sin eso el código quedaba
 * `citas_no-show` y no casaba con el que consulta la interfaz (`citas_no_show`): la
 * comprobación devolvía `false` siempre y la acción parecía denegada aun estando concedida.
 */
function normalizarCodigoAccion(url) {
    if (!url) return '';
    return String(url).trim().toLowerCase().replace(/^\/+/, '').replace(/[/-]/g, '_');
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

    // El plan se resuelve **por negocio**, en una sola consulta para todos.
    //
    // Antes solo existía un `plan_activo` suelto en la raíz de la sesión, y lo fijaba
    // únicamente `canjearCodigo`. Eso dejaba dos agujeros: `verificarTokenAcceso` devolvía la
    // sesión sin el campo —así que al revalidar el token el front leía `undefined`, lo trataba
    // como `false` y bloqueaba la app de un negocio que sí paga—, y con varios negocios la
    // bandera se quedaba con el plan del primero aunque el usuario cambiara de inquilino.
    const idsConPlan = await getIdsConPlanActivo(idNegocios);

    const negocios = await Promise.all(negociosUsuario.map(async (nu) => {
        const neg = nu.negocio;
        const roles = rolesUsuario
            .filter(r => r.id_negocio === neg.id_negocio)
            .map(r => ({ id_rol: r.rol.id_rol, descripcion: r.rol.descripcion }));
        const rolesContexto = [...roles, ...rolesGlobalesMap];

        const [permisos_vista, permisos_subnivel] = await Promise.all([
            getPermisosVistaNegocio({
                idNegocio: neg.id_negocio,
                idTipoNegocio: neg.id_tipo_negocio,
                rolesNegocio: rolesContexto,
            }),
            getPermisosSubnivelNegocio({
                idNegocio: neg.id_negocio,
                idTipoNegocio: neg.id_tipo_negocio,
                rolesNegocio: rolesContexto,
            }),
        ]);

        return {
            id_negocio: neg.id_negocio,
            nombre: neg.nombre,
            tipo_negocio: neg.tipoNegocio?.nombre || null,
            paleta: neg.paletaColor || null,
            roles,
            permisos_vista,
            permisos_subnivel,
            plan_activo: idsConPlan.has(neg.id_negocio),
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
        permisos_subnivel: negocios[0]?.permisos_subnivel || [],
        roles_globales: rolesGlobalesMap,
        // Se conserva en la raíz por compatibilidad con lo que ya leía el front; la fuente
        // buena es el `plan_activo` de cada negocio.
        plan_activo: negocios[0]?.plan_activo ?? false,
    };
}


// ────────────────────────── KPIs del dashboard ──────────────────────────

/**
 * El «hoy» del dashboard es el de Bogotá, no el del proceso.
 *
 * `new Date().setHours(0,0,0,0)` daba la medianoche de la zona del proceso Node. En el VPS,
 * que corre en UTC, eso son las 19:00 del día anterior en hora de pared: entre las 19:00 y la
 * medianoche el dashboard contaba las citas del día siguiente y daba «0 citas hoy» con la
 * agenda llena. Se usa la misma aritmética anclada en -05:00 que el resto del módulo
 * (`reglasAgenda`), que es la que ya define qué día es cada cita.
 */
function rangoDelDia(fechaISO) {
    const inicio = Reglas.inicioDelDia(fechaISO);
    return [inicio, Reglas.addMinutes(inicio, 24 * 60)];
}

const ESTADOS_ACTIVOS = ['pendiente', 'confirmada', 'completada'];
const ESTADOS_QUE_FACTURAN = ['confirmada', 'completada'];

/**
 * KPIs, agenda del día y tendencias del negocio.
 *
 * Además de los contadores, devuelve lo que hace falta para que la pantalla sea accionable en
 * vez de decorativa: las citas de hoy con su cliente, el porcentaje de la jornada realmente
 * ocupado, el acumulado de los últimos 7 días y los servicios que más se piden. Todo en una
 * sola llamada — el dashboard es la primera pantalla y encadenar peticiones ahí se nota.
 */
async function getResumenDashboard(idNegocio) {
    if (!idNegocio) throw new Error('id_negocio requerido');

    const hoyISO = Reglas.fechaISOLocal(new Date());
    const [inicioHoy, finHoy] = rangoDelDia(hoyISO);
    const inicioSemana = Reglas.addMinutes(inicioHoy, -6 * 24 * 60);   // hoy + 6 días atrás
    const inicioMes30 = Reglas.addMinutes(inicioHoy, -29 * 24 * 60);

    const enHoy = { [Op.gte]: inicioHoy, [Op.lt]: finHoy };

    const [
        citasHoy,
        citasConfirmadas,
        citasPendientes,
        citasCompletadasHoy,
        citasCanceladasHoy,
        ingresosHoyRow,
        totalServicios,
        totalProfesionales,
        pagosPendientes,
        semana,
        agendaHoy,
        topServicios,
        ocupacion,
    ] = await Promise.all([
        Models.ReservaCita.count({
            where: { id_negocio: idNegocio, fecha_hora_inicio: enHoy,
                     estado: { [Op.notIn]: ['cancelada'] } },
        }),
        Models.ReservaCita.count({
            where: { id_negocio: idNegocio, estado: 'confirmada', fecha_hora_inicio: enHoy },
        }),
        Models.ReservaCita.count({
            where: { id_negocio: idNegocio, estado: 'pendiente', fecha_hora_inicio: enHoy },
        }),
        Models.ReservaCita.count({
            where: { id_negocio: idNegocio, estado: 'completada', fecha_hora_inicio: enHoy },
        }),
        Models.ReservaCita.count({
            where: { id_negocio: idNegocio, estado: 'cancelada', fecha_hora_inicio: enHoy },
        }),
        Models.ReservaCita.findOne({
            attributes: [[Models.sequelize.fn('COALESCE', Models.sequelize.fn('SUM', Models.sequelize.col('monto_total')), 0), 'total']],
            where: {
                id_negocio: idNegocio,
                estado: { [Op.in]: ESTADOS_QUE_FACTURAN },
                fecha_hora_inicio: enHoy,
            },
            raw: true,
        }),
        Models.ReservaServicio.count({ where: { id_negocio: idNegocio, estado: 'A' } }),
        Models.ReservaProfesional.count({ where: { id_negocio: idNegocio, estado: 'A' } }),
        Models.ReservaCita.count({
            where: { id_negocio: idNegocio, pago_estado: 'pendiente_validacion' },
        }),
        resumenSemana(idNegocio, inicioSemana, finHoy),
        listarAgendaDelDia(idNegocio, inicioHoy, finHoy),
        topServiciosDelPeriodo(idNegocio, inicioMes30, finHoy),
        ocupacionDelDia(idNegocio, hoyISO, inicioHoy, finHoy),
    ]);

    return {
        fecha: hoyISO,

        // Contadores originales — el contrato que ya consumía el frontend.
        citas_hoy:          citasHoy,
        citas_confirmadas:  citasConfirmadas,
        citas_pendientes:   citasPendientes,
        ingresos_hoy:       Number(ingresosHoyRow?.total ?? 0),
        total_servicios:    totalServicios,
        total_profesionales: totalProfesionales,
        pagos_pendientes_validacion: pagosPendientes,

        citas_completadas_hoy: citasCompletadasHoy,
        citas_canceladas_hoy:  citasCanceladasHoy,

        ocupacion_hoy: ocupacion,
        semana,
        agenda_hoy: agendaHoy,
        top_servicios: topServicios,
    };
}

/** Acumulado de los últimos 7 días (hoy incluido). */
async function resumenSemana(idNegocio, desde, hasta) {
    const [row] = await Models.sequelize.query(
        `SELECT
            COUNT(*) FILTER (WHERE estado <> 'cancelada')                    AS citas,
            COUNT(*) FILTER (WHERE estado = 'completada')                    AS completadas,
            COUNT(*) FILTER (WHERE estado = 'cancelada')                     AS canceladas,
            COUNT(*) FILTER (WHERE estado = 'no_show')                       AS no_show,
            COALESCE(SUM(monto_total) FILTER (WHERE estado IN ('confirmada','completada')), 0) AS ingresos
         FROM reserva.reserva_cita
         WHERE id_negocio = :idNegocio
           AND fecha_hora_inicio >= :desde
           AND fecha_hora_inicio <  :hasta`,
        { replacements: { idNegocio, desde, hasta }, type: Models.sequelize.QueryTypes.SELECT },
    );
    return {
        citas:       Number(row?.citas ?? 0),
        completadas: Number(row?.completadas ?? 0),
        canceladas:  Number(row?.canceladas ?? 0),
        no_show:     Number(row?.no_show ?? 0),
        ingresos:    Number(row?.ingresos ?? 0),
    };
}

/**
 * Las citas de hoy, con lo mínimo para reconocerlas de un vistazo.
 *
 * Se devuelven todas (el tope de 25 es una salvaguarda, no una página): un salón con la agenda
 * llena quiere verla entera, y quien pasa de 25 citas al día tiene el módulo de Agenda para eso.
 */
async function listarAgendaDelDia(idNegocio, desde, hasta) {
    const citas = await Models.ReservaCita.findAll({
        where: {
            id_negocio: idNegocio,
            fecha_hora_inicio: { [Op.gte]: desde, [Op.lt]: hasta },
            estado: { [Op.ne]: 'cancelada' },
        },
        attributes: [
            'id_cita', 'fecha_hora_inicio', 'fecha_hora_fin', 'estado', 'cliente_nombre',
            'cliente_telefono', 'monto_total', 'pago_estado', 'requiere_pago',
        ],
        include: [
            { model: Models.ReservaProfesional, as: 'profesional',
              attributes: ['id_profesional', 'nombre', 'color_hex'] },
            // `id_cita` es obligatorio en el include aunque no se use: es la clave con la que
            // Sequelize reparte las filas hijas entre las citas. Sin ella, `servicios` llega vacío.
            { model: Models.ReservaCitaServicio, as: 'servicios',
              attributes: ['id_cita', 'id_servicio'],
              include: [{ model: Models.ReservaServicio, as: 'servicio', attributes: ['nombre'] }] },
        ],
        order: [['fecha_hora_inicio', 'ASC']],
        limit: 25,
    });

    return citas.map((c) => ({
        id_cita: c.id_cita,
        fecha_hora_inicio: c.fecha_hora_inicio,
        fecha_hora_fin: c.fecha_hora_fin,
        estado: c.estado,
        cliente_nombre: c.cliente_nombre,
        cliente_telefono: c.cliente_telefono,
        monto_total: Number(c.monto_total ?? 0),
        pago_estado: c.pago_estado,
        requiere_pago: c.requiere_pago,
        profesional: c.profesional
            ? { id_profesional: c.profesional.id_profesional, nombre: c.profesional.nombre, color_hex: c.profesional.color_hex }
            : null,
        servicios: (c.servicios || []).map((s) => s.servicio?.nombre).filter(Boolean),
    }));
}

/** Servicios más pedidos en el periodo, por número de citas. */
async function topServiciosDelPeriodo(idNegocio, desde, hasta) {
    const filas = await Models.sequelize.query(
        `SELECT s.id_servicio,
                s.nombre,
                COUNT(*)                          AS citas,
                COALESCE(SUM(cs.precio_snapshot), 0) AS ingresos
         FROM reserva.reserva_cita_servicio cs
         JOIN reserva.reserva_cita     c ON c.id_cita = cs.id_cita
         JOIN reserva.reserva_servicio s ON s.id_servicio = cs.id_servicio
         WHERE c.id_negocio = :idNegocio
           AND c.fecha_hora_inicio >= :desde
           AND c.fecha_hora_inicio <  :hasta
           AND c.estado <> 'cancelada'
         GROUP BY s.id_servicio, s.nombre
         ORDER BY citas DESC, ingresos DESC
         LIMIT 5`,
        { replacements: { idNegocio, desde, hasta }, type: Models.sequelize.QueryTypes.SELECT },
    );
    return filas.map((f) => ({
        id_servicio: Number(f.id_servicio),
        nombre: f.nombre,
        citas: Number(f.citas),
        ingresos: Number(f.ingresos),
    }));
}

/**
 * Cuánto de la jornada de hoy está realmente vendido.
 *
 * El denominador **no** es «24 h × profesionales» sino los minutos de horario laboral de cada
 * profesional según `reglasAgenda.intervalosLaborales` — el mismo horario que decide qué se
 * puede reservar, y ya descontados los bloqueos. Así el número significa algo: 80 % es que
 * quedan pocos huecos que vender hoy, no que falten horas en el día.
 *
 * Sin horario configurado el porcentaje es `null`, no 0: «no sé» y «vacío» son cosas distintas
 * y la interfaz las muestra distinto.
 */
async function ocupacionDelDia(idNegocio, fechaISO, desde, hasta) {
    const profesionales = await Models.ReservaProfesional.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_profesional'],
    });

    const minutosPorPro = await Promise.all(profesionales.map(async (p) => {
        const laborales = await Reglas.intervalosLaborales({
            idNegocio, idProfesional: p.id_profesional, fechaISO,
        });
        return laborales.reduce((acc, [i, f]) => acc + (f - i) / 60_000, 0);
    }));
    const minutosDisponibles = minutosPorPro.reduce((a, b) => a + b, 0);

    const citas = await Models.ReservaCita.findAll({
        where: {
            id_negocio: idNegocio,
            fecha_hora_inicio: { [Op.gte]: desde, [Op.lt]: hasta },
            estado: { [Op.in]: ESTADOS_ACTIVOS },
        },
        attributes: ['fecha_hora_inicio', 'fecha_hora_fin'],
    });
    const minutosOcupados = citas.reduce(
        (acc, c) => acc + (new Date(c.fecha_hora_fin) - new Date(c.fecha_hora_inicio)) / 60_000, 0,
    );

    return {
        minutos_disponibles: Math.round(minutosDisponibles),
        minutos_ocupados: Math.round(minutosOcupados),
        porcentaje: minutosDisponibles > 0
            ? Math.min(100, Math.round((minutosOcupados / minutosDisponibles) * 100))
            : null,
    };
}

module.exports = { verificarAccesoReserva, getResumenDashboard, getPermisosSubnivelNegocio };
