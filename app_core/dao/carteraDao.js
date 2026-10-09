/**
 * DAO de la Cartera — el libro de caja de EscalApp (super admin).
 *
 * Ver `docs/cartera.md`. Las reglas (qué paga 4x1000, cómo se estima una comisión, qué se puede
 * editar de un movimiento automático) viven en `carteraService`; aquí solo el SQL.
 *
 * Todas las sumas en pesos usan `monto_cop`, que es NULL cuando falta la tasa de un movimiento en
 * otra moneda: ese movimiento se lista pero no suma, y el resumen dice cuántos hay así.
 */
'use strict';
const Models = require('../models/conection');

const sequelize = Models.sequelize;
const SELECT = sequelize.QueryTypes.SELECT;

const q = (sql, replacements = {}, opciones = {}) =>
    sequelize.query(sql, { replacements, type: SELECT, ...opciones });

/**
 * El efecto de cada movimiento sobre cada cuenta, en pesos. Es la única definición del saldo:
 * el resumen y la lista la usan igual. Ver la cabecera de `migrate_cartera.js`.
 */
const DELTAS_SQL = `
    SELECT m.id_cuenta, m.fecha,
           CASE m.tipo
               WHEN 'ingreso' THEN COALESCE(m.monto_cop, 0) - m.comision - m.iva_comision - m.retencion - m.gmf
               ELSE -(COALESCE(m.monto_cop, 0) + m.comision + m.iva_comision + m.gmf)
           END AS delta
      FROM cartera.car_movimiento m
     WHERE m.estado = 'A'
    UNION ALL
    SELECT m.id_cuenta_destino, m.fecha, COALESCE(m.monto_cop, 0)
      FROM cartera.car_movimiento m
     WHERE m.estado = 'A' AND m.tipo = 'transferencia'
`;

// ── Catálogos ───────────────────────────────────────────────────────────────────────────

async function listarCuentas() {
    return q(
        `SELECT id_cuenta, codigo, nombre, tipo, moneda, aplica_gmf, pasarela,
                saldo_inicial::float AS saldo_inicial,
                to_char(fecha_saldo, 'YYYY-MM-DD') AS fecha_saldo, nota, estado, orden
           FROM cartera.car_cuenta
          ORDER BY estado ASC, orden ASC, id_cuenta ASC;`
    );
}

async function getCuenta(idCuenta, { transaction } = {}) {
    const [fila] = await q(
        `SELECT id_cuenta, nombre, tipo, aplica_gmf, pasarela, estado
           FROM cartera.car_cuenta WHERE id_cuenta = :idCuenta;`,
        { idCuenta },
        { transaction }
    );
    return fila ?? null;
}

async function crearCuenta(datos) {
    const [fila] = await q(
        `INSERT INTO cartera.car_cuenta
                (nombre, tipo, moneda, aplica_gmf, saldo_inicial, fecha_saldo, nota, orden)
         VALUES (:nombre, :tipo, :moneda, :aplica_gmf, :saldo_inicial, :fecha_saldo, :nota,
                 (SELECT COALESCE(MAX(orden), 0) + 1 FROM cartera.car_cuenta))
         RETURNING id_cuenta;`,
        datos
    );
    return fila.id_cuenta;
}

async function actualizarCuenta(idCuenta, cambios) {
    const columnas = Object.keys(cambios);
    if (columnas.length === 0) return;
    await sequelize.query(
        `UPDATE cartera.car_cuenta
            SET ${columnas.map((c) => `${c} = :${c}`).join(', ')}
          WHERE id_cuenta = :idCuenta;`,
        { replacements: { ...cambios, idCuenta } }
    );
}

/** La cuenta a la que llega lo que cobra una pasarela; si no hay, la de `manual` (el banco). */
async function cuentaDePasarela(pasarela) {
    const [fila] = await q(
        `SELECT id_cuenta, aplica_gmf
           FROM cartera.car_cuenta
          WHERE estado = 'A' AND pasarela IN (:pasarela, 'manual')
          ORDER BY (pasarela = :pasarela) DESC
          LIMIT 1;`,
        { pasarela }
    );
    return fila ?? null;
}

async function listarCategorias() {
    return q(
        `SELECT id_categoria, codigo, nombre, tipo, sistema, estado, orden
           FROM cartera.car_categoria
          ORDER BY tipo ASC, orden ASC, nombre ASC;`
    );
}

