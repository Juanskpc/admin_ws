'use strict';
const { Op } = require('sequelize');
const Models = require('../../app_core/models/conection');

/**
 * cajaService — Gestión de turno de caja del restaurante.
 *
 * Reglas:
 *  - Una sola caja abierta por negocio (índice único parcial en BD).
 *  - El cierre calcula `monto_esperado = apertura + ingresos - egresos`.
 *  - Si el cajero reporta un monto físico contado, se guarda
 *    `diferencia = reportado - esperado` (informativo, no bloquea cierre).
 *  - El cobro de una orden registra automáticamente un movimiento INGRESO
 *    en la caja abierta (ver pedidoService.cerrarOrden).
 */

function buildCajaCerradaError() {
    const err = new Error('No hay una caja abierta para este negocio. Abre la caja para continuar.');
    err.code = 'CAJA_CERRADA';
    err.statusCode = 409;
    return err;
}

/** Lanza CAJA_CERRADA si no existe caja abierta. Se usa antes de operaciones que mueven dinero. */
async function requireCajaAbierta(idNegocio, { transaction } = {}) {
    const caja = await Models.RestCaja.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
        transaction,
        lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });
    if (!caja) throw buildCajaCerradaError();
    return caja;
}

async function abrirCaja({ idNegocio, idUsuario, montoApertura, observaciones }) {
    const existente = await Models.RestCaja.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
    });
    if (existente) {
        const err = new Error('Ya existe una caja abierta para este negocio.');
        err.code = 'CAJA_YA_ABIERTA';
        err.statusCode = 409;
        throw err;
    }
    return Models.RestCaja.create({
        id_negocio: idNegocio,
        id_usuario: idUsuario,
        monto_apertura: montoApertura,
        observaciones: observaciones || null,
        estado: 'A',
    });
}

/**
 * Retorna el total de ingresos del turno agrupado por forma de pago.
 * Los movimientos sin orden asociada se listan como "Manual / Sin orden".
 */
async function getDesglosePorMetodo(idCaja) {
    const rows = await Models.sequelize.query(`
        SELECT
            po.id_metodo_pago,
            COALESCE(mp.nombre, 'Manual / Sin orden') AS nombre,
            SUM(m.monto)                               AS total
        FROM restaurante.rest_movimiento_caja m
        LEFT JOIN restaurante.pedid_orden      po ON po.id_orden       = m.id_orden
        LEFT JOIN restaurante.rest_metodo_pago mp ON mp.id_metodo_pago = po.id_metodo_pago
        WHERE m.id_caja = :idCaja AND m.tipo = 'INGRESO'
        GROUP BY po.id_metodo_pago, mp.nombre
        ORDER BY total DESC
    `, {
        replacements: { idCaja },
        type: Models.sequelize.QueryTypes.SELECT,
    });
    return rows.map((r) => ({
        id_metodo_pago: r.id_metodo_pago ?? null,
        nombre:         r.nombre ?? 'Manual / Sin orden',
        total:          Number(r.total ?? 0),
    }));
}

