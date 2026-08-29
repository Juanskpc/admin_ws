'use strict';
const Models = require('../../app_core/models/conection');
const Reglas = require('./reglasAgenda');
const { Op } = Models.Sequelize;

/**
 * Caja del salón: turno de apertura a cierre, con lo que entra y lo que sale.
 *
 * ## Las dos formas de leer el mismo dinero
 *
 * Cada ingreso guarda **a la vez** con qué forma de pago entró y qué profesional prestó el
 * servicio. Eso permite las dos vistas que pide el negocio sin duplicar registros ni recalcular
 * nada:
 *
 * - **Por forma de pago** — siempre. Es lo que se cuenta al cuadrar el cajón contra el datáfono.
 * - **Por profesional** — solo si `permite_cobro_profesional` está activo. Es lo que hay que
 *   liquidarle a cada uno al cerrar el día.
 *
 * Guardar el profesional en el movimiento aunque el negocio no liquide por persona es
 * deliberado: si mañana activa la opción, el histórico ya está completo. Reconstruirlo después
 * desde la cita no funcionaría, porque una cita puede haber cambiado de profesional.
 *
 * ## Una sola caja abierta
 *
 * Lo garantiza un índice único parcial en la BD, no esta clase. Dos peticiones de apertura
 * simultáneas pasarían las dos por cualquier comprobación escrita en JavaScript.
 *
 * ## Multipago
 *
 * Una cita cobrada con varias formas genera **un movimiento por forma de pago**, no uno solo
 * repartido después. Así el desglose es una suma directa y no una regla de tres sobre
 * proporciones —que es como está resuelto en restaurante y obliga a `NULLIF(tot.suma, 0)` para
 * no dividir por cero—.
 */

const ESTADO_ABIERTA = 'A';
const ESTADO_CERRADA = 'C';

function errorCajaCerrada() {
    const e = new Error('No hay una caja abierta. Abre la caja para poder registrar cobros.');
    e.code = 'CAJA_CERRADA';
    e.statusCode = 409;
    return e;
}

/** Caja abierta del negocio, o `null`. Con `transaction` la bloquea para el resto del turno. */
async function getCajaAbiertaRaw(idNegocio, { transaction, bloquear = false } = {}) {
    return Models.ReservaCaja.findOne({
        where: { id_negocio: idNegocio, estado: ESTADO_ABIERTA },
        transaction,
        lock: bloquear && transaction ? transaction.LOCK.UPDATE : undefined,
    });
}

/** Exige caja abierta. Lo usan las operaciones que mueven dinero. */
async function requireCajaAbierta(idNegocio, opciones = {}) {
    const caja = await getCajaAbiertaRaw(idNegocio, { ...opciones, bloquear: true });
    if (!caja) throw errorCajaCerrada();
    return caja;
}

async function abrirCaja({ idNegocio, idUsuario, montoApertura, observaciones }) {
    const monto = Number(montoApertura);
    if (!Number.isFinite(monto) || monto < 0) {
        const e = new Error('El monto de apertura no puede ser negativo.');
        e.statusCode = 422; throw e;
    }

    const existente = await getCajaAbiertaRaw(idNegocio);
    if (existente) {
        const e = new Error('Ya hay una caja abierta para este negocio.');
        e.code = 'CAJA_YA_ABIERTA';
        e.statusCode = 409;
        throw e;
    }

    try {
        return await Models.ReservaCaja.create({
            id_negocio: idNegocio,
            id_usuario: idUsuario,
            monto_apertura: monto,
            observaciones: observaciones?.trim() || null,
            estado: ESTADO_ABIERTA,
        });
    } catch (err) {
        // El índice único parcial es la autoridad: si dos peticiones llegan a la vez, una gana
        // y la otra cae aquí. Se traduce al mismo error de dominio que la comprobación previa.
        if (err?.original?.code === '23505') {
            const e = new Error('Ya hay una caja abierta para este negocio.');
            e.code = 'CAJA_YA_ABIERTA'; e.statusCode = 409; throw e;
        }
        throw err;
    }
}

/**
 * Cierra el turno.
 *
 * `monto_cierre` es lo que **debería** haber (apertura + ingresos − egresos) y `monto_reportado`
 * lo que el cajero contó de verdad. La diferencia se guarda y no bloquea el cierre: un descuadre
 * es información, y negarse a cerrar solo consigue que nadie cierre la caja.
 */
