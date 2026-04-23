const Models = require('../../app_core/models/conection');
const DashboardService = require('./dashboardService');

const MAX_PAGE_SIZE = 100;
const EXPORT_MAX_ROWS = 5000;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_RANGE_DAYS = 30;

const REPORT_TYPES = {
    ventas_periodo: {
        titulo: 'Ventas por pedido',
        columns: [
            { key: 'numero_orden', label: 'Orden', type: 'text' },
            { key: 'fecha_pedido', label: 'Fecha pedido', type: 'date' },
            { key: 'mesa', label: 'Mesa', type: 'text' },
            { key: 'mesero', label: 'Mesero', type: 'text' },
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

function createHttpError(message, statusCode = 500, code = 'REPORTES_ERROR') {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
}

/**
 * Parsea YYYY-MM-DD como medianoche en hora Bogotá (UTC-5, sin DST).
 * Devuelve un Date que representa el momento UTC equivalente, así postgres
 * compara correctamente contra `timestamp without time zone` cuando la session
 * está en SET TIME ZONE 'America/Bogota'.
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
            total: toNumber(row.total),
            fecha_pedido: toNullableDate(row.fecha_pedido || row.fecha_cierre),
            mesero: row.mesero || row.cajero || 'No registrado',
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
        return rows.map((row) => ({
            ...row,
            ordenes_cerradas: toNumber(row.ordenes_cerradas),
            ticket_promedio: toNumber(row.ticket_promedio),
            ventas_totales: toNumber(row.ventas_totales),
            ultima_venta: toNullableDate(row.ultima_venta),
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
        return [
            { key: 'usuarios_activos', label: 'Usuarios con ventas', value: toNumber(resumenRow.usuarios_activos), type: 'number' },
            { key: 'ordenes_cerradas', label: 'Ordenes cerradas', value: toNumber(resumenRow.ordenes_cerradas), type: 'number' },
            { key: 'ventas_totales', label: 'Ventas totales', value: toNumber(resumenRow.ventas_totales), type: 'currency' },
            { key: 'ticket_promedio', label: 'Ticket promedio', value: toNumber(resumenRow.ticket_promedio), type: 'currency' },
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
            COALESCE(o.fecha_creacion, o.fecha_cierre) AS fecha_pedido,
            COALESCE(m.nombre, 'Para llevar') AS mesa,
            TRIM(CONCAT(u.primer_nombre, ' ', u.primer_apellido)) AS mesero,
            COALESCE(mp.nombre, 'Sin método') AS metodo_pago,
            o.total
        FROM restaurante.pedid_orden o
        LEFT JOIN restaurante.rest_mesa m ON m.id_mesa = o.id_mesa
        LEFT JOIN general.gener_usuario u ON u.id_usuario = o.id_usuario
        LEFT JOIN restaurante.rest_metodo_pago mp ON mp.id_metodo_pago = o.id_metodo_pago
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= ($2::date AT TIME ZONE 'America/Bogota')
          AND o.fecha_cierre < (($3::date + 1) AT TIME ZONE 'America/Bogota')
        ORDER BY COALESCE(o.fecha_creacion, o.fecha_cierre) DESC, o.id_orden DESC
        LIMIT $4 OFFSET $5
    `;

    const countQuery = `
        SELECT COUNT(*)::int AS total
        FROM restaurante.pedid_orden o
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= ($2::date AT TIME ZONE 'America/Bogota')
          AND o.fecha_cierre < (($3::date + 1) AT TIME ZONE 'America/Bogota')
    `;

    const summaryQuery = `
        SELECT
            COALESCE(SUM(o.total), 0)::numeric AS ventas_totales,
            COUNT(*)::int AS ordenes_cobradas,
            COALESCE(AVG(o.total), 0)::numeric AS ticket_promedio
        FROM restaurante.pedid_orden o
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= ($2::date AT TIME ZONE 'America/Bogota')
          AND o.fecha_cierre < (($3::date + 1) AT TIME ZONE 'America/Bogota')
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

async function runProductosMasVendidosQuery({ idNegocio, startDate, endDate, page, pageSize, offset, exportMode }) {
    const limit = exportMode ? EXPORT_MAX_ROWS : pageSize;

    const baseFilter = `
        FROM restaurante.pedid_detalle d
        INNER JOIN restaurante.pedid_orden o ON o.id_orden = d.id_orden
        INNER JOIN restaurante.carta_producto p ON p.id_producto = d.id_producto
        WHERE o.id_negocio = $1
          AND o.estado = 'CERRADA'
          AND o.fecha_cierre >= ($2::date AT TIME ZONE 'America/Bogota')
          AND o.fecha_cierre < (($3::date + 1) AT TIME ZONE 'America/Bogota')
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
          AND o.fecha_cierre >= ($2::date AT TIME ZONE 'America/Bogota')
          AND o.fecha_cierre < (($3::date + 1) AT TIME ZONE 'America/Bogota')
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
              AND o.fecha_cierre >= ($2::date AT TIME ZONE 'America/Bogota')
              AND o.fecha_cierre < (($3::date + 1) AT TIME ZONE 'America/Bogota')
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
          AND o.fecha_cierre >= ($2::date AT TIME ZONE 'America/Bogota')
          AND o.fecha_cierre < (($3::date + 1) AT TIME ZONE 'America/Bogota')
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

async function runRendimientoUsuariosQuery({ idNegocio, startDate, endDate, page, pageSize, offset, exportMode }) {
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
          AND o.fecha_cierre >= ($2::date AT TIME ZONE 'America/Bogota')
          AND o.fecha_cierre < (($3::date + 1) AT TIME ZONE 'America/Bogota')
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
              AND o.fecha_cierre >= ($2::date AT TIME ZONE 'America/Bogota')
              AND o.fecha_cierre < (($3::date + 1) AT TIME ZONE 'America/Bogota')
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
          AND o.fecha_cierre >= ($2::date AT TIME ZONE 'America/Bogota')
          AND o.fecha_cierre < (($3::date + 1) AT TIME ZONE 'America/Bogota')
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
          AND o.fecha_creacion >= ($2::date AT TIME ZONE 'America/Bogota')
          AND o.fecha_creacion < (($3::date + 1) AT TIME ZONE 'America/Bogota')
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
              AND o.fecha_creacion >= ($2::date AT TIME ZONE 'America/Bogota')
              AND o.fecha_creacion < (($3::date + 1) AT TIME ZONE 'America/Bogota')
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
          AND o.fecha_creacion >= ($2::date AT TIME ZONE 'America/Bogota')
          AND o.fecha_creacion < (($3::date + 1) AT TIME ZONE 'America/Bogota')
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
    return runEstadoCocinaQuery(params);
}

async function getReporte({ idUsuario, idNegocio, tipo = 'ventas_periodo', fechaDesde, fechaHasta, page = 1, pageSize = DEFAULT_PAGE_SIZE }) {
    if (!REPORT_TYPES[tipo]) {
        throw createHttpError('Tipo de reporte no soportado.', 422, 'REPORTE_TIPO_INVALIDO');
    }

    const negocioContext = await resolveNegocioContext(idUsuario, idNegocio);
    const rangoFechas = buildDateRange(fechaDesde, fechaHasta);
    const pagination = buildPagination(page, pageSize);

    const reportResult = await runReportQuery(tipo, {
        idNegocio: negocioContext.idNegocio,
        startDate: rangoFechas.startDate,
        endDate: rangoFechas.endDate,
        ...pagination,
        exportMode: false,
    });

    const normalizedRows = normalizeRows(tipo, reportResult.rows || []);
    const totalPages = Math.max(1, Math.ceil((reportResult.total || 0) / pagination.pageSize));

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
        },
        columns: REPORT_TYPES[tipo].columns,
        resumen: mapResumenItems(tipo, reportResult.resumen || {}, rangoFechas),
        rows: normalizedRows,
        pagination: {
            page: pagination.page,
            page_size: pagination.pageSize,
            total: reportResult.total || 0,
            total_pages: totalPages,
        },
    };
}

async function getExportPayload({ idUsuario, idNegocio, tipo = 'ventas_periodo', fechaDesde, fechaHasta }) {
    if (!REPORT_TYPES[tipo]) {
        throw createHttpError('Tipo de reporte no soportado.', 422, 'REPORTE_TIPO_INVALIDO');
    }

    const negocioContext = await resolveNegocioContext(idUsuario, idNegocio);
    const rangoFechas = buildDateRange(fechaDesde, fechaHasta);

    const reportResult = await runReportQuery(tipo, {
        idNegocio: negocioContext.idNegocio,
        startDate: rangoFechas.startDate,
        endDate: rangoFechas.endDate,
        page: 1,
        pageSize: EXPORT_MAX_ROWS,
        offset: 0,
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

    const columns = REPORT_TYPES[tipo].columns;
    const resumen = mapResumenItems(tipo, reportResult.resumen || {}, rangoFechas).reduce((acc, item) => {
        acc[item.label] = item.value;
        return acc;
    }, {});

    return {
        tipo,
        titulo: REPORT_TYPES[tipo].titulo,
        negocio: {
            id_negocio: negocioContext.idNegocio,
            nombre: negocioContext.negocioNombre,
        },
        columns,
        rows,
        exportRows: buildExportRows(rows, columns),
        resumen,
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

    return {
        id_orden: Number(orden.id_orden),
        numero_orden: orden.numero_orden || `#${orden.id_orden}`,
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
        totales: {
            subtotal: toNumber(orden.subtotal),
            impuesto: toNumber(orden.impuesto),
            total: toNumber(orden.total),
        },
        items,
    };
}

module.exports = {
    REPORT_TYPES,
    getReporte,
    getExportPayload,
    getDetalleVentaPeriodo,
};