async function getResumenDomiciliarios(idNegocio) {
    const caja = await Models.RestCaja.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_caja', 'fecha_apertura'],
    });

    console.log('consulta caja domicilarios ----->', caja);

    if (!caja) {
        return {
            resumen: {
                domiciliarios: 0,
                total_pedidos: 0,
                pedidos_adelantados: 0,
                pedidos_cobrados: 0,
                pedidos_en_posesion: 0,
                monto_adelantado: 0,
                monto_cobrado: 0,
                monto_en_posesion: 0,
            },
            rows: [],
        };
    }

    const rows = await Models.sequelize.query(`
        SELECT
            o.id_domiciliario,
            COALESCE(TRIM(CONCAT(u.primer_nombre, ' ', u.primer_apellido)), 'Sin domiciliario') AS domiciliario,
            COUNT(*)::int AS total_pedidos,
            SUM(CASE WHEN o.estado_pago = 'pagado' AND o.id_caja IS NOT NULL THEN 1 ELSE 0 END)::int AS pedidos_adelantados,
            SUM(CASE WHEN COALESCE(o.estado_pago, 'pendiente_pago') = 'pendiente_pago' THEN 1 ELSE 0 END)::int AS pedidos_cobrados,
            SUM(CASE WHEN o.estado_pago = 'pagado' AND o.id_caja IS NULL THEN 1 ELSE 0 END)::int AS pedidos_en_posesion,
            COALESCE(SUM(CASE WHEN o.estado_pago = 'pagado' AND o.id_caja IS NOT NULL THEN o.total ELSE 0 END), 0)::numeric AS monto_adelantado,
            COALESCE(SUM(CASE WHEN COALESCE(o.estado_pago, 'pendiente_pago') = 'pendiente_pago' THEN o.total ELSE 0 END), 0)::numeric AS monto_cobrado,
            COALESCE(SUM(CASE WHEN o.estado_pago = 'pagado' AND o.id_caja IS NULL THEN o.total ELSE 0 END), 0)::numeric AS monto_en_posesion
        FROM restaurante.pedid_orden o
        LEFT JOIN general.gener_usuario u ON u.id_usuario = o.id_domiciliario
        WHERE o.id_negocio = :idNegocio
          AND o.estado IN ('ABIERTA', 'CERRADA')
          AND o.tipo_pedido = 'DOMICILIO'
          AND o.id_domiciliario IS NOT NULL
          AND COALESCE(o.fecha_cierre, o.fecha_creacion) >= :fechaApertura
        GROUP BY o.id_domiciliario, u.primer_nombre, u.primer_apellido
        ORDER BY pedidos_cobrados DESC, total_pedidos DESC, domiciliario ASC
    `, {
        replacements: { idNegocio, fechaApertura: caja.fecha_apertura },
        type: Models.sequelize.QueryTypes.SELECT,
    });

    const resumen = rows.reduce((acc, row) => {
        acc.domiciliarios += 1;
        acc.total_pedidos += Number(row.total_pedidos ?? 0);
        acc.pedidos_adelantados += Number(row.pedidos_adelantados ?? 0);
        acc.pedidos_cobrados += Number(row.pedidos_cobrados ?? 0);
        acc.pedidos_en_posesion += Number(row.pedidos_en_posesion ?? 0);
        acc.monto_adelantado += Number(row.monto_adelantado ?? 0);
        acc.monto_cobrado += Number(row.monto_cobrado ?? 0);
        acc.monto_en_posesion += Number(row.monto_en_posesion ?? 0);
        return acc;
    }, {
        domiciliarios: 0,
        total_pedidos: 0,
        pedidos_adelantados: 0,
        pedidos_cobrados: 0,
        pedidos_en_posesion: 0,
        monto_adelantado: 0,
        monto_cobrado: 0,
        monto_en_posesion: 0,
    });

    return {
        resumen,
        rows: rows.map((row) => ({
            id_domiciliario: row.id_domiciliario ?? null,
            domiciliario: row.domiciliario ?? 'Sin domiciliario',
            total_pedidos: Number(row.total_pedidos ?? 0),
            pedidos_adelantados: Number(row.pedidos_adelantados ?? 0),
            pedidos_cobrados: Number(row.pedidos_cobrados ?? 0),
            pedidos_en_posesion: Number(row.pedidos_en_posesion ?? 0),
            monto_adelantado: Number(row.monto_adelantado ?? 0),
            monto_cobrado: Number(row.monto_cobrado ?? 0),
            monto_en_posesion: Number(row.monto_en_posesion ?? 0),
        })),
    };
}