async function cerrarCaja({ idCaja, idNegocio, montoReportado, observaciones }) {
    return Models.sequelize.transaction(async (t) => {
        const caja = await Models.ReservaCaja.findOne({
            where: { id_caja: idCaja, id_negocio: idNegocio, estado: ESTADO_ABIERTA },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!caja) return null;

        const totales = await getTotales(caja.id_caja, { transaction: t });
        const esperado = Number(caja.monto_apertura) + totales.ingresos - totales.egresos;
        const reportado = montoReportado != null && Number.isFinite(Number(montoReportado))
            ? Number(montoReportado)
            : null;

        return caja.update({
            monto_cierre: esperado,
            monto_reportado: reportado,
            diferencia: reportado != null ? reportado - esperado : null,
            fecha_cierre: new Date(),
            estado: ESTADO_CERRADA,
            observaciones: observaciones?.trim()
                ? (caja.observaciones ? `${caja.observaciones}\n[CIERRE] ${observaciones.trim()}` : observaciones.trim())
                : caja.observaciones,
        }, { transaction: t });
    });
}

async function getTotales(idCaja, { transaction } = {}) {
    const [row] = await Models.sequelize.query(`
        SELECT COALESCE(SUM(monto) FILTER (WHERE tipo = 'INGRESO'), 0) AS ingresos,
               COALESCE(SUM(monto) FILTER (WHERE tipo = 'EGRESO'), 0)  AS egresos,
               COUNT(*)                                                AS movimientos
        FROM reserva.reserva_movimiento_caja
        WHERE id_caja = :idCaja
    `, { replacements: { idCaja }, type: Models.sequelize.QueryTypes.SELECT, transaction });

    return {
        ingresos: Number(row?.ingresos ?? 0),
        egresos: Number(row?.egresos ?? 0),
        movimientos: Number(row?.movimientos ?? 0),
    };
}

/** Ingresos del turno agrupados por forma de pago. Los manuales caen en «Sin forma de pago». */
async function getDesglosePorMetodo(idCaja) {
    const filas = await Models.sequelize.query(`
        SELECT m.id_metodo_pago,
               COALESCE(mp.nombre, 'Sin forma de pago') AS nombre,
               SUM(m.monto)                             AS total,
               COUNT(*)                                 AS movimientos
        FROM reserva.reserva_movimiento_caja m
        LEFT JOIN reserva.reserva_metodo_pago mp ON mp.id_metodo_pago = m.id_metodo_pago
        WHERE m.id_caja = :idCaja AND m.tipo = 'INGRESO'
        GROUP BY m.id_metodo_pago, mp.nombre
        ORDER BY total DESC
    `, { replacements: { idCaja }, type: Models.sequelize.QueryTypes.SELECT });

    return filas.map(f => ({
        id_metodo_pago: f.id_metodo_pago ?? null,
        nombre: f.nombre,
        total: Number(f.total ?? 0),
        movimientos: Number(f.movimientos ?? 0),
    }));
}

/**
 * Lo recaudado por cada profesional en el turno, para liquidar al cerrar.
 *
 * Solo aparecen los que **efectivamente prestaron un servicio** en esta caja: listar a los seis
 * del equipo con cero al lado convierte la liquidación en una búsqueda. Se desglosa además por
 * forma de pago, porque no es lo mismo entregarle el efectivo que tiene en la mano que
 * reconocerle una transferencia que ya entró a la cuenta del negocio.
 */
async function getResumenPorProfesional(idCaja) {
    const filas = await Models.sequelize.query(`
        SELECT p.id_profesional,
               p.nombre,
               p.color_hex,
               p.especialidad,
               SUM(m.monto)                                    AS total,
               COUNT(DISTINCT m.id_cita)                       AS citas,
               COALESCE(SUM(m.monto) FILTER (WHERE mp.nombre ILIKE 'efectivo'), 0) AS efectivo,
               COALESCE(SUM(m.monto) FILTER (WHERE mp.nombre NOT ILIKE 'efectivo' OR mp.nombre IS NULL), 0) AS otros
        FROM reserva.reserva_movimiento_caja m
        JOIN reserva.reserva_profesional p ON p.id_profesional = m.id_profesional
        LEFT JOIN reserva.reserva_metodo_pago mp ON mp.id_metodo_pago = m.id_metodo_pago
        WHERE m.id_caja = :idCaja
          AND m.tipo = 'INGRESO'
          AND m.id_profesional IS NOT NULL
        GROUP BY p.id_profesional, p.nombre, p.color_hex, p.especialidad
        ORDER BY total DESC, p.nombre ASC
    `, { replacements: { idCaja }, type: Models.sequelize.QueryTypes.SELECT });

    return filas.map(f => ({
        id_profesional: Number(f.id_profesional),
        nombre: f.nombre,
        color_hex: f.color_hex,
        especialidad: f.especialidad,
        total: Number(f.total ?? 0),
        citas: Number(f.citas ?? 0),
        efectivo: Number(f.efectivo ?? 0),
        otros: Number(f.otros ?? 0),
    }));
}

/** Movimientos del turno, del más reciente al más antiguo. */
async function getMovimientos(idCaja) {
    return Models.ReservaMovimientoCaja.findAll({
        where: { id_caja: idCaja },
        include: [
            { model: Models.ReservaProfesional, as: 'profesional', attributes: ['id_profesional', 'nombre', 'color_hex'] },
            { model: Models.ReservaMetodoPago,  as: 'metodoPago',  attributes: ['id_metodo_pago', 'nombre'] },
            { model: Models.GenerUsuario,       as: 'usuario',     attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'] },
            { model: Models.ReservaCita,        as: 'cita',        attributes: ['id_cita', 'cliente_nombre'] },
        ],
        order: [['fecha', 'DESC'], ['id_movimiento', 'DESC']],
    });
}

/** Estado completo de la caja abierta: cabecera, totales y los dos desgloses. */
async function getEstadoCaja(idNegocio) {
    const caja = await Models.ReservaCaja.findOne({
        where: { id_negocio: idNegocio, estado: ESTADO_ABIERTA },
        include: [{
            model: Models.GenerUsuario, as: 'usuario',
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
        }],
    });
    if (!caja) return { abierta: false, caja: null };

    const cfg = await Models.ReservaConfig.findByPk(idNegocio);
    const [totales, porMetodo, porProfesional, movimientos] = await Promise.all([
        getTotales(caja.id_caja),
        getDesglosePorMetodo(caja.id_caja),
        getResumenPorProfesional(caja.id_caja),
        getMovimientos(caja.id_caja),
    ]);

    const apertura = Number(caja.monto_apertura);
    return {
        abierta: true,
        caja: {
            id_caja: caja.id_caja,
            monto_apertura: apertura,
            fecha_apertura: caja.fecha_apertura,
            observaciones: caja.observaciones,
            usuario: caja.usuario
                ? { id_usuario: caja.usuario.id_usuario, nombre: `${caja.usuario.primer_nombre} ${caja.usuario.primer_apellido}` }
                : null,
        },
        totales: {
            ...totales,
            apertura,
            esperado: apertura + totales.ingresos - totales.egresos,
        },
        // El desglose por profesional solo tiene sentido si el negocio liquida por persona; se
        // manda igualmente el flag para que la vista no tenga que pedir la config aparte.
        permite_cobro_profesional: !!cfg?.permite_cobro_profesional,
        por_metodo: porMetodo,
        por_profesional: porProfesional,
        movimientos,
    };
}

/** Turnos ya cerrados, para consultar el histórico. */
async function getHistorial(idNegocio, { limite = 30 } = {}) {
    const cajas = await Models.ReservaCaja.findAll({
        where: { id_negocio: idNegocio, estado: ESTADO_CERRADA },
        include: [{
            model: Models.GenerUsuario, as: 'usuario',
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
        }],
        order: [['fecha_apertura', 'DESC']],
        limit: Math.min(Number(limite) || 30, 100),
    });

    return Promise.all(cajas.map(async (c) => {
        const totales = await getTotales(c.id_caja);
        return {
            id_caja: c.id_caja,
            monto_apertura: Number(c.monto_apertura),
            monto_cierre: c.monto_cierre != null ? Number(c.monto_cierre) : null,
            monto_reportado: c.monto_reportado != null ? Number(c.monto_reportado) : null,
            diferencia: c.diferencia != null ? Number(c.diferencia) : null,
            fecha_apertura: c.fecha_apertura,
            fecha_cierre: c.fecha_cierre,
            observaciones: c.observaciones,
            usuario: c.usuario ? `${c.usuario.primer_nombre} ${c.usuario.primer_apellido}` : null,
            ...totales,
        };
    }));
}

/** Detalle de una caja concreta, abierta o cerrada. */
async function getDetalleCaja({ idCaja, idNegocio }) {
    const caja = await Models.ReservaCaja.findOne({
        where: { id_caja: idCaja, id_negocio: idNegocio },
        include: [{
            model: Models.GenerUsuario, as: 'usuario',
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
        }],
    });
    if (!caja) return null;

    const [totales, porMetodo, porProfesional, movimientos] = await Promise.all([
        getTotales(caja.id_caja),
        getDesglosePorMetodo(caja.id_caja),
        getResumenPorProfesional(caja.id_caja),
        getMovimientos(caja.id_caja),
    ]);
    const apertura = Number(caja.monto_apertura);

    return {
        caja: {
            id_caja: caja.id_caja,
            estado: caja.estado,
            monto_apertura: apertura,
            monto_cierre: caja.monto_cierre != null ? Number(caja.monto_cierre) : null,
            monto_reportado: caja.monto_reportado != null ? Number(caja.monto_reportado) : null,
            diferencia: caja.diferencia != null ? Number(caja.diferencia) : null,
            fecha_apertura: caja.fecha_apertura,
            fecha_cierre: caja.fecha_cierre,
            observaciones: caja.observaciones,
            usuario: caja.usuario ? `${caja.usuario.primer_nombre} ${caja.usuario.primer_apellido}` : null,
        },
        totales: { ...totales, apertura, esperado: apertura + totales.ingresos - totales.egresos },
        por_metodo: porMetodo,
        por_profesional: porProfesional,
        movimientos,
    };
}

/** Movimiento suelto (ingreso extra o gasto del día). Valida y escribe. */
async function registrarMovimiento({
    idCaja, tipo, monto, concepto, idUsuario,
    idCita = null, idProfesional = null, idMetodoPago = null, transaction,
}) {
    if (!['INGRESO', 'EGRESO'].includes(tipo)) {
        const e = new Error('El tipo debe ser INGRESO o EGRESO.'); e.statusCode = 422; throw e;
    }
    const valor = Number(monto);
    if (!Number.isFinite(valor) || valor <= 0) {
        const e = new Error('El monto debe ser mayor que cero.'); e.statusCode = 422; throw e;
    }
    return Models.ReservaMovimientoCaja.create({
        id_caja: idCaja,
        tipo,
        monto: valor,
        concepto: concepto?.trim() || null,
        id_cita: idCita,
        id_profesional: idProfesional,
        id_metodo_pago: idMetodoPago,
        id_usuario: idUsuario,
    }, { transaction });
}

/** Movimiento manual pedido desde la vista de caja: exige que el turno esté abierto. */
async function registrarMovimientoManual({ idNegocio, tipo, monto, concepto, idUsuario, idMetodoPago }) {
    return Models.sequelize.transaction(async (t) => {
        const caja = await requireCajaAbierta(idNegocio, { transaction: t });
        if (idMetodoPago) {
            const metodo = await Models.ReservaMetodoPago.findOne({
                where: { id_metodo_pago: idMetodoPago, id_negocio: idNegocio, estado: 'A' },
                transaction: t,
            });
            if (!metodo) {
                const e = new Error('Forma de pago no válida.'); e.statusCode = 400; throw e;
            }
        }
        return registrarMovimiento({
            idCaja: caja.id_caja, tipo, monto, concepto, idUsuario,
            idMetodoPago: idMetodoPago ?? null, transaction: t,
        });
    });
}

/**
 * Registra el cobro de una cita: un movimiento por forma de pago.
 *
 * La llama `citaService.completar` **dentro de su transacción**, para que cobrar y completar
 * sean la misma operación: si el movimiento falla, la cita no queda completada y sin dinero.
 */
async function registrarCobroCita({ idNegocio, cita, pagos, idUsuario, transaction }) {
    const caja = await requireCajaAbierta(idNegocio, { transaction });

    for (const p of pagos) {
        await registrarMovimiento({
            idCaja: caja.id_caja,
            tipo: 'INGRESO',
            monto: p.valor,
            concepto: `Cita #${cita.id_cita} · ${cita.cliente_nombre}`,
            idUsuario,
            idCita: cita.id_cita,
            idProfesional: cita.id_profesional,
            idMetodoPago: p.id_metodo_pago,
            transaction,
        });
    }
    return caja;
}

/**
 * Citas completadas hoy que no llegaron a ninguna caja.
 *
 * Es la advertencia previa al cierre: dinero que se cobró con la caja cerrada y que, por tanto,
 * no está en ningún turno. No bloquea el cierre —el turno hay que poder cerrarlo—, pero se dice.
 */
async function getCitasSinCaja(idNegocio) {
    const hoy = Reglas.inicioDelDia(Reglas.fechaISOLocal(new Date()));
    const manana = Reglas.addMinutes(hoy, 24 * 60);

    const citas = await Models.ReservaCita.findAll({
        where: {
            id_negocio: idNegocio,
            estado: 'completada',
            id_caja: null,
            fecha_hora_inicio: { [Op.gte]: hoy, [Op.lt]: manana },
        },
        attributes: ['id_cita', 'cliente_nombre', 'monto_total', 'fecha_hora_inicio'],
        order: [['fecha_hora_inicio', 'ASC']],
    });

    return citas.map(c => ({
        id_cita: c.id_cita,
        cliente_nombre: c.cliente_nombre,
        monto_total: Number(c.monto_total ?? 0),
        fecha_hora_inicio: c.fecha_hora_inicio,
    }));
}

module.exports = {
    requireCajaAbierta,
    getCajaAbiertaRaw,
    abrirCaja,
    cerrarCaja,
    getEstadoCaja,
    getDetalleCaja,
    getHistorial,
    getMovimientos,
    getTotales,
    getDesglosePorMetodo,
    getResumenPorProfesional,
    registrarMovimiento,
    registrarMovimientoManual,
    registrarCobroCita,
    getCitasSinCaja,
};
