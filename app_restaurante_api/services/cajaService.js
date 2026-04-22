'use strict';
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

async function cerrarCaja({ idCaja, idNegocio, montoReportado, observaciones }) {
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

    const json = caja.toJSON();
    json.ingresos = ingresos;
    json.egresos = egresos;
    json.monto_esperado = Number(caja.monto_apertura) + ingresos - egresos;
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
                attributes: ['id_orden', 'numero_orden'],
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
    registrarMovimiento,
    registrarIngresoOrden,
};