async function getCategoria(idCategoria, { transaction } = {}) {
    const [fila] = await q(
        `SELECT id_categoria, codigo, tipo, sistema, estado
           FROM cartera.car_categoria WHERE id_categoria = :idCategoria;`,
        { idCategoria },
        { transaction }
    );
    return fila ?? null;
}

async function idCategoriaPorCodigo(codigo) {
    const [fila] = await q(
        `SELECT id_categoria FROM cartera.car_categoria WHERE codigo = :codigo;`,
        { codigo }
    );
    return fila?.id_categoria ?? null;
}

async function crearCategoria({ codigo, nombre, tipo }) {
    const [fila] = await q(
        `INSERT INTO cartera.car_categoria (codigo, nombre, tipo, orden)
         VALUES (:codigo, :nombre, :tipo,
                 (SELECT COALESCE(MAX(orden), 0) + 1 FROM cartera.car_categoria))
         ON CONFLICT (codigo) DO NOTHING
         RETURNING id_categoria;`,
        { codigo, nombre, tipo }
    );
    return fila?.id_categoria ?? null;
}

async function actualizarCategoria(idCategoria, cambios) {
    const columnas = Object.keys(cambios);
    if (columnas.length === 0) return;
    await sequelize.query(
        `UPDATE cartera.car_categoria
            SET ${columnas.map((c) => `${c} = :${c}`).join(', ')}
          WHERE id_categoria = :idCategoria;`,
        { replacements: { ...cambios, idCategoria } }
    );
}

async function listarTarifas() {
    return q(
        `SELECT t.pasarela, p.nombre,
                t.porcentaje::float AS porcentaje, t.fijo::float AS fijo, t.fijo_moneda,
                t.iva_pct::float AS iva_pct, t.retencion_pct::float AS retencion_pct, t.nota,
                t.actualizado_en
           FROM cartera.car_tarifa_pasarela t
           JOIN cobranza.cob_pasarela p ON p.codigo = t.pasarela
          ORDER BY p.orden ASC;`
    );
}

async function actualizarTarifa(pasarela, datos) {
    const [fila] = await q(
        `UPDATE cartera.car_tarifa_pasarela
            SET porcentaje = :porcentaje, fijo = :fijo, fijo_moneda = :fijo_moneda,
                iva_pct = :iva_pct, retencion_pct = :retencion_pct, nota = :nota,
                actualizado_en = now()
          WHERE pasarela = :pasarela
         RETURNING pasarela;`,
        { ...datos, pasarela }
    );
    return !!fila;
}

// ── Lo que entra solo ───────────────────────────────────────────────────────────────────

/** Facturas pagadas que todavía no tienen su movimiento. */
async function facturasSinMovimiento({ limite = 500 } = {}) {
    return q(
        `SELECT f.id_factura, f.id_negocio, n.nombre AS negocio, f.referencia, f.pasarela,
                f.moneda, f.total::float AS total,
                f.comision_pasarela::float AS comision_pasarela,
                f.retencion_declarada::float AS retencion_declarada,
                to_char(COALESCE(f.fecha_pago, f.actualizado_en)::date, 'YYYY-MM-DD') AS fecha,
                f.medio_pago_texto, f.numero_factura
           FROM cobranza.cob_factura f
           JOIN general.gener_negocio n ON n.id_negocio = f.id_negocio
          WHERE f.estado = 'pagada' AND f.total > 0
            AND NOT EXISTS (SELECT 1 FROM cartera.car_movimiento m WHERE m.id_factura = f.id_factura)
          ORDER BY f.id_factura ASC
          LIMIT :limite;`,
        { limite }
    );
}

/** Recargas de OpenAI anotadas en Terceros que todavía no tienen su movimiento. */
async function recargasSinMovimiento({ limite = 500 } = {}) {
    return q(
        `SELECT r.id_recarga, r.proveedor, r.monto_usd::float AS monto_usd,
                to_char(r.fecha::date, 'YYYY-MM-DD') AS fecha, r.nota, r.id_usuario
           FROM general.gener_recarga_ia r
          WHERE r.tipo = 'RECARGA' AND r.estado = 'A' AND r.monto_usd > 0
            AND NOT EXISTS (SELECT 1 FROM cartera.car_movimiento m WHERE m.id_recarga = r.id_recarga)
          ORDER BY r.id_recarga ASC
          LIMIT :limite;`,
        { limite }
    );
}

/**
 * Lo que se deshizo en el origen se anula aquí: una factura que pasó a anulada después de pagada
 * o una recarga borrada en Terceros. Devuelve cuántos se anularon.
 */