async function transferirDomiciliarioACaja({ idNegocio, idDomiciliario, idUsuario }) {
    const t = await Models.sequelize.transaction();
    try {
        const caja = await requireCajaAbierta(idNegocio, { transaction: t });
        const fechaFiltro = caja.fecha_apertura;

        const ordenes = await Models.PedidOrden.findAll({
            where: {
                id_negocio: idNegocio,
                tipo_pedido: 'DOMICILIO',
                id_domiciliario: idDomiciliario,
                estado_pago: 'pagado',
                id_caja: null,
                [Op.and]: [
                    Models.sequelize.where(
                        Models.sequelize.fn(
                            'COALESCE',
                            Models.sequelize.col('fecha_cierre'),
                            Models.sequelize.col('fecha_creacion'),
                        ),
                        { [Op.gte]: fechaFiltro },
                    ),
                ],
            },
            order: [['fecha_creacion', 'ASC'], ['id_orden', 'ASC']],
            transaction: t,
            lock: t.LOCK.UPDATE,
        });

        if (ordenes.length === 0) {
            await t.commit();
            return { total_pedidos: 0, total_monto: 0 };
        }

        let totalMonto = 0;
        for (const orden of ordenes) {
            const numeroOrden = orden.numero_orden || `#${orden.id_orden}`;
            await registrarIngresoOrden({
                idNegocio,
                idOrden: orden.id_orden,
                idUsuario,
                monto: Number(orden.total || 0),
                numeroOrden,
                transaction: t,
            });
            totalMonto += Number(orden.total || 0);
            await orden.update({ id_caja: caja.id_caja }, { transaction: t });
        }

        await t.commit();
        return { total_pedidos: ordenes.length, total_monto: totalMonto };
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

/**
 * Verifica si existen operaciones que impidan cerrar caja:
 *  - Mesas con pedidos sin cobrar (ABIERTA + pendiente_pago).
 *  - Domicilios o pedidos para llevar sin finalizar (ABIERTA).
 */
async function validarPendientesCierre(idNegocio) {
    const [mesas, domicilios, llevar] = await Promise.all([
        Models.PedidOrden.count({
            where: { id_negocio: idNegocio, estado: 'ABIERTA', tipo_pedido: 'MESA', estado_pago: 'pendiente_pago' },
        }),
        Models.PedidOrden.count({
            where: { id_negocio: idNegocio, estado: 'ABIERTA', tipo_pedido: 'DOMICILIO' },
        }),
        Models.PedidOrden.count({
            where: { id_negocio: idNegocio, estado: 'ABIERTA', tipo_pedido: 'LLEVAR' },
        }),
    ]);
    return {
        puedesCerrar: mesas === 0 && domicilios === 0 && llevar === 0,
        mesas,
        domicilios,
        llevar,
    };
}

async function cerrarCaja({ idCaja, idNegocio, montoReportado, observaciones }) {
    const pendientes = await validarPendientesCierre(idNegocio);
    if (!pendientes.puedesCerrar) {
        const err = new Error('No se puede cerrar la caja con operaciones pendientes.');
        err.code        = 'PENDIENTES_ACTIVOS';
        err.statusCode  = 409;
        err.pendientes  = { mesas: pendientes.mesas, domicilios: pendientes.domicilios, llevar: pendientes.llevar };
        throw err;
    }

    const caja = await Models.RestCaja.findOne({
        where: { id_caja: idCaja, id_negocio: idNegocio, estado: 'A' },
        include: [{ model: Models.RestMovimientoCaja, as: 'movimientos' }],
    });
    if (!caja) return null;

    const ingresos = caja.movimientos
        .filter((m) => m.tipo === 'INGRESO')
        .reduce((sum, m) => sum + Number(m.monto), 0);
    const egresos = caja.movimientos
        .filter((m) => m.tipo === 'EGRESO')
        .reduce((sum, m) => sum + Number(m.monto), 0);

    const esperado = Number(caja.monto_apertura) + ingresos - egresos;
    const reportado = montoReportado != null && !Number.isNaN(Number(montoReportado))
        ? Number(montoReportado)
        : null;
    const diferencia = reportado != null ? reportado - esperado : null;

    caja.monto_cierre    = esperado;
    caja.monto_reportado = reportado;
    caja.diferencia      = diferencia;
    caja.fecha_cierre    = new Date();
    caja.estado          = 'C';
    if (observaciones) {
        caja.observaciones = caja.observaciones
            ? `${caja.observaciones}\n[CIERRE] ${observaciones}`
            : observaciones;
    }
    await caja.save();
    return caja;
}

async function getCajaAbierta(idNegocio) {
    const caja = await Models.RestCaja.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
        include: [
            {
                model: Models.GenerUsuario,
                as: 'usuario',
                attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
            },
            {
                model: Models.RestMovimientoCaja,
                as: 'movimientos',
                attributes: ['tipo', 'monto'],
            },
        ],
    });
    if (!caja) return null;

    const ingresos = caja.movimientos
        .filter((m) => m.tipo === 'INGRESO')
        .reduce((sum, m) => sum + Number(m.monto), 0);
    const egresos = caja.movimientos
        .filter((m) => m.tipo === 'EGRESO')
        .reduce((sum, m) => sum + Number(m.monto), 0);

    const [json, desglose] = await Promise.all([
        Promise.resolve(caja.toJSON()),
        getDesglosePorMetodo(caja.id_caja),
    ]);
    json.ingresos            = ingresos;
    json.egresos             = egresos;
    json.monto_esperado      = Number(caja.monto_apertura) + ingresos - egresos;
    json.ingresos_por_metodo = desglose;
    delete json.movimientos;
    return json;
}

async function getMovimientos(idCaja) {
    return Models.RestMovimientoCaja.findAll({
        where: { id_caja: idCaja },
        include: [
            {
                model: Models.GenerUsuario,
                as: 'usuario',
                attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
            },
            {
                model: Models.PedidOrden,
                as: 'orden',
                attributes: ['id_orden', 'numero_orden', 'tipo_pedido'],
                required: false,
            },
        ],
        order: [['fecha', 'DESC']],
    });
}

async function registrarMovimiento({ idCaja, tipo, monto, concepto, idUsuario, idOrden, transaction }) {
    if (!['INGRESO', 'EGRESO'].includes(tipo)) {
        const err = new Error('Tipo de movimiento inválido (INGRESO o EGRESO).');
        err.statusCode = 422;
        throw err;
    }
    if (!(Number(monto) > 0)) {
        const err = new Error('El monto debe ser mayor a cero.');
        err.statusCode = 422;
        throw err;
    }
    return Models.RestMovimientoCaja.create({
        id_caja: idCaja,
        tipo,
        monto,
        concepto: concepto || null,
        id_orden: idOrden || null,
        id_usuario: idUsuario,
    }, { transaction });
}

/**
 * Variante segura para registrar el INGRESO automático del cobro:
 * verifica que la caja siga abierta dentro de la transacción.
 */
async function registrarIngresoOrden({ idNegocio, idOrden, idUsuario, monto, numeroOrden, transaction }) {
    const caja = await requireCajaAbierta(idNegocio, { transaction });
    await registrarMovimiento({
        idCaja: caja.id_caja,
        tipo: 'INGRESO',
        monto,
        concepto: `Orden ${numeroOrden}`,
        idUsuario,
        idOrden,
        transaction,
    });
    return caja;
}

module.exports = {
    requireCajaAbierta,
    abrirCaja,
    cerrarCaja,
    getCajaAbierta,
    getMovimientos,
    getResumenDomiciliarios,
    transferirDomiciliarioACaja,
    registrarMovimiento,
    registrarIngresoOrden,
    getDesglosePorMetodo,
    validarPendientesCierre,
};
