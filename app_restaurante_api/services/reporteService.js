const Models = require('../../app_core/models/conection');
const DashboardService = require('./dashboardService');
const rubroService = require('./rubroService');

const MAX_PAGE_SIZE = 100;
const EXPORT_MAX_ROWS = 5000;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_RANGE_DAYS = 30;

/** Cuántos productos se pueden cruzar a la vez en «ventas por usuario». */
const MAX_PRODUCTOS_FILTRO = 20;

/** ISODOW de postgres: 1 = lunes … 7 = domingo. */
const DIAS_SEMANA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

/** La fila de las categorías sin sector: se vende en todos (bebidas, mecato). */
const RUBRO_GENERAL = 'General';

const REPORT_TYPES = {
    ventas_periodo: {
        titulo: 'Ventas por pedido',
        columns: [
            { key: 'numero_orden', label: 'Orden', type: 'text' },
            { key: 'tipo_pedido', label: 'Tipo pedido', type: 'text' },
            { key: 'fecha_pedido', label: 'Fecha pedido', type: 'date' },
            { key: 'mesa', label: 'Mesa / Domiciliario', type: 'text' },
            // Dos personas y no una: quien toma el pedido y quien lo cobra suelen ser la
            // misma, pero cuando no lo son es justo lo que el dueño viene a mirar.
            { key: 'tomo_pedido', label: 'Tomó el pedido', type: 'text' },
            { key: 'cobro', label: 'Cobró', type: 'text' },
            { key: 'metodo_pago', label: 'Forma de pago', type: 'text' },
            { key: 'total', label: 'Total', type: 'currency' },
        ],
    },
    productos_mas_vendidos: {
        titulo: 'Productos mas vendidos',
        columns: [
            { key: 'producto', label: 'Producto', type: 'text' },
            { key: 'unidades_vendidas', label: 'Unidades', type: 'number' },
            { key: 'ordenes', label: 'Ordenes', type: 'number' },
            { key: 'precio_promedio', label: 'Precio promedio', type: 'currency' },
            { key: 'ingresos_brutos', label: 'Ingresos', type: 'currency' },
        ],
    },
    rendimiento_mesas: {
        titulo: 'Rendimiento por mesa',
        columns: [
            { key: 'mesa', label: 'Mesa', type: 'text' },
            { key: 'ordenes', label: 'Ordenes', type: 'number' },
            { key: 'ticket_promedio', label: 'Ticket promedio', type: 'currency' },
            { key: 'ventas_totales', label: 'Ventas', type: 'currency' },
            { key: 'ultima_venta', label: 'Ultima venta', type: 'date' },
        ],
    },
    rendimiento_usuarios: {
        titulo: 'Rendimiento por usuario',
        columns: [
            { key: 'cajero', label: 'Cajero', type: 'text' },
            { key: 'ordenes_cerradas', label: 'Ordenes cerradas', type: 'number' },
            { key: 'ticket_promedio', label: 'Ticket promedio', type: 'currency' },
            { key: 'ventas_totales', label: 'Ventas', type: 'currency' },
            { key: 'ultima_venta', label: 'Ultima venta', type: 'date' },
        ],
    },
    ventas_rubro: {
        titulo: 'Ventas por sector',
        columns: [
            { key: 'rubro', label: 'Sector', type: 'text' },
            { key: 'unidades', label: 'Unidades', type: 'number' },
            { key: 'ordenes', label: 'Pedidos', type: 'number' },
            { key: 'ingresos', label: 'Venta', type: 'currency' },
            { key: 'participacion', label: 'Participacion', type: 'text' },
        ],
    },
    ventas_dia_semana: {
        titulo: 'Ventas por dia de la semana',
        columns: [
            { key: 'dia', label: 'Dia', type: 'text' },
            { key: 'dias_en_rango', label: 'Veces en el rango', type: 'number' },
            { key: 'ordenes', label: 'Pedidos', type: 'number' },
            { key: 'ventas_totales', label: 'Ventas', type: 'currency' },
            { key: 'promedio_por_dia', label: 'Promedio por dia', type: 'currency' },
            { key: 'ticket_promedio', label: 'Ticket promedio', type: 'currency' },
        ],
    },
    estado_cocina: {
        titulo: 'Estado de cocina',
        columns: [
            { key: 'estado_cocina', label: 'Estado cocina', type: 'text' },
            { key: 'total_ordenes', label: 'Total ordenes', type: 'number' },
            { key: 'ordenes_abiertas', label: 'Abiertas', type: 'number' },
            { key: 'ordenes_cerradas', label: 'Cerradas', type: 'number' },
            { key: 'total_monto', label: 'Monto total', type: 'currency' },
        ],
    },
};

/**
 * Columnas de «ventas por usuario» cuando se cruza con una selección de productos.
 *
 * Con productos elegidos la pregunta cambia —de «cuánto cobró cada uno» a «quién vende más
 * hamburguesas»— y la plata de la tabla deja de ser el total del pedido para ser solo la de
 * esos productos. Mezclar las dos cosas en las mismas columnas invitaría a sumar peras con
 * manzanas, así que se cambian.
 */
const COLUMNAS_USUARIOS_PRODUCTO = [
    { key: 'cajero', label: 'Usuario', type: 'text' },
    { key: 'unidades', label: 'Unidades', type: 'number' },
    { key: 'ordenes', label: 'Pedidos', type: 'number' },
    { key: 'ingresos', label: 'Venta de lo seleccionado', type: 'currency' },
    { key: 'precio_promedio', label: 'Precio promedio', type: 'currency' },
];

function columnsFor(tipo, { idsProducto = [] } = {}) {
    if (tipo === 'rendimiento_usuarios' && idsProducto.length > 0) {
        return COLUMNAS_USUARIOS_PRODUCTO;
    }
    return REPORT_TYPES[tipo].columns;
}

function createHttpError(message, statusCode = 500, code = 'REPORTES_ERROR') {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
}

/**
 * Los ids de producto del filtro, saneados. Llegan como lista o como CSV (`?id_producto=3,7`)
 * porque el frontend los pone en la URL para que el reporte sea enlazable.
 */
function parseIdsProducto(raw) {
    if (raw == null || raw === '') return [];
    const crudos = Array.isArray(raw) ? raw : String(raw).split(',');
    const ids = [...new Set(
        crudos.map((v) => Number(String(v).trim())).filter((n) => Number.isInteger(n) && n > 0),
    )];
    if (ids.length > MAX_PRODUCTOS_FILTRO) {
        throw createHttpError(
            `Puedes cruzar hasta ${MAX_PRODUCTOS_FILTRO} productos a la vez.`,
            422,
            'DEMASIADOS_PRODUCTOS',
        );
    }
    return ids;
}

/**
 * Parsea YYYY-MM-DD en un Date (medianoche Bogotá).
 * Las queries comparan directamente contra `timestamp without time zone`
 * usando `$::date::timestamp`, por lo que basta con pasar el string YYYY-MM-DD
 * a los queries — postgres lo casteará a timestamp sin aplicar conversiones.
 */