async function anularHuerfanos() {
    const filas = await q(
        `UPDATE cartera.car_movimiento m
            SET estado = 'E', actualizado_en = now(),
                motivo_anulacion = 'Se anuló en su origen (cobranza o Terceros).'
          WHERE m.estado = 'A'
            AND (   (m.origen = 'cobranza' AND (m.id_factura IS NULL OR EXISTS (
                        SELECT 1 FROM cobranza.cob_factura f
                         WHERE f.id_factura = m.id_factura AND f.estado <> 'pagada')))
                 OR (m.origen = 'recarga_ia' AND (m.id_recarga IS NULL OR EXISTS (
                        SELECT 1 FROM general.gener_recarga_ia r
                         WHERE r.id_recarga = m.id_recarga AND r.estado <> 'A'))))
         RETURNING m.id_movimiento;`
    );
    return filas.length;
}

// ── Movimientos ─────────────────────────────────────────────────────────────────────────

const COLUMNAS_MOVIMIENTO = [
    'tipo', 'fecha', 'id_categoria', 'id_cuenta', 'id_cuenta_destino', 'tercero', 'id_negocio',
    'descripcion', 'soporte', 'moneda', 'monto', 'tasa_cop', 'monto_cop', 'comision',
    'iva_comision', 'retencion', 'iva', 'gmf', 'exento_gmf', 'estimado', 'origen', 'id_factura',
    'id_recarga', 'id_usuario',
];

/**
 * Inserta un movimiento. Con `id_factura` o `id_recarga` choca contra el UNIQUE si otra petición
 * ya lo creó: `ON CONFLICT DO NOTHING` hace que dos sincronizaciones a la vez den un solo
 * movimiento. Devuelve el id, o null si ya existía.
 */
async function insertarMovimiento(datos, { transaction } = {}) {
    const fila = Object.fromEntries(COLUMNAS_MOVIMIENTO.map((c) => [c, datos[c] ?? null]));
    for (const c of ['comision', 'iva_comision', 'retencion', 'iva', 'gmf']) fila[c] = fila[c] ?? 0;
    fila.exento_gmf = !!fila.exento_gmf;
    fila.estimado = !!fila.estimado;
    fila.origen = fila.origen ?? 'manual';
    fila.moneda = fila.moneda ?? 'COP';

    const [creado] = await q(
        `INSERT INTO cartera.car_movimiento (${COLUMNAS_MOVIMIENTO.join(', ')})
         VALUES (${COLUMNAS_MOVIMIENTO.map((c) => `:${c}`).join(', ')})
         ON CONFLICT DO NOTHING
         RETURNING id_movimiento;`,
        fila,
        { transaction }
    );
    return creado?.id_movimiento ?? null;
}

async function getMovimiento(idMovimiento, { transaction, lock = false } = {}) {
    const [fila] = await q(
        `SELECT id_movimiento, tipo, to_char(fecha, 'YYYY-MM-DD') AS fecha, id_categoria,
                id_cuenta, id_cuenta_destino, tercero, id_negocio, descripcion, soporte, moneda,
                monto::float AS monto, tasa_cop::float AS tasa_cop, monto_cop::float AS monto_cop,
                comision::float AS comision, iva_comision::float AS iva_comision,
                retencion::float AS retencion, iva::float AS iva, gmf::float AS gmf,
                exento_gmf, estimado, origen, id_factura, id_recarga, estado
           FROM cartera.car_movimiento
          WHERE id_movimiento = :idMovimiento
          ${lock ? 'FOR UPDATE' : ''};`,
        { idMovimiento },
        { transaction }
    );
    return fila ?? null;
}

async function actualizarMovimiento(idMovimiento, cambios, { transaction } = {}) {
    const columnas = Object.keys(cambios);
    if (columnas.length === 0) return;
    await sequelize.query(
        `UPDATE cartera.car_movimiento
            SET ${columnas.map((c) => `${c} = :${c}`).join(', ')}, actualizado_en = now()
          WHERE id_movimiento = :idMovimiento;`,
        { replacements: { ...cambios, idMovimiento }, transaction }
    );
}

async function listarMovimientos({ desde, hasta, tipo, idCategoria, idCuenta, origen, busqueda,
    incluirAnulados = false, limite = 2000 }) {
    return q(
        `SELECT m.id_movimiento, m.tipo, to_char(m.fecha, 'YYYY-MM-DD') AS fecha,
                m.id_categoria, c.nombre AS categoria,
                m.id_cuenta, cu.nombre AS cuenta,
                m.id_cuenta_destino, cd.nombre AS cuenta_destino,
                m.tercero, m.id_negocio, n.nombre AS negocio, m.descripcion, m.soporte,
                m.moneda, m.monto::float AS monto, m.tasa_cop::float AS tasa_cop,
                m.monto_cop::float AS monto_cop,
                m.comision::float AS comision, m.iva_comision::float AS iva_comision,
                m.retencion::float AS retencion, m.iva::float AS iva, m.gmf::float AS gmf,
                m.exento_gmf, m.estimado, m.origen, m.id_factura, m.id_recarga,
                f.referencia AS referencia_factura,
                m.estado, m.motivo_anulacion, m.creado_en
           FROM cartera.car_movimiento m
           JOIN cartera.car_cuenta cu ON cu.id_cuenta = m.id_cuenta
           LEFT JOIN cartera.car_cuenta cd ON cd.id_cuenta = m.id_cuenta_destino
           LEFT JOIN cartera.car_categoria c ON c.id_categoria = m.id_categoria
           LEFT JOIN general.gener_negocio n ON n.id_negocio = m.id_negocio
           LEFT JOIN cobranza.cob_factura f ON f.id_factura = m.id_factura
          WHERE m.fecha BETWEEN :desde AND :hasta
            AND (:incluirAnulados OR m.estado = 'A')
            AND (:tipo::text IS NULL OR m.tipo = :tipo)
            AND (:idCategoria::int IS NULL OR m.id_categoria = :idCategoria)
            AND (:idCuenta::int IS NULL OR m.id_cuenta = :idCuenta OR m.id_cuenta_destino = :idCuenta)
            AND (:origen::text IS NULL OR m.origen = :origen)
            AND (:busqueda::text IS NULL
                 OR m.tercero ILIKE '%' || :busqueda || '%'
                 OR m.descripcion ILIKE '%' || :busqueda || '%'
                 OR m.soporte ILIKE '%' || :busqueda || '%'
                 OR n.nombre ILIKE '%' || :busqueda || '%')
          ORDER BY m.fecha DESC, m.id_movimiento DESC
          LIMIT :limite;`,
        {
            desde, hasta, limite, incluirAnulados,
            tipo: tipo ?? null,
            idCategoria: idCategoria ?? null,
            idCuenta: idCuenta ?? null,
            origen: origen ?? null,
            busqueda: busqueda ?? null,
        }
    );
}

// ── Resumen ─────────────────────────────────────────────────────────────────────────────

async function totalesPeriodo({ desde, hasta }) {
    const [fila] = await q(
        `SELECT COALESCE(SUM(monto_cop) FILTER (WHERE tipo = 'ingreso'), 0)::float AS ingresos,
                COALESCE(SUM(monto_cop) FILTER (WHERE tipo = 'egreso'), 0)::float  AS egresos,
                COALESCE(SUM(comision + iva_comision) FILTER (WHERE tipo = 'ingreso'), 0)::float
                    AS comisiones_pasarela,
                COALESCE(SUM(comision + iva_comision) FILTER (WHERE tipo <> 'ingreso'), 0)::float
                    AS comisiones_bancarias,
                COALESCE(SUM(iva_comision), 0)::float AS iva_comisiones,
                COALESCE(SUM(retencion), 0)::float    AS retenciones,
                COALESCE(SUM(gmf), 0)::float          AS gmf,
                COALESCE(SUM(iva) FILTER (WHERE tipo = 'egreso'), 0)::float AS iva_compras,
                COUNT(*) FILTER (WHERE tipo = 'ingreso')::int AS n_ingresos,
                COUNT(*) FILTER (WHERE tipo = 'egreso')::int  AS n_egresos,
                COUNT(*) FILTER (WHERE estimado)::int          AS estimados,
                COUNT(*) FILTER (WHERE monto_cop IS NULL)::int AS sin_tasa
           FROM cartera.car_movimiento
          WHERE estado = 'A' AND fecha BETWEEN :desde AND :hasta;`,
        { desde, hasta }
    );
    return fila;
}