function parseDateInput(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    const dateToken = trimmed.length >= 10 ? trimmed.slice(0, 10) : trimmed;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateToken)) return null;
    const parsed = new Date(`${dateToken}T05:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
}

/** Devuelve YYYY-MM-DD del Date interpretado en hora Bogotá. */
function formatDateOnly(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
}

function buildDateRange(fechaDesde, fechaHasta) {
    const today = new Date();
    const endDefault = new Date(today);
    endDefault.setHours(0, 0, 0, 0);

    const startDefault = new Date(endDefault);
    startDefault.setDate(startDefault.getDate() - (DEFAULT_RANGE_DAYS - 1));

    const start = parseDateInput(fechaDesde) || startDefault;
    const end = parseDateInput(fechaHasta) || endDefault;

    if (start > end) {
        throw createHttpError('El rango de fechas es invalido.', 422, 'RANGO_FECHAS_INVALIDO');
    }

    return {
        start,
        end,
        startDate: formatDateOnly(start),
        endDate: formatDateOnly(end),
    };
}

function buildPagination(page, pageSize) {
    const safePage = Number.isFinite(Number(page)) ? Math.max(1, Number(page)) : 1;
    const safePageSize = Number.isFinite(Number(pageSize))
        ? Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSize)))
        : DEFAULT_PAGE_SIZE;

    return {
        page: safePage,
        pageSize: safePageSize,
        offset: (safePage - 1) * safePageSize,
    };
}

function toNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableDate(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

async function resolveNegocioContext(idUsuario, idNegocioQuery) {
    const acceso = await DashboardService.verificarAccesoRestaurante(idUsuario);
    if (!acceso?.negocios?.length) {
        throw createHttpError('No tienes acceso al modulo de restaurante.', 403, 'SIN_ACCESO_RESTAURANTE');
    }

    const requestedNegocio = idNegocioQuery ? Number(idNegocioQuery) : null;
    const negocioActivo = requestedNegocio
        ? acceso.negocios.find((n) => n.id_negocio === requestedNegocio)
        : acceso.negocio;

    if (!negocioActivo) {
        throw createHttpError('No tienes acceso al negocio solicitado.', 403, 'SIN_ACCESO_NEGOCIO');
    }

    return {
        idNegocio: negocioActivo.id_negocio,
        negocioNombre: negocioActivo.nombre,
    };
}

function normalizeRows(tipo, rows) {
    if (tipo === 'ventas_periodo') {
        return rows.map((row) => ({
            ...row,
            tipo_pedido: row.tipo_pedido || 'MESA',
            mesa: row.mesa || 'No aplica',
            tomo_pedido: row.tomo_pedido || 'No registrado',
            cobro: row.cobro || 'Sin registro',
            total: toNumber(row.total),
            fecha_pedido: toNullableDate(row.fecha_pedido || row.fecha_cierre),
        }));
    }

    if (tipo === 'productos_mas_vendidos') {
        return rows.map((row) => ({
            ...row,
            unidades_vendidas: toNumber(row.unidades_vendidas),
            ordenes: toNumber(row.ordenes),
            precio_promedio: toNumber(row.precio_promedio),
            ingresos_brutos: toNumber(row.ingresos_brutos),
        }));
    }

    if (tipo === 'rendimiento_mesas') {
        return rows.map((row) => ({
            ...row,
            ordenes: toNumber(row.ordenes),
            ticket_promedio: toNumber(row.ticket_promedio),
            ventas_totales: toNumber(row.ventas_totales),
            ultima_venta: toNullableDate(row.ultima_venta),
        }));
    }

    if (tipo === 'rendimiento_usuarios') {
        // Dos formas de fila según haya o no productos seleccionados (ver COLUMNAS_USUARIOS_
        // PRODUCTO). Se coercionan las claves que existan en cada caso.
        return rows.map((row) => ({
            ...row,
            ordenes_cerradas: toNumber(row.ordenes_cerradas),
            ticket_promedio: toNumber(row.ticket_promedio),
            ventas_totales: toNumber(row.ventas_totales),
            ...(row.unidades !== undefined ? {
                unidades: toNumber(row.unidades),
                ordenes: toNumber(row.ordenes),
                ingresos: toNumber(row.ingresos),
                precio_promedio: toNumber(row.precio_promedio),
            } : {}),
            ultima_venta: toNullableDate(row.ultima_venta),
        }));
    }

    if (tipo === 'ventas_rubro') {
        return rows.map((row) => ({
            ...row,
            unidades: toNumber(row.unidades),
            ordenes: toNumber(row.ordenes),
            ingresos: toNumber(row.ingresos),
            // Texto y no número: es un porcentaje del total del período, no una cifra que se
            // pueda volver a sumar. Dejarlo numérico invitaría a promediarlo.
            participacion: `${toNumber(row.participacion).toFixed(1)}%`,
        }));
    }

    if (tipo === 'ventas_dia_semana') {
        return rows.map((row) => ({
            ...row,
            dia: DIAS_SEMANA[toNumber(row.dow) - 1] || 'Sin dia',
            dias_en_rango: toNumber(row.dias_en_rango),
            ordenes: toNumber(row.ordenes),
            ventas_totales: toNumber(row.ventas_totales),
            promedio_por_dia: toNumber(row.promedio_por_dia),
            ticket_promedio: toNumber(row.ticket_promedio),
        }));
    }

    if (tipo === 'estado_cocina') {
        return rows.map((row) => ({
            ...row,
            total_ordenes: toNumber(row.total_ordenes),
            ordenes_abiertas: toNumber(row.ordenes_abiertas),
            ordenes_cerradas: toNumber(row.ordenes_cerradas),
            total_monto: toNumber(row.total_monto),
        }));
    }

    return rows;
}

function mapResumenItems(tipo, resumenRow, rangoFechas) {
    if (tipo === 'ventas_periodo') {
        return [
            { key: 'ventas_totales', label: 'Ventas totales', value: toNumber(resumenRow.ventas_totales), type: 'currency' },
            { key: 'ordenes_cobradas', label: 'Ordenes cobradas', value: toNumber(resumenRow.ordenes_cobradas), type: 'number' },
            { key: 'ticket_promedio', label: 'Ticket promedio', value: toNumber(resumenRow.ticket_promedio), type: 'currency' },
            { key: 'rango', label: 'Periodo', value: `${rangoFechas.startDate} al ${rangoFechas.endDate}`, type: 'text' },
        ];
    }

    if (tipo === 'productos_mas_vendidos') {
        return [
            { key: 'productos_con_ventas', label: 'Productos con ventas', value: toNumber(resumenRow.productos_con_ventas), type: 'number' },
            { key: 'unidades_vendidas', label: 'Unidades vendidas', value: toNumber(resumenRow.unidades_vendidas), type: 'number' },
            { key: 'ingresos_brutos', label: 'Ingresos brutos', value: toNumber(resumenRow.ingresos_brutos), type: 'currency' },
            { key: 'rango', label: 'Periodo', value: `${rangoFechas.startDate} al ${rangoFechas.endDate}`, type: 'text' },
        ];
    }

    if (tipo === 'rendimiento_mesas') {
        return [
            { key: 'mesas_con_ventas', label: 'Mesas con ventas', value: toNumber(resumenRow.mesas_con_ventas), type: 'number' },
            { key: 'ordenes_cerradas', label: 'Ordenes cerradas', value: toNumber(resumenRow.ordenes_cerradas), type: 'number' },
            { key: 'ventas_totales', label: 'Ventas totales', value: toNumber(resumenRow.ventas_totales), type: 'currency' },
            { key: 'ticket_promedio', label: 'Ticket promedio', value: toNumber(resumenRow.ticket_promedio), type: 'currency' },
        ];
    }

    if (tipo === 'rendimiento_usuarios') {
        // Con productos seleccionados los KPI hablan de esos productos, no del pedido entero.
        if (resumenRow.unidades_vendidas !== undefined) {
            return [
                { key: 'usuarios_activos', label: 'Usuarios que lo vendieron', value: toNumber(resumenRow.usuarios_activos), type: 'number' },
                { key: 'unidades_vendidas', label: 'Unidades vendidas', value: toNumber(resumenRow.unidades_vendidas), type: 'number' },
                { key: 'ingresos_brutos', label: 'Venta de lo seleccionado', value: toNumber(resumenRow.ingresos_brutos), type: 'currency' },
                { key: 'ordenes_cerradas', label: 'Pedidos que lo incluyen', value: toNumber(resumenRow.ordenes_cerradas), type: 'number' },
            ];
        }
        return [
            { key: 'usuarios_activos', label: 'Usuarios con ventas', value: toNumber(resumenRow.usuarios_activos), type: 'number' },
            { key: 'ordenes_cerradas', label: 'Ordenes cerradas', value: toNumber(resumenRow.ordenes_cerradas), type: 'number' },
            { key: 'ventas_totales', label: 'Ventas totales', value: toNumber(resumenRow.ventas_totales), type: 'currency' },
            { key: 'ticket_promedio', label: 'Ticket promedio', value: toNumber(resumenRow.ticket_promedio), type: 'currency' },
        ];
    }

    if (tipo === 'ventas_rubro') {
        return [
            { key: 'venta_productos', label: 'Venta de productos', value: toNumber(resumenRow.venta_productos), type: 'currency' },
            { key: 'total_cobrado', label: 'Total cobrado', value: toNumber(resumenRow.total_cobrado), type: 'currency' },
            { key: 'sectores_con_venta', label: 'Sectores con venta', value: toNumber(resumenRow.sectores_con_venta), type: 'number' },
            { key: 'rango', label: 'Periodo', value: `${rangoFechas.startDate} al ${rangoFechas.endDate}`, type: 'text' },
        ];
    }

    if (tipo === 'ventas_dia_semana') {
        return [
            { key: 'mejor_dia', label: 'Dia que mas vende', value: resumenRow.mejor_dia || '--', type: 'text' },
            { key: 'peor_dia', label: 'Dia que menos vende', value: resumenRow.peor_dia || '--', type: 'text' },
            { key: 'promedio_por_dia', label: 'Promedio por dia abierto', value: toNumber(resumenRow.promedio_por_dia), type: 'currency' },
            { key: 'ventas_totales', label: 'Ventas totales', value: toNumber(resumenRow.ventas_totales), type: 'currency' },
        ];
    }

    return [
        { key: 'ordenes_totales', label: 'Ordenes totales', value: toNumber(resumenRow.ordenes_totales), type: 'number' },
        { key: 'ordenes_abiertas', label: 'Abiertas', value: toNumber(resumenRow.ordenes_abiertas), type: 'number' },
        { key: 'ordenes_cerradas', label: 'Cerradas', value: toNumber(resumenRow.ordenes_cerradas), type: 'number' },
        { key: 'monto_total', label: 'Monto total', value: toNumber(resumenRow.monto_total), type: 'currency' },
    ];
}

function buildExportRows(rows, columns) {
    return rows.map((row) => {
        const transformed = {};
        columns.forEach((column) => {
            transformed[column.label] = row[column.key] ?? '';
        });
        return transformed;
    });
}

async function runVentasPeriodoQuery({ idNegocio, startDate, endDate, page, pageSize, offset, exportMode }) {
    const limit = exportMode ? EXPORT_MAX_ROWS : pageSize;

    const dataQuery = `
        SELECT
            o.id_orden,
            COALESCE(o.numero_orden, '#' || o.id_orden::text) AS numero_orden,
            COALESCE(o.tipo_pedido, 'MESA') AS tipo_pedido,
            COALESCE(o.fecha_creacion, o.fecha_cierre) AS fecha_pedido,
            CASE
                WHEN o.tipo_pedido = 'MESA' AND m.id_mesa IS NOT NULL
                    THEN COALESCE(CONCAT(m.nombre, ' · #', m.numero::text), 'No aplica')
                WHEN o.tipo_pedido = 'DOMICILIO' AND d.id_usuario IS NOT NULL
                    THEN CONCAT('Dom. · ', TRIM(CONCAT(d.primer_nombre, ' ', d.primer_apellido)))
                ELSE 'No aplica'
            END AS mesa,
            -- Quien TOMÓ el pedido: el dueño de la orden, siempre, también en domicilio.
            COALESCE(NULLIF(TRIM(CONCAT(u.primer_nombre, ' ', u.primer_apellido)), ''), 'No registrado') AS tomo_pedido,
            -- Quien COBRÓ: la firma del movimiento de caja, que es donde queda el cobro de
            -- verdad. Un pedido cerrado sin movimiento (cortesía, ajuste) no tiene cajero.
            COALESCE(NULLIF(TRIM(CONCAT(c.primer_nombre, ' ', c.primer_apellido)), ''), 'Sin registro') AS cobro,
            -- Con multipago el pedido se cobró con varias formas: se nombran todas.
            COALESCE(
                (SELECT string_agg(DISTINCT COALESCE(mpp.nombre, 'Sin método'), ' + ')
                   FROM restaurante.rest_pago_orden po
                   LEFT JOIN restaurante.rest_metodo_pago mpp ON mpp.id_metodo_pago = po.id_metodo_pago
                  WHERE po.id_orden = o.id_orden),
                mp.nombre,
                'Sin método'
            ) AS metodo_pago,
            o.total
        FROM restaurante.pedid_orden o
        LEFT JOIN restaurante.rest_mesa m ON m.id_mesa = o.id_mesa
        LEFT JOIN general.gener_usuario u ON u.id_usuario = o.id_usuario
        LEFT JOIN general.gener_usuario d ON d.id_usuario = o.id_domiciliario
        LEFT JOIN restaurante.rest_metodo_pago mp ON mp.id_metodo_pago = o.id_metodo_pago
        LEFT JOIN LATERAL (
            SELECT uc.primer_nombre, uc.primer_apellido
              FROM restaurante.rest_movimiento_caja mc
              JOIN general.gener_usuario uc ON uc.id_usuario = mc.id_usuario
             WHERE mc.id_orden = o.id_orden
               AND mc.tipo = 'INGRESO'
               AND mc.id_movimiento_anula IS NULL
             ORDER BY mc.fecha DESC, mc.id_movimiento DESC
             LIMIT 1
        ) c ON TRUE
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= $2::date::timestamp
          AND o.fecha_cierre < ($3::date + 1)::timestamp
        ORDER BY COALESCE(o.fecha_creacion, o.fecha_cierre) DESC, o.id_orden DESC
        LIMIT $4 OFFSET $5
    `;

    const countQuery = `
        SELECT COUNT(*)::int AS total
        FROM restaurante.pedid_orden o
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= $2::date::timestamp
          AND o.fecha_cierre < ($3::date + 1)::timestamp
    `;

    const summaryQuery = `
        SELECT
            COALESCE(SUM(o.total), 0)::numeric AS ventas_totales,
            COUNT(*)::int AS ordenes_cobradas,
            COALESCE(AVG(o.total), 0)::numeric AS ticket_promedio
        FROM restaurante.pedid_orden o
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= $2::date::timestamp
          AND o.fecha_cierre < ($3::date + 1)::timestamp
    `;

    // Gráficas: se calculan sobre TODO el rango (no sobre la página de la tabla).
    const serieQuery = `
        SELECT
            to_char(d.dia, 'YYYY-MM-DD') AS fecha,
            COALESCE(SUM(o.total), 0)::numeric AS ventas,
            COUNT(o.id_orden)::int AS ordenes
        FROM generate_series($2::date::timestamp, $3::date::timestamp, interval '1 day') AS d(dia)
        LEFT JOIN restaurante.pedid_orden o
               ON o.id_negocio = $1
              AND o.estado = 'CERRADA'
              AND o.fecha_cierre >= d.dia
              AND o.fecha_cierre < d.dia + interval '1 day'
        GROUP BY d.dia
        ORDER BY d.dia
    `;

    const tipoQuery = `
        SELECT
            COALESCE(o.tipo_pedido, 'MESA') AS tipo_pedido,
            COUNT(*)::int AS ordenes,
            COALESCE(SUM(o.total), 0)::numeric AS ventas
        FROM restaurante.pedid_orden o
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= $2::date::timestamp
          AND o.fecha_cierre < ($3::date + 1)::timestamp
        GROUP BY 1
    `;

    // Período anterior de igual duración, para los badges de tendencia.
    const previoQuery = `
        SELECT
            COALESCE(SUM(o.total), 0)::numeric AS ventas_totales,
            COUNT(*)::int AS ordenes_cobradas,
            COALESCE(AVG(o.total), 0)::numeric AS ticket_promedio
        FROM restaurante.pedid_orden o
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= ($2::date - ($3::date - $2::date + 1))::timestamp
          AND o.fecha_cierre < $2::date::timestamp
    `;

    const params = [idNegocio, startDate, endDate];
    const [rowsRes, countRes, summaryRes, serieRes, tipoRes, previoRes] = await Promise.all([
        Models.pool.query(dataQuery, [...params, limit, exportMode ? 0 : offset]),
        Models.pool.query(countQuery, params),
        Models.pool.query(summaryQuery, params),
        exportMode ? { rows: [] } : Models.pool.query(serieQuery, params),
        exportMode ? { rows: [] } : Models.pool.query(tipoQuery, params),
        exportMode ? { rows: [] } : Models.pool.query(previoQuery, params),
    ]);

    const total = Number(countRes.rows[0]?.total || 0);
    return {
        rows: rowsRes.rows,
        total,
        page,
        pageSize: exportMode ? total || limit : pageSize,
        resumen: summaryRes.rows[0] || {},
        graficas: exportMode ? null : {
            serie_diaria: serieRes.rows.map((r) => ({
                fecha: r.fecha,
                ventas: toNumber(r.ventas),
                ordenes: toNumber(r.ordenes),
            })),
            por_tipo: tipoRes.rows.map((r) => ({
                tipo_pedido: r.tipo_pedido,
                ordenes: toNumber(r.ordenes),
                ventas: toNumber(r.ventas),
            })),
            periodo_anterior: {
                ventas_totales: toNumber(previoRes.rows[0]?.ventas_totales),
                ordenes_cobradas: toNumber(previoRes.rows[0]?.ordenes_cobradas),
                ticket_promedio: toNumber(previoRes.rows[0]?.ticket_promedio),
            },
        },
    };
}

async function runProductosMasVendidosQuery({ idNegocio, startDate, endDate, page, pageSize, offset, exportMode }) {
    const limit = exportMode ? EXPORT_MAX_ROWS : pageSize;

    const baseFilter = `
        FROM restaurante.pedid_detalle d
        INNER JOIN restaurante.pedid_orden o ON o.id_orden = d.id_orden
        INNER JOIN restaurante.carta_producto p ON p.id_producto = d.id_producto
        LEFT JOIN restaurante.carta_categoria c ON c.id_categoria = p.id_categoria
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= $2::date::timestamp
          AND o.fecha_cierre < ($3::date + 1)::timestamp
    `;

    const dataQuery = `
        SELECT
            p.nombre AS producto,
            SUM(d.cantidad)::int AS unidades_vendidas,
            COUNT(DISTINCT o.id_orden)::int AS ordenes,
            COALESCE(AVG(d.precio_unitario), 0)::numeric AS precio_promedio,
            COALESCE(SUM(d.subtotal), 0)::numeric AS ingresos_brutos
        ${baseFilter}
        GROUP BY p.id_producto, p.nombre
        ORDER BY unidades_vendidas DESC, ingresos_brutos DESC
        LIMIT $4 OFFSET $5
    `;

    const countQuery = `
        SELECT COUNT(*)::int AS total
        FROM (
            SELECT p.id_producto
            ${baseFilter}
            GROUP BY p.id_producto
        ) grouped
    `;

    const summaryQuery = `
        SELECT
            COUNT(DISTINCT p.id_producto)::int AS productos_con_ventas,
            COALESCE(SUM(d.cantidad), 0)::numeric AS unidades_vendidas,
            COALESCE(SUM(d.subtotal), 0)::numeric AS ingresos_brutos
        ${baseFilter}
    `;

    // Gráficas: sobre TODO el rango, no sobre la página de la tabla.
    const topQuery = `
        SELECT
            p.nombre AS producto,
            SUM(d.cantidad)::int AS unidades,
            COALESCE(SUM(d.subtotal), 0)::numeric AS ingresos
        ${baseFilter}
        GROUP BY p.id_producto, p.nombre
        ORDER BY unidades DESC, ingresos DESC
        LIMIT 10
    `;

    const categoriaQuery = `
        SELECT
            COALESCE(c.nombre, 'Sin categoría') AS categoria,
            SUM(d.cantidad)::int AS unidades,
            COALESCE(SUM(d.subtotal), 0)::numeric AS ingresos
        ${baseFilter}
        GROUP BY c.id_categoria, c.nombre
        ORDER BY ingresos DESC
    `;

    const params = [idNegocio, startDate, endDate];
    const [rowsRes, countRes, summaryRes, ...extra] = await Promise.all([
        Models.pool.query(dataQuery, [...params, limit, exportMode ? 0 : offset]),
        Models.pool.query(countQuery, params),
        Models.pool.query(summaryQuery, params),
        exportMode ? { rows: [] } : Models.pool.query(topQuery, params),
        exportMode ? { rows: [] } : Models.pool.query(categoriaQuery, params),
    ]);

    const total = Number(countRes.rows[0]?.total || 0);
    return {
        rows: rowsRes.rows,
        total,
        page,
        pageSize: exportMode ? total || limit : pageSize,
        resumen: summaryRes.rows[0] || {},
        graficas: exportMode ? null : {
            top_productos: extra[0].rows.map((r) => ({
                producto: r.producto,
                unidades: toNumber(r.unidades),
                ingresos: toNumber(r.ingresos),
            })),
            por_categoria: extra[1].rows.map((r) => ({
                categoria: r.categoria,
                unidades: toNumber(r.unidades),
                ingresos: toNumber(r.ingresos),
            })),
        },
    };
}

async function runRendimientoMesasQuery({ idNegocio, startDate, endDate, page, pageSize, offset, exportMode }) {
    const limit = exportMode ? EXPORT_MAX_ROWS : pageSize;

    const dataQuery = `
        SELECT
            COALESCE(m.nombre, 'Para llevar') AS mesa,
            COUNT(*)::int AS ordenes,
            COALESCE(AVG(o.total), 0)::numeric AS ticket_promedio,
            COALESCE(SUM(o.total), 0)::numeric AS ventas_totales,
            MAX(o.fecha_cierre) AS ultima_venta
        FROM restaurante.pedid_orden o
        LEFT JOIN restaurante.rest_mesa m ON m.id_mesa = o.id_mesa
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= $2::date::timestamp
          AND o.fecha_cierre < ($3::date + 1)::timestamp
        GROUP BY m.id_mesa, m.nombre
        ORDER BY ventas_totales DESC, ordenes DESC
        LIMIT $4 OFFSET $5
    `;

    const countQuery = `
        SELECT COUNT(*)::int AS total
        FROM (
            SELECT COALESCE(m.id_mesa, 0)
            FROM restaurante.pedid_orden o
            LEFT JOIN restaurante.rest_mesa m ON m.id_mesa = o.id_mesa
            WHERE o.id_negocio = $1
              AND o.estado = 'CERRADA'
              AND o.fecha_cierre >= $2::date::timestamp
              AND o.fecha_cierre < ($3::date + 1)::timestamp
            GROUP BY COALESCE(m.id_mesa, 0)
        ) grouped
    `;

    const summaryQuery = `
        SELECT
            COUNT(DISTINCT COALESCE(o.id_mesa, 0))::int AS mesas_con_ventas,
            COUNT(*)::int AS ordenes_cerradas,
            COALESCE(SUM(o.total), 0)::numeric AS ventas_totales,
            COALESCE(AVG(o.total), 0)::numeric AS ticket_promedio
        FROM restaurante.pedid_orden o
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= $2::date::timestamp
          AND o.fecha_cierre < ($3::date + 1)::timestamp
    `;

    const params = [idNegocio, startDate, endDate];
    const [rowsRes, countRes, summaryRes] = await Promise.all([
        Models.pool.query(dataQuery, [...params, limit, exportMode ? 0 : offset]),
        Models.pool.query(countQuery, params),
        Models.pool.query(summaryQuery, params),
    ]);

    const total = Number(countRes.rows[0]?.total || 0);
    return {
        rows: rowsRes.rows,
        total,
        page,
        pageSize: exportMode ? total || limit : pageSize,
        resumen: summaryRes.rows[0] || {},
    };
}

/**
 * «Ventas por usuario» cruzado con una selección de productos: quién vende más hamburguesas.
 *
 * Es otro reporte, no un filtro del anterior. Las cifras salen de `pedid_detalle` y no de la
 * orden, así que un pedido de $80.000 en el que el mesero puso una gaseosa de $4.000 aporta
 * $4.000 y no $80.000. Por eso las columnas cambian (ver COLUMNAS_USUARIOS_PRODUCTO): sumar
 * estas cifras con las del pedido entero no significaría nada.
 *
 * El usuario es `pedid_orden.id_usuario`, quien TOMÓ el pedido. Es la pregunta que se hace
 * («quién lo vendió»), no quién lo cobró.
 */
async function runRendimientoUsuariosPorProductoQuery({
    idNegocio, startDate, endDate, page, pageSize, offset, exportMode, idsProducto,
}) {
    const limit = exportMode ? EXPORT_MAX_ROWS : pageSize;
    const repl = { idNegocio, startDate, endDate, ids: idsProducto };

    const base = `
        FROM restaurante.pedid_detalle d
        INNER JOIN restaurante.pedid_orden o ON o.id_orden = d.id_orden
        INNER JOIN general.gener_usuario u ON u.id_usuario = o.id_usuario
        WHERE o.id_negocio = :idNegocio
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= CAST(:startDate AS date)
          AND o.fecha_cierre < CAST(:endDate AS date) + INTERVAL '1 day'
          AND d.id_producto = ANY(ARRAY[:ids]::int[])
    `;

    const seleccion = `
        SELECT o.id_usuario,
               TRIM(CONCAT(u.primer_nombre, ' ', u.primer_apellido)) AS cajero,
               SUM(d.cantidad)::int                  AS unidades,
               COUNT(DISTINCT o.id_orden)::int       AS ordenes,
               COALESCE(SUM(d.subtotal), 0)::numeric AS ingresos,
               COALESCE(AVG(d.precio_unitario), 0)::numeric AS precio_promedio,
               MAX(o.fecha_cierre)                   AS ultima_venta
        ${base}
        GROUP BY o.id_usuario, u.primer_nombre, u.primer_apellido
    `;

    const [filas, conteo, resumen, productos, matriz, grafica] = await Promise.all([
        Models.sequelize.query(
            `${seleccion} ORDER BY unidades DESC, ingresos DESC
             LIMIT :limit OFFSET :offset`,
            {
                replacements: { ...repl, limit, offset: exportMode ? 0 : offset },
                type: Models.sequelize.QueryTypes.SELECT,
            },
        ),
        Models.sequelize.query(
            `SELECT COUNT(*)::int AS total FROM (${seleccion}) g`,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
        ),
        Models.sequelize.query(
            `SELECT COUNT(DISTINCT o.id_usuario)::int    AS usuarios_activos,
                    COALESCE(SUM(d.cantidad), 0)::numeric AS unidades_vendidas,
                    COALESCE(SUM(d.subtotal), 0)::numeric AS ingresos_brutos,
                    COUNT(DISTINCT o.id_orden)::int       AS ordenes_cerradas
             ${base}`,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
        ),
        // Los nombres se leen de la carta y no de las ventas: un producto seleccionado que no
        // vendió nada en el rango tiene que salir igual, con su columna en cero. Si solo
        // apareciera cuando vendió, el administrador no podría distinguir «nadie lo vendió»
        // de «me equivoqué al seleccionarlo». El filtro por negocio es lo que impide que por
        // la API entre el id de un producto de otro inquilino.
        Models.sequelize.query(
            `SELECT p.id_producto, p.nombre
               FROM restaurante.carta_producto p
              WHERE p.id_negocio = :idNegocio AND p.id_producto = ANY(ARRAY[:ids]::int[])
              ORDER BY p.nombre`,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
        ),
        exportMode ? Promise.resolve([]) : Models.sequelize.query(
            `SELECT o.id_usuario,
                    TRIM(CONCAT(u.primer_nombre, ' ', u.primer_apellido)) AS usuario,
                    d.id_producto,
                    SUM(d.cantidad)::int                  AS unidades,
                    COALESCE(SUM(d.subtotal), 0)::numeric AS ingresos
             ${base}
             GROUP BY o.id_usuario, u.primer_nombre, u.primer_apellido, d.id_producto`,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
        ),
        // Las gráficas van sobre TODO el rango, no sobre la página de la tabla.
        exportMode ? Promise.resolve([]) : Models.sequelize.query(
            `${seleccion} ORDER BY ingresos DESC, unidades DESC LIMIT 12`,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
        ),
    ]);

    const total = Number(conteo[0]?.total || 0);

    // La matriz usuario × producto: es la respuesta visual a «quién vende más de qué». Se
    // arma aquí y no en el frontend para que la exportación y la pantalla miren lo mismo.
    const columnasProducto = productos.map((p) => ({
        id_producto: Number(p.id_producto),
        nombre: p.nombre,
    }));
    const porUsuario = new Map();
    for (const celda of matriz) {
        const id = Number(celda.id_usuario);
        if (!porUsuario.has(id)) {
            porUsuario.set(id, { id_usuario: id, usuario: celda.usuario, unidades: 0, ingresos: 0, celdas: new Map() });
        }
        const fila = porUsuario.get(id);
        const unidades = toNumber(celda.unidades);
        const ingresos = toNumber(celda.ingresos);
        fila.unidades += unidades;
        fila.ingresos += ingresos;
        fila.celdas.set(Number(celda.id_producto), { unidades, ingresos });
    }
    const filasMatriz = [...porUsuario.values()]
        .sort((a, b) => b.unidades - a.unidades || b.ingresos - a.ingresos)
        .slice(0, 12)
        .map((fila) => ({
            id_usuario: fila.id_usuario,
            usuario: fila.usuario,
            unidades: fila.unidades,
            ingresos: fila.ingresos,
            // Una celda por producto seleccionado, en el mismo orden que las columnas, con
            // ceros donde no hubo venta: la tabla se pinta sin que el frontend busque nada.
            celdas: columnasProducto.map((col) => ({
                id_producto: col.id_producto,
                ...(fila.celdas.get(col.id_producto) || { unidades: 0, ingresos: 0 }),
            })),
        }));

    return {
        rows: filas,
        total,
        page,
        pageSize: exportMode ? total || limit : pageSize,
        resumen: resumen[0] || {},
        // Fuera de `graficas` a propósito: la exportación no recibe gráficas y necesita los
        // nombres para poder decir de qué productos son las cifras.
        productosSeleccionados: columnasProducto,
        graficas: exportMode ? null : {
            // Avisa al frontend de que las cifras son de los productos elegidos y no del
            // pedido entero, para que las etiquetas de las gráficas no mientan.
            modo_producto: true,
            productos_seleccionados: columnasProducto,
            por_usuario: grafica.map((f) => ({
                usuario: f.cajero,
                ordenes: toNumber(f.ordenes),
                ventas: toNumber(f.ingresos),
                unidades: toNumber(f.unidades),
                // Aquí «ticket» es el precio medio al que ese usuario vendió lo seleccionado,
                // no el valor del pedido: con productos elegidos es lo único comparable.
                ticket_promedio: toNumber(f.precio_promedio),
            })),
            matriz: { productos: columnasProducto, filas: filasMatriz },
        },
    };
}

async function runRendimientoUsuariosQuery({ idNegocio, startDate, endDate, page, pageSize, offset, exportMode, idsProducto = [] }) {
    if (idsProducto.length > 0) {
        return runRendimientoUsuariosPorProductoQuery({
            idNegocio, startDate, endDate, page, pageSize, offset, exportMode, idsProducto,
        });
    }

    const limit = exportMode ? EXPORT_MAX_ROWS : pageSize;

    const dataQuery = `
        SELECT
            TRIM(CONCAT(u.primer_nombre, ' ', u.primer_apellido)) AS cajero,
            COUNT(*)::int AS ordenes_cerradas,
            COALESCE(AVG(o.total), 0)::numeric AS ticket_promedio,
            COALESCE(SUM(o.total), 0)::numeric AS ventas_totales,
            MAX(o.fecha_cierre) AS ultima_venta
        FROM restaurante.pedid_orden o
        INNER JOIN general.gener_usuario u ON u.id_usuario = o.id_usuario
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= $2::date::timestamp
          AND o.fecha_cierre < ($3::date + 1)::timestamp
        GROUP BY u.id_usuario, u.primer_nombre, u.primer_apellido
        ORDER BY ventas_totales DESC, ordenes_cerradas DESC
        LIMIT $4 OFFSET $5
    `;

    const countQuery = `
        SELECT COUNT(*)::int AS total
        FROM (
            SELECT o.id_usuario
            FROM restaurante.pedid_orden o
            WHERE o.id_negocio = $1
              AND o.estado = 'CERRADA'
              AND o.fecha_cierre >= $2::date::timestamp
              AND o.fecha_cierre < ($3::date + 1)::timestamp
            GROUP BY o.id_usuario
        ) grouped
    `;

    const summaryQuery = `
        SELECT
            COUNT(DISTINCT o.id_usuario)::int AS usuarios_activos,
            COUNT(*)::int AS ordenes_cerradas,
            COALESCE(SUM(o.total), 0)::numeric AS ventas_totales,
            COALESCE(AVG(o.total), 0)::numeric AS ticket_promedio
        FROM restaurante.pedid_orden o
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= $2::date::timestamp
          AND o.fecha_cierre < ($3::date + 1)::timestamp
    `;

    // Gráficas: sobre TODO el rango, no sobre la página de la tabla.
    const usuariosGraficaQuery = `
        SELECT
            TRIM(CONCAT(u.primer_nombre, ' ', u.primer_apellido)) AS usuario,
            COUNT(*)::int AS ordenes,
            COALESCE(SUM(o.total), 0)::numeric AS ventas,
            COALESCE(AVG(o.total), 0)::numeric AS ticket_promedio
        FROM restaurante.pedid_orden o
        INNER JOIN general.gener_usuario u ON u.id_usuario = o.id_usuario
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= $2::date::timestamp
          AND o.fecha_cierre < ($3::date + 1)::timestamp
        GROUP BY u.id_usuario, u.primer_nombre, u.primer_apellido
        ORDER BY ventas DESC
        LIMIT 12
    `;

    const params = [idNegocio, startDate, endDate];
    const [rowsRes, countRes, summaryRes, ...extra] = await Promise.all([
        Models.pool.query(dataQuery, [...params, limit, exportMode ? 0 : offset]),
        Models.pool.query(countQuery, params),
        Models.pool.query(summaryQuery, params),
        exportMode ? { rows: [] } : Models.pool.query(usuariosGraficaQuery, params),
    ]);

    const total = Number(countRes.rows[0]?.total || 0);
    return {
        rows: rowsRes.rows,
        total,
        page,
        pageSize: exportMode ? total || limit : pageSize,
        resumen: summaryRes.rows[0] || {},
        graficas: exportMode ? null : {
            por_usuario: extra[0].rows.map((r) => ({
                usuario: r.usuario,
                ordenes: toNumber(r.ordenes),
                ventas: toNumber(r.ventas),
                ticket_promedio: toNumber(r.ticket_promedio),
            })),
        },
    };
}

/**
 * Ventas por sector de ingreso (rubro).
 *
 * El ingreso se atribuye por ÍTEM —la categoría del producto dice de qué sector es—, no por
 * pedido. Es lo que deja repartir solo una mesa que pidió de los tres sectores y pagó una
 * sola vez, que es justo el caso para el que existe la función. Lo que no es producto
 * (domicilio, impuesto, descuento) vive en la orden y **no se prorratea**: va en líneas
 * aparte dentro de `graficas.conciliacion`, para que cada cifra de la tabla sea una que el
 * administrador pueda verificar contra sus tiquetes.
 */
async function runVentasRubroQuery({ idNegocio, startDate, endDate, page, pageSize, offset, exportMode }) {
    const limit = exportMode ? EXPORT_MAX_ROWS : pageSize;
    const repl = { idNegocio, startDate, endDate, general: RUBRO_GENERAL };

    // El rubro NO se filtra por estado: un sector desactivado tiene que seguir saliendo
    // separado en el histórico, o los meses anteriores cambiarían de cifras al desactivarlo.
    const base = `
        FROM restaurante.pedid_detalle d
        INNER JOIN restaurante.pedid_orden o     ON o.id_orden = d.id_orden
        INNER JOIN restaurante.carta_producto p  ON p.id_producto = d.id_producto
        INNER JOIN restaurante.carta_categoria c ON c.id_categoria = p.id_categoria
        LEFT  JOIN restaurante.rest_rubro r      ON r.id_rubro = c.id_rubro
        WHERE o.id_negocio = :idNegocio
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= CAST(:startDate AS date)
          AND o.fecha_cierre < CAST(:endDate AS date) + INTERVAL '1 day'
    `;

    // La participación sale de una ventana sobre TODOS los grupos, así que no depende de la
    // página: la fila dice su peso en el período, no en la página que se está mirando.
    const agrupado = `
        SELECT COALESCE(r.id_rubro, 0)             AS id_rubro,
               COALESCE(r.nombre, :general)        AS rubro,
               MAX(r.color)                        AS color,
               SUM(d.cantidad)::int                AS unidades,
               COUNT(DISTINCT o.id_orden)::int     AS ordenes,
               COALESCE(SUM(d.subtotal), 0)::numeric AS ingresos,
               (100.0 * COALESCE(SUM(d.subtotal), 0)
                      / NULLIF(SUM(SUM(d.subtotal)) OVER (), 0))::numeric AS participacion
        ${base}
        GROUP BY COALESCE(r.id_rubro, 0), COALESCE(r.nombre, :general)
    `;

    const [filas, todos, conciliacion] = await Promise.all([
        Models.sequelize.query(
            `SELECT * FROM (${agrupado}) g ORDER BY g.ingresos DESC LIMIT :limit OFFSET :offset`,
            {
                replacements: { ...repl, limit, offset: exportMode ? 0 : offset },
                type: Models.sequelize.QueryTypes.SELECT,
            },
        ),
        // La lista completa sirve para dos cosas a la vez: el conteo de la paginación y la
        // gráfica de participación, que tiene que ver todos los sectores y no una página.
        Models.sequelize.query(
            `SELECT * FROM (${agrupado}) g ORDER BY g.ingresos DESC`,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
        ),
        // El cuadre va sobre la ORDEN, no sobre el ítem: aquí cada pedido cuenta una vez.
        Models.sequelize.query(
            `SELECT COALESCE(SUM(o.subtotal), 0)::numeric        AS venta_productos,
                    COALESCE(SUM(o.impuesto), 0)::numeric        AS impuestos,
                    COALESCE(SUM(o.valor_domicilio), 0)::numeric AS domicilios,
                    COALESCE(SUM(o.descuento), 0)::numeric       AS descuentos,
                    COALESCE(SUM(o.total), 0)::numeric           AS total_cobrado,
                    COUNT(*)::int                                AS ordenes
               FROM restaurante.pedid_orden o
              WHERE o.id_negocio = :idNegocio
                AND o.estado = 'CERRADA'
                AND o.fecha_cierre >= CAST(:startDate AS date)
                AND o.fecha_cierre < CAST(:endDate AS date) + INTERVAL '1 day'`,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
        ),
    ]);

    const cuadre = conciliacion[0] || {};
    const ventaItems = todos.reduce((suma, r) => suma + toNumber(r.ingresos), 0);
    const totalCobrado = toNumber(cuadre.total_cobrado);
    const impuestos = toNumber(cuadre.impuestos);
    const domicilios = toNumber(cuadre.domicilios);
    const descuentos = toNumber(cuadre.descuentos);

    return {
        rows: filas,
        total: todos.length,
        page,
        pageSize: exportMode ? todos.length || limit : pageSize,
        // El cuadre viaja también en el resumen y no solo en las gráficas: la exportación no
        // recibe gráficas, y un Excel de ventas por sector sin las líneas que lo cuadran
        // contra el total cobrado sería justo el documento que nadie puede auditar.
        resumen: {
            venta_productos: ventaItems,
            total_cobrado: totalCobrado,
            sectores_con_venta: todos.length,
            impuestos,
            domicilios,
            descuentos,
            ordenes: toNumber(cuadre.ordenes),
        },
        graficas: exportMode ? null : {
            por_rubro: todos.map((r) => ({
                id_rubro: Number(r.id_rubro),
                rubro: r.rubro,
                color: r.color || null,
                unidades: toNumber(r.unidades),
                ordenes: toNumber(r.ordenes),
                ingresos: toNumber(r.ingresos),
            })),
            conciliacion: {
                venta_productos: ventaItems,
                impuestos,
                domicilios,
                descuentos,
                total_cobrado: totalCobrado,
                // Debería ser 0 siempre: `pedid_orden.total` se calcula como
                // subtotal + impuesto + domicilio − descuento (pedidoService:466) y
                // `subtotal` es la suma de los detalles. Se enseña cuando no cuadra en vez de
                // esconderlo: un descuadre aquí es un dato roto, y verlo es el aviso.
                descuadre: Math.round(
                    (totalCobrado - (ventaItems + impuestos + domicilios - descuentos)) * 100,
                ) / 100,
                ordenes: toNumber(cuadre.ordenes),
            },
        },
    };
}

/**
 * Ventas por día de la semana: qué día vende más y cuál menos.
 *
 * La cifra que de verdad compara es `promedio_por_dia`, no el total: un rango de 30 días trae
 * cinco lunes y cuatro martes, y el total del lunes sale más alto solo por eso. `dias_en_rango`
 * cuenta cuántas veces cayó ese día en el rango —incluidos los que no vendieron nada, que es
 * lo que hace honesto el promedio— y va como columna para que el número se pueda rehacer a mano.
 */
async function runVentasDiaSemanaQuery({ idNegocio, startDate, endDate, exportMode }) {
    const repl = { idNegocio, startDate, endDate };

    const filtroOrden = `
        WHERE o.id_negocio = :idNegocio
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= CAST(:startDate AS date)
          AND o.fecha_cierre < CAST(:endDate AS date) + INTERVAL '1 day'
    `;

    const [filas, resumen, serie] = await Promise.all([
        Models.sequelize.query(
            `WITH dias AS (
                 SELECT EXTRACT(ISODOW FROM g.dia)::int AS dow, COUNT(*)::int AS dias_en_rango
                   FROM generate_series(CAST(:startDate AS date), CAST(:endDate AS date),
                                        INTERVAL '1 day') AS g(dia)
                  GROUP BY 1
             ),
             ventas AS (
                 SELECT EXTRACT(ISODOW FROM o.fecha_cierre)::int AS dow,
                        COUNT(*)::int                        AS ordenes,
                        COALESCE(SUM(o.total), 0)::numeric   AS ventas_totales,
                        COALESCE(AVG(o.total), 0)::numeric   AS ticket_promedio
                   FROM restaurante.pedid_orden o
                   ${filtroOrden}
                  GROUP BY 1
             )
             SELECT d.dow,
                    d.dias_en_rango,
                    COALESCE(v.ordenes, 0)                 AS ordenes,
                    COALESCE(v.ventas_totales, 0)::numeric AS ventas_totales,
                    COALESCE(v.ticket_promedio, 0)::numeric AS ticket_promedio,
                    (COALESCE(v.ventas_totales, 0) / NULLIF(d.dias_en_rango, 0))::numeric
                                                           AS promedio_por_dia
               FROM dias d
               LEFT JOIN ventas v ON v.dow = d.dow
              ORDER BY d.dow`,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
        ),
        Models.sequelize.query(
            `SELECT COALESCE(SUM(o.total), 0)::numeric AS ventas_totales,
                    COUNT(*)::int                      AS ordenes,
                    COUNT(DISTINCT o.fecha_cierre::date)::int AS dias_con_venta
               FROM restaurante.pedid_orden o
               ${filtroOrden}`,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
        ),
        // La evolución día a día del rango: aquí sí es la gráfica que toca, porque la pregunta
        // de la pestaña es cuánto se vende cada día.
        exportMode ? Promise.resolve([]) : Models.sequelize.query(
            `SELECT to_char(g.dia, 'YYYY-MM-DD')      AS fecha,
                    COALESCE(SUM(o.total), 0)::numeric AS ventas,
                    COUNT(o.id_orden)::int             AS ordenes
               FROM generate_series(CAST(:startDate AS date), CAST(:endDate AS date),
                                    INTERVAL '1 day') AS g(dia)
               LEFT JOIN restaurante.pedid_orden o
                      ON o.id_negocio = :idNegocio
                     AND o.estado = 'CERRADA'
                     AND o.fecha_cierre >= g.dia
                     AND o.fecha_cierre < g.dia + INTERVAL '1 day'
              GROUP BY g.dia
              ORDER BY g.dia`,
            { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
        ),
    ]);

    // Mejor y peor día se deciden por el promedio y solo entre los días que de verdad cayeron
    // en el rango. Sin ese filtro, un rango de 3 días declararía «el peor día es el domingo»
    // por un domingo que no existió.
    const conDatos = filas.filter((f) => toNumber(f.dias_en_rango) > 0);
    const ordenados = [...conDatos].sort(
        (a, b) => toNumber(b.promedio_por_dia) - toNumber(a.promedio_por_dia),
    );
    const etiqueta = (fila) => (fila ? DIAS_SEMANA[toNumber(fila.dow) - 1] : null);
    const hayVentas = ordenados.some((f) => toNumber(f.ventas_totales) > 0);
    const total = resumen[0] || {};
    const diasConVenta = toNumber(total.dias_con_venta);

    return {
        rows: filas,
        total: filas.length,
        page: 1,
        pageSize: filas.length || 7,
        resumen: {
            mejor_dia: hayVentas ? etiqueta(ordenados[0]) : null,
            peor_dia: hayVentas ? etiqueta(ordenados[ordenados.length - 1]) : null,
            ventas_totales: toNumber(total.ventas_totales),
            promedio_por_dia: diasConVenta > 0 ? toNumber(total.ventas_totales) / diasConVenta : 0,
        },
        graficas: exportMode ? null : {
            por_dia_semana: filas.map((f) => ({
                dow: toNumber(f.dow),
                dia: DIAS_SEMANA[toNumber(f.dow) - 1] || 'Sin dia',
                dias_en_rango: toNumber(f.dias_en_rango),
                ordenes: toNumber(f.ordenes),
                ventas: toNumber(f.ventas_totales),
                promedio_por_dia: toNumber(f.promedio_por_dia),
                ticket_promedio: toNumber(f.ticket_promedio),
            })),
            serie_diaria: serie.map((r) => ({
                fecha: r.fecha,
                ventas: toNumber(r.ventas),
                ordenes: toNumber(r.ordenes),
            })),
        },
    };
}

async function runEstadoCocinaQuery({ idNegocio, startDate, endDate, page, pageSize, offset, exportMode }) {
    const limit = exportMode ? EXPORT_MAX_ROWS : pageSize;

    const dataQuery = `
        SELECT
            COALESCE(NULLIF(o.estado_cocina, ''), 'SIN_ESTADO') AS estado_cocina,
            COUNT(*)::int AS total_ordenes,
            SUM(CASE WHEN o.estado = 'ABIERTA' THEN 1 ELSE 0 END)::int AS ordenes_abiertas,
            SUM(CASE WHEN o.estado = 'CERRADA' THEN 1 ELSE 0 END)::int AS ordenes_cerradas,
            COALESCE(SUM(o.total), 0)::numeric AS total_monto
        FROM restaurante.pedid_orden o
        WHERE o.id_negocio = $1
          AND o.fecha_creacion >= $2::date::timestamp
          AND o.fecha_creacion < ($3::date + 1)::timestamp
        GROUP BY COALESCE(NULLIF(o.estado_cocina, ''), 'SIN_ESTADO')
        ORDER BY total_ordenes DESC, estado_cocina ASC
        LIMIT $4 OFFSET $5
    `;

    const countQuery = `
        SELECT COUNT(*)::int AS total
        FROM (
            SELECT COALESCE(NULLIF(o.estado_cocina, ''), 'SIN_ESTADO')
            FROM restaurante.pedid_orden o
            WHERE o.id_negocio = $1
              AND o.fecha_creacion >= $2::date::timestamp
              AND o.fecha_creacion < ($3::date + 1)::timestamp
            GROUP BY COALESCE(NULLIF(o.estado_cocina, ''), 'SIN_ESTADO')
        ) grouped
    `;

    const summaryQuery = `
        SELECT
            COUNT(*)::int AS ordenes_totales,
            SUM(CASE WHEN o.estado = 'ABIERTA' THEN 1 ELSE 0 END)::int AS ordenes_abiertas,
            SUM(CASE WHEN o.estado = 'CERRADA' THEN 1 ELSE 0 END)::int AS ordenes_cerradas,
            COALESCE(SUM(o.total), 0)::numeric AS monto_total
        FROM restaurante.pedid_orden o
        WHERE o.id_negocio = $1
          AND o.fecha_creacion >= $2::date::timestamp
          AND o.fecha_creacion < ($3::date + 1)::timestamp
    `;

    const params = [idNegocio, startDate, endDate];
    const [rowsRes, countRes, summaryRes] = await Promise.all([
        Models.pool.query(dataQuery, [...params, limit, exportMode ? 0 : offset]),
        Models.pool.query(countQuery, params),
        Models.pool.query(summaryQuery, params),
    ]);

    const total = Number(countRes.rows[0]?.total || 0);
    return {
        rows: rowsRes.rows,
        total,
        page,
        pageSize: exportMode ? total || limit : pageSize,
        resumen: summaryRes.rows[0] || {},
    };
}

async function runReportQuery(tipo, params) {
    if (tipo === 'ventas_periodo') {
        return runVentasPeriodoQuery(params);
    }
    if (tipo === 'productos_mas_vendidos') {
        return runProductosMasVendidosQuery(params);
    }
    if (tipo === 'rendimiento_mesas') {
        return runRendimientoMesasQuery(params);
    }
    if (tipo === 'rendimiento_usuarios') {
        return runRendimientoUsuariosQuery(params);
    }
    if (tipo === 'ventas_rubro') {
        return runVentasRubroQuery(params);
    }
    if (tipo === 'ventas_dia_semana') {
        return runVentasDiaSemanaQuery(params);
    }
    return runEstadoCocinaQuery(params);
}

/**
 * Los productos que se pueden cruzar en «ventas por usuario».
 *
 * Lista plana con su categoría y su sector: el selector del frontend filtra en memoria, que a
 * la escala de una carta de restaurante es más rápido que ir y volver por cada letra escrita.
 */
async function getCatalogoProductos({ idUsuario, idNegocio }) {
    const negocioContext = await resolveNegocioContext(idUsuario, idNegocio);

    const filas = await Models.sequelize.query(
        `SELECT p.id_producto, p.nombre,
                c.id_categoria, c.nombre AS categoria,
                r.id_rubro, r.nombre AS rubro
           FROM restaurante.carta_producto p
           INNER JOIN restaurante.carta_categoria c ON c.id_categoria = p.id_categoria
           LEFT  JOIN restaurante.rest_rubro r      ON r.id_rubro = c.id_rubro
          WHERE p.id_negocio = :idNegocio AND p.estado = 'A'
          ORDER BY c.orden, c.nombre, p.nombre`,
        {
            replacements: { idNegocio: negocioContext.idNegocio },
            type: Models.sequelize.QueryTypes.SELECT,
        },
    );

    return {
        negocio: { id_negocio: negocioContext.idNegocio, nombre: negocioContext.negocioNombre },
        max_seleccion: MAX_PRODUCTOS_FILTRO,
        rows: filas.map((f) => ({
            id_producto: Number(f.id_producto),
            nombre: f.nombre,
            id_categoria: Number(f.id_categoria),
            categoria: f.categoria,
            id_rubro: f.id_rubro == null ? null : Number(f.id_rubro),
            rubro: f.rubro || null,
        })),
    };
}

/**
 * «Ventas por sector» solo existe para el negocio que separa sectores.
 *
 * El frontend ya esconde la pestaña cuando no hay rubros, pero la API es alcanzable con un
 * token y esto no debe contestar una tabla de una sola fila «General» que parecería la
 * función funcionando a medias.
 */
async function exigirRubros(idNegocio) {
    if (!(await rubroService.negocioUsaRubros(idNegocio))) {
        throw createHttpError(
            'Este negocio no separa sus ingresos por sector. Crea los sectores en Configuracion -> Sectores.',
            422,
            'RUBROS_NO_CONFIGURADOS',
        );
    }
}

async function getReporte({ idUsuario, idNegocio, tipo = 'ventas_periodo', fechaDesde, fechaHasta, page = 1, pageSize = DEFAULT_PAGE_SIZE, idsProducto }) {
    if (!REPORT_TYPES[tipo]) {
        throw createHttpError('Tipo de reporte no soportado.', 422, 'REPORTE_TIPO_INVALIDO');
    }

    const negocioContext = await resolveNegocioContext(idUsuario, idNegocio);
    const rangoFechas = buildDateRange(fechaDesde, fechaHasta);
    const pagination = buildPagination(page, pageSize);
    const productos = parseIdsProducto(idsProducto);

    if (tipo === 'ventas_rubro') await exigirRubros(negocioContext.idNegocio);

    const reportResult = await runReportQuery(tipo, {
        idNegocio: negocioContext.idNegocio,
        startDate: rangoFechas.startDate,
        endDate: rangoFechas.endDate,
        ...pagination,
        idsProducto: productos,
        exportMode: false,
    });

    const normalizedRows = normalizeRows(tipo, reportResult.rows || []);
    const pageSizeEfectivo = reportResult.pageSize || pagination.pageSize;
    const totalPages = Math.max(1, Math.ceil((reportResult.total || 0) / pageSizeEfectivo));

    return {
        tipo,
        titulo: REPORT_TYPES[tipo].titulo,
        negocio: {
            id_negocio: negocioContext.idNegocio,
            nombre: negocioContext.negocioNombre,
        },
        filtros: {
            fecha_desde: rangoFechas.startDate,
            fecha_hasta: rangoFechas.endDate,
            ...(productos.length > 0 ? { id_productos: productos } : {}),
        },
        columns: columnsFor(tipo, { idsProducto: productos }),
        resumen: mapResumenItems(tipo, reportResult.resumen || {}, rangoFechas),
        ...(reportResult.graficas ? { graficas: reportResult.graficas } : {}),
        rows: normalizedRows,
        pagination: {
            // «Ventas por dia de la semana» trae siempre las 7 filas de una vez y devuelve su
            // propio tamaño de pagina: paginar un reporte de 7 filas no tiene sentido.
            page: reportResult.page || pagination.page,
            page_size: pageSizeEfectivo,
            total: reportResult.total || 0,
            total_pages: totalPages,
        },
    };
}

/**
 * Los ingresos cobrados en el período, repartidos por forma de pago.
 *
 * Un pedido con multipago aporta a VARIAS formas: el reparto sale de `rest_pago_orden`
 * cuando lo hay y, si no, del método único de la orden. La suma de las partes es, por
 * construcción, el total cobrado del período.
 */
async function getDesglosePago(idNegocio, startDate, endDate) {
    const query = `
        WITH cerradas AS (
            SELECT o.id_orden, o.total, o.id_metodo_pago
              FROM restaurante.pedid_orden o
             WHERE o.id_negocio = $1
               AND o.estado = 'CERRADA'
               AND o.fecha_cierre >= $2::date::timestamp
               AND o.fecha_cierre < ($3::date + 1)::timestamp
        ),
        partes AS (
            SELECT po.id_metodo_pago, po.valor, c.id_orden
              FROM cerradas c
              JOIN restaurante.rest_pago_orden po ON po.id_orden = c.id_orden
            UNION ALL
            SELECT c.id_metodo_pago, c.total AS valor, c.id_orden
              FROM cerradas c
             WHERE NOT EXISTS (
                 SELECT 1 FROM restaurante.rest_pago_orden po WHERE po.id_orden = c.id_orden
             )
        )
        SELECT COALESCE(mp.nombre, 'Sin método') AS metodo,
               COUNT(DISTINCT partes.id_orden)::int AS ordenes,
               COALESCE(SUM(partes.valor), 0)::numeric AS total
          FROM partes
          LEFT JOIN restaurante.rest_metodo_pago mp ON mp.id_metodo_pago = partes.id_metodo_pago
         GROUP BY 1
         ORDER BY 3 DESC, 1 ASC
    `;

    const { rows } = await Models.pool.query(query, [idNegocio, startDate, endDate]);
    const total = rows.reduce((acc, r) => acc + toNumber(r.total), 0);
    return rows.map((r) => ({
        metodo: r.metodo,
        ordenes: toNumber(r.ordenes),
        total: toNumber(r.total),
        participacion: total > 0 ? (toNumber(r.total) / total) * 100 : 0,
    }));
}

async function getExportPayload({ idUsuario, idNegocio, tipo = 'ventas_periodo', fechaDesde, fechaHasta, idsProducto }) {
    if (!REPORT_TYPES[tipo]) {
        throw createHttpError('Tipo de reporte no soportado.', 422, 'REPORTE_TIPO_INVALIDO');
    }

    const negocioContext = await resolveNegocioContext(idUsuario, idNegocio);
    const rangoFechas = buildDateRange(fechaDesde, fechaHasta);
    const productos = parseIdsProducto(idsProducto);

    if (tipo === 'ventas_rubro') await exigirRubros(negocioContext.idNegocio);

    const reportResult = await runReportQuery(tipo, {
        idNegocio: negocioContext.idNegocio,
        startDate: rangoFechas.startDate,
        endDate: rangoFechas.endDate,
        page: 1,
        pageSize: EXPORT_MAX_ROWS,
        offset: 0,
        idsProducto: productos,
        exportMode: true,
    });

    const rows = normalizeRows(tipo, reportResult.rows || []);
    if ((reportResult.total || 0) > EXPORT_MAX_ROWS) {
        throw createHttpError(
            `El reporte supera ${EXPORT_MAX_ROWS} filas. Reduce el rango de fechas o usa filtros mas especificos.`,
            422,
            'REPORTE_EXCESO_FILAS'
        );
    }

    if (rows.length === 0) {
        throw createHttpError('No hay datos para exportar en el rango seleccionado.', 422, 'REPORTE_SIN_DATOS');
    }

    const columns = columnsFor(tipo, { idsProducto: productos });
    // Con tipo (`currency`, `number`…): el exportador necesita saber qué es cada cifra para
    // darle formato. `resumen`, plano, se mantiene porque es el contrato que ya existía.
    const resumenItems = mapResumenItems(tipo, reportResult.resumen || {}, rangoFechas);
    const resumen = resumenItems.reduce((acc, item) => {
        acc[item.label] = item.value;
        return acc;
    }, {});

    // Las líneas que cuadran la suma de sectores contra el total cobrado. Solo van en la
    // exportación: en pantalla las pinta su propia tarjeta a partir de `graficas.conciliacion`.
    if (tipo === 'ventas_rubro') {
        const crudo = reportResult.resumen || {};
        Object.assign(resumen, {
            'Impuestos': toNumber(crudo.impuestos),
            'Domicilios': toNumber(crudo.domicilios),
            'Descuentos': toNumber(crudo.descuentos),
            'Pedidos cobrados': toNumber(crudo.ordenes),
        });
    }

    // Qué productos se cruzaron: sin esto el Excel de «ventas por usuario» con selección es un
    // listado de cifras sin decir de qué son.
    if (productos.length > 0 && reportResult.productosSeleccionados?.length) {
        resumen['Productos cruzados'] = reportResult.productosSeleccionados
            .map((p) => p.nombre).join(', ');
    }

    // El reparto por forma de pago va en TODOS los reportes: sea cual sea el corte que se
    // mire, «cuánto entró y en qué» es la misma pregunta del período.
    const desglosePago = await getDesglosePago(
        negocioContext.idNegocio, rangoFechas.startDate, rangoFechas.endDate,
    );

    return {
        tipo,
        titulo: REPORT_TYPES[tipo].titulo,
        negocio: {
            id_negocio: negocioContext.idNegocio,
            nombre: negocioContext.negocioNombre,
        },
        periodo: { desde: rangoFechas.startDate, hasta: rangoFechas.endDate },
        columns,
        rows,
        exportRows: buildExportRows(rows, columns),
        resumen,
        resumenItems,
        desglosePago,
        totalIngresos: desglosePago.reduce((acc, d) => acc + d.total, 0),
    };
}

async function getDetalleVentaPeriodo({ idUsuario, idNegocio, idOrden }) {
    const parsedIdOrden = Number(idOrden);
    if (!Number.isInteger(parsedIdOrden) || parsedIdOrden <= 0) {
        throw createHttpError('El id de la orden es invalido.', 422, 'ID_ORDEN_INVALIDO');
    }

    const negocioContext = await resolveNegocioContext(idUsuario, idNegocio);

    const orden = await Models.PedidOrden.findOne({
        where: {
            id_orden: parsedIdOrden,
            id_negocio: negocioContext.idNegocio,
        },
        include: [
            {
                model: Models.PedidDetalle,
                as: 'detalles',
                include: [
                    {
                        model: Models.CartaProducto,
                        as: 'producto',
                        attributes: ['id_producto', 'nombre', 'icono'],
                    },
                    {
                        model: Models.PedidDetalleExclu,
                        as: 'exclusiones',
                        include: [
                            {
                                model: Models.CartaIngrediente,
                                as: 'ingrediente',
                                attributes: ['id_ingrediente', 'nombre'],
                            },
                        ],
                    },
                ],
            },
            {
                model: Models.GenerUsuario,
                as: 'usuario',
                attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
            },
            {
                model: Models.GenerUsuario,
                as: 'domiciliario',
                attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
                required: false,
            },
            {
                model: Models.RestMesa,
                as: 'mesaRef',
                attributes: ['id_mesa', 'nombre', 'numero'],
                required: false,
            },
        ],
    });

    if (!orden) {
        throw createHttpError('No se encontro la orden solicitada para este negocio.', 404, 'ORDEN_NO_ENCONTRADA');
    }

    const nombreMesero = [orden.usuario?.primer_nombre, orden.usuario?.primer_apellido]
        .filter(Boolean)
        .join(' ')
        .trim();

    const nombreDomiciliario = [orden.domiciliario?.primer_nombre, orden.domiciliario?.primer_apellido]
        .filter(Boolean)
        .join(' ')
        .trim();
    const responsable = orden.tipo_pedido === 'DOMICILIO'
        ? (nombreDomiciliario || 'No aplica')
        : (nombreMesero || 'No aplica');

    const items = (orden.detalles || [])
        .map((detalle) => ({
            id_detalle: Number(detalle.id_detalle),
            id_producto: Number(detalle.id_producto),
            producto: detalle.producto?.nombre || 'Producto',
            icono: detalle.producto?.icono || null,
            cantidad: Number(detalle.cantidad || 0),
            precio_unitario: toNumber(detalle.precio_unitario),
            subtotal: toNumber(detalle.subtotal),
            estado: detalle.estado || 'PENDIENTE',
            nota: detalle.nota || '',
            exclusiones: (detalle.exclusiones || [])
                .map((exclusion) => {
                    const idIngrediente = Number(exclusion.id_ingrediente || exclusion.ingrediente?.id_ingrediente || 0);
                    if (!idIngrediente) return null;

                    return {
                        id_ingrediente: idIngrediente,
                        nombre: exclusion.ingrediente?.nombre || 'Ingrediente',
                    };
                })
                .filter(Boolean),
        }))
        .sort((a, b) => a.id_detalle - b.id_detalle);

    // Forma(s) de pago: el desglose (multipago) si existe; si no, el método único de la orden.
    const { rows: pagoRows } = await Models.pool.query(
        `SELECT mp.nombre AS metodo, po.valor
           FROM restaurante.rest_pago_orden po
           JOIN restaurante.rest_metodo_pago mp ON mp.id_metodo_pago = po.id_metodo_pago
          WHERE po.id_orden = $1
          ORDER BY po.id_pago`,
        [orden.id_orden],
    );
    let pagos = pagoRows.map((r) => ({ metodo: r.metodo, valor: toNumber(r.valor) }));
    if (pagos.length === 0 && orden.id_metodo_pago) {
        const { rows: [unico] } = await Models.pool.query(
            'SELECT nombre FROM restaurante.rest_metodo_pago WHERE id_metodo_pago = $1',
            [orden.id_metodo_pago],
        );
        if (unico) pagos = [{ metodo: unico.nombre, valor: toNumber(orden.total) }];
    }

    return {
        id_orden: Number(orden.id_orden),
        numero_orden: orden.numero_orden || `#${orden.id_orden}`,
        tipo_pedido: orden.tipo_pedido || 'MESA',
        fecha_creacion: toNullableDate(orden.fecha_creacion),
        fecha_cierre: toNullableDate(orden.fecha_cierre),
        estado: orden.estado,
        estado_cocina: orden.estado_cocina || 'SIN_ESTADO',
        nota_orden: orden.nota || '',
        mesa: orden.mesaRef
            ? {
                id_mesa: Number(orden.mesaRef.id_mesa),
                nombre: orden.mesaRef.nombre,
                numero: Number(orden.mesaRef.numero),
            }
            : null,
        mesero: orden.usuario
            ? {
                id_usuario: Number(orden.usuario.id_usuario),
                nombre: nombreMesero || 'Mesero',
            }
            : null,
        domiciliario: orden.domiciliario
            ? {
                id_usuario: Number(orden.domiciliario.id_usuario),
                nombre: nombreDomiciliario || 'Domiciliario',
            }
            : null,
        responsable,
        totales: {
            subtotal: toNumber(orden.subtotal),
            impuesto: toNumber(orden.impuesto),
            total: toNumber(orden.total),
        },
        metodo_pago: pagos.map((x) => x.metodo).join(' + ') || 'Sin registrar',
        pagos,
        items,
    };
}

module.exports = {
    REPORT_TYPES,
    DIAS_SEMANA,
    MAX_PRODUCTOS_FILTRO,
    getReporte,
    getExportPayload,
    getDetalleVentaPeriodo,
    getCatalogoProductos,
};