async function porCategoria({ desde, hasta }) {
    return q(
        `SELECT m.tipo, c.id_categoria, c.nombre, COALESCE(SUM(m.monto_cop), 0)::float AS total,
                COUNT(*)::int AS movimientos
           FROM cartera.car_movimiento m
           JOIN cartera.car_categoria c ON c.id_categoria = m.id_categoria
          WHERE m.estado = 'A' AND m.tipo IN ('ingreso','egreso')
            AND m.fecha BETWEEN :desde AND :hasta
          GROUP BY m.tipo, c.id_categoria, c.nombre
          ORDER BY m.tipo, total DESC;`,
        { desde, hasta }
    );
}

/** De quién viene la plata: los clientes que más ingresos dejaron en el período. */
async function ingresosPorTercero({ desde, hasta, limite = 8 }) {
    return q(
        `SELECT COALESCE(n.nombre, NULLIF(TRIM(m.tercero), ''), 'Sin tercero') AS tercero,
                COALESCE(SUM(m.monto_cop), 0)::float AS total, COUNT(*)::int AS movimientos
           FROM cartera.car_movimiento m
           LEFT JOIN general.gener_negocio n ON n.id_negocio = m.id_negocio
          WHERE m.estado = 'A' AND m.tipo = 'ingreso' AND m.fecha BETWEEN :desde AND :hasta
          GROUP BY 1
          ORDER BY total DESC
          LIMIT :limite;`,
        { desde, hasta, limite }
    );
}

/** Los últimos `meses` meses calendario que terminan en el mes de `hasta`, incluidos los vacíos. */
async function porMes({ hasta, meses = 12 }) {
    return q(
        `WITH meses AS (
             SELECT generate_series(
                        date_trunc('month', :hasta::date) - make_interval(months => :meses - 1),
                        date_trunc('month', :hasta::date), interval '1 month')::date AS mes
         )
         SELECT to_char(x.mes, 'YYYY-MM') AS mes,
                COALESCE(SUM(m.monto_cop) FILTER (WHERE m.tipo = 'ingreso'), 0)::float AS ingresos,
                COALESCE(SUM(m.monto_cop) FILTER (WHERE m.tipo = 'egreso'), 0)::float  AS egresos,
                COALESCE(SUM(m.comision + m.iva_comision + m.gmf), 0)::float           AS costos_financieros,
                COALESCE(SUM(m.retencion), 0)::float                                   AS retenciones
           FROM meses x
           LEFT JOIN cartera.car_movimiento m
                  ON m.estado = 'A' AND date_trunc('month', m.fecha)::date = x.mes
          GROUP BY x.mes
          ORDER BY x.mes ASC;`,
        { hasta, meses }
    );
}

/** Saldo de cada cuenta al cierre de `hasta`: saldo inicial + lo que se movió desde su fecha. */
async function saldosCuentas({ hasta }) {
    return q(
        `SELECT cu.id_cuenta, cu.nombre, cu.tipo, cu.aplica_gmf, cu.estado,
                (cu.saldo_inicial + COALESCE(SUM(d.delta), 0))::float AS saldo
           FROM cartera.car_cuenta cu
           LEFT JOIN (${DELTAS_SQL}) d
                  ON d.id_cuenta = cu.id_cuenta
                 AND d.fecha <= :hasta
                 AND (cu.fecha_saldo IS NULL OR d.fecha >= cu.fecha_saldo)
          GROUP BY cu.id_cuenta
          ORDER BY cu.estado ASC, cu.orden ASC, cu.id_cuenta ASC;`,
        { hasta }
    );
}

/** Lo que nos deben hoy: facturas de mensualidad pendientes (las de Cobranza). */
async function porCobrar() {
    const [fila] = await q(
        `SELECT COALESCE(SUM(total) FILTER (WHERE moneda = 'COP'), 0)::float AS total,
                COUNT(*)::int AS facturas,
                COUNT(DISTINCT id_negocio)::int AS negocios
           FROM cobranza.cob_factura
          WHERE estado = 'pendiente';`
    );
    return fila;
}

module.exports = {
    listarCuentas,
    getCuenta,
    crearCuenta,
    actualizarCuenta,
    cuentaDePasarela,
    listarCategorias,
    getCategoria,
    idCategoriaPorCodigo,
    crearCategoria,
    actualizarCategoria,
    listarTarifas,
    actualizarTarifa,
    facturasSinMovimiento,
    recargasSinMovimiento,
    anularHuerfanos,
    insertarMovimiento,
    getMovimiento,
    actualizarMovimiento,
    listarMovimientos,
    totalesPeriodo,
    porCategoria,
    ingresosPorTercero,
    porMes,
    saldosCuentas,
    porCobrar,
};
