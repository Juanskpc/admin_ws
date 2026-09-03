'use strict';
const { Op } = require('sequelize');
const Models = require('../../app_core/models/conection');
const { usuarioTieneSubnivel } = require('../../app_core/helpers/permisoSubnivel');

const SUBNIVEL_ANULAR_PEDIDO = 'caja_eliminar_pedido';

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
    // El dinero de cada ingreso se atribuye por forma de pago:
    //  - Órdenes con Multipago (filas en rest_pago_orden): se reparte el monto
    //    del ingreso proporcionalmente al valor de cada forma de pago.
    //  - Órdenes con pago simple o movimientos manuales: el monto completo va
    //    al id_metodo_pago de la orden (o "Manual / Sin orden").
    const rows = await Models.sequelize.query(`
        WITH ingresos AS (
            SELECT m.id_orden, m.monto
            FROM restaurante.rest_movimiento_caja m
            WHERE m.id_caja = :idCaja AND m.tipo = 'INGRESO'
              -- Un ingreso anulado ya no es plata en el cajón: se excluye del
              -- desglose para que el cuadre por forma de pago sea el real.
              AND NOT EXISTS (
                  SELECT 1 FROM restaurante.rest_movimiento_caja a
                  WHERE a.id_movimiento_anula = m.id_movimiento
              )
              -- Y las filas compensatorias tampoco son una venta: son la reversa.
              AND m.id_movimiento_anula IS NULL
        ),
        multipago AS (
            SELECT pp.id_metodo_pago,
                   SUM(i.monto * (pp.valor / NULLIF(tot.suma, 0))) AS total
            FROM ingresos i
            JOIN restaurante.rest_pago_orden pp ON pp.id_orden = i.id_orden
            JOIN (
                SELECT id_orden, SUM(valor) AS suma
                FROM restaurante.rest_pago_orden
                GROUP BY id_orden
            ) tot ON tot.id_orden = i.id_orden
            GROUP BY pp.id_metodo_pago
        ),
        simple AS (
            SELECT po.id_metodo_pago, SUM(i.monto) AS total
            FROM ingresos i
            LEFT JOIN restaurante.pedid_orden po ON po.id_orden = i.id_orden
            WHERE NOT EXISTS (
                SELECT 1 FROM restaurante.rest_pago_orden pp WHERE pp.id_orden = i.id_orden
            )
            GROUP BY po.id_metodo_pago
        ),
        combinado AS (
            SELECT id_metodo_pago, total FROM multipago
            UNION ALL
            SELECT id_metodo_pago, total FROM simple
        )
        SELECT c.id_metodo_pago,
               COALESCE(mp.nombre, 'Manual / Sin orden') AS nombre,
               SUM(c.total)                              AS total
        FROM combinado c
        LEFT JOIN restaurante.rest_metodo_pago mp ON mp.id_metodo_pago = c.id_metodo_pago
        GROUP BY c.id_metodo_pago, mp.nombre
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
    // Obtener fecha_apertura directamente de BD como string para evitar conversiones de timezone
    const cajaRow = await Models.sequelize.query(`
        SELECT id_caja, fecha_apertura::text AS fecha_apertura
        FROM restaurante.rest_caja
        WHERE id_negocio = :idNegocio AND estado = 'A'
        LIMIT 1
    `, {
        replacements: { idNegocio },
        type: Models.sequelize.QueryTypes.SELECT,
    });

    if (!cajaRow || cajaRow.length === 0) {
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

    const caja = cajaRow[0];
    console.log('consulta caja domicilarios ----->', {
        id_caja: caja.id_caja,
        fecha_apertura: caja.fecha_apertura,
    });

    // Usar la fecha como string para comparación sin conversiones de timezone
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
          AND COALESCE(o.fecha_cierre, o.fecha_creacion)::timestamp >= :fechaApertura::timestamp
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
        // Obtener caja y fecha_apertura como string sin conversión de timezone
        const cajaRow = await Models.sequelize.query(`
            SELECT id_caja, fecha_apertura::text AS fecha_apertura
            FROM restaurante.rest_caja
            WHERE id_negocio = :idNegocio AND estado = 'A'
            LIMIT 1
        `, {
            replacements: { idNegocio },
            type: Models.sequelize.QueryTypes.SELECT,
            transaction: t,
        });

        if (!cajaRow || cajaRow.length === 0) {
            throw buildCajaCerradaError();
        }

        const cajaInfo = cajaRow[0];
        const fechaApertura = cajaInfo.fecha_apertura;

        // Obtener las órdenes usando una query SQL para mantener la fecha como string
        const ordenes = await Models.sequelize.query(`
            SELECT 
                id_orden, 
                numero_orden, 
                total,
                valor_domicilio
            FROM restaurante.pedid_orden
            WHERE id_negocio = :idNegocio
              AND tipo_pedido = 'DOMICILIO'
              AND id_domiciliario = :idDomiciliario
              AND estado_pago = 'pagado'
              AND id_caja IS NULL
              AND COALESCE(fecha_cierre, fecha_creacion)::timestamp >= :fechaApertura::timestamp
            ORDER BY fecha_creacion ASC, id_orden ASC
        `, {
            replacements: { idNegocio, idDomiciliario, fechaApertura },
            type: Models.sequelize.QueryTypes.SELECT,
            transaction: t,
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
                valorDomicilio: Number(orden.valor_domicilio || 0),
                transaction: t,
            });
            totalMonto += Number(orden.total || 0);
            
            // Actualizar id_caja de la orden
            await Models.sequelize.query(`
                UPDATE restaurante.pedid_orden
                SET id_caja = :idCaja
                WHERE id_orden = :idOrden
            `, {
                replacements: { idCaja: cajaInfo.id_caja, idOrden: orden.id_orden },
                type: Models.sequelize.QueryTypes.UPDATE,
                transaction: t,
            });
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
    const movimientos = await Models.RestMovimientoCaja.findAll({
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
                attributes: ['id_orden', 'numero_orden', 'tipo_pedido', 'estado'],
                required: false,
            },
        ],
        order: [['fecha', 'DESC']],
    });

    // Marcas para el listado: el original anulado sigue ahí (no se oculta nada) y
    // la fila compensatoria se distingue para pintarla como alerta.
    const anulados = new Set(
        movimientos
            .map((m) => m.id_movimiento_anula)
            .filter((id) => id != null)
            .map(Number)
    );

    return movimientos.map((m) => {
        const json = m.toJSON();
        json.es_anulacion = m.id_movimiento_anula != null;
        json.anulado = anulados.has(Number(m.id_movimiento));
        // El único egreso que se ata a una orden es el pago al domiciliario
        // (las reversas llevan id_movimiento_anula). Sirve para etiquetar la fila
        // como "Domicilio" aunque el pedido sea Para llevar.
        json.es_pago_domicilio = m.tipo === 'EGRESO'
            && m.id_orden != null
            && m.id_movimiento_anula == null;
        return json;
    });
}

async function registrarMovimiento({ idCaja, tipo, monto, concepto, idUsuario, idOrden, idMovimientoAnula = null, transaction }) {
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
        id_movimiento_anula: idMovimientoAnula || null,
    }, { transaction });
}

/**
 * Variante segura para registrar el INGRESO automático del cobro:
 * verifica que la caja siga abierta dentro de la transacción.
 *
 * Si la orden trae `valor_domicilio` (funcionalidad opt-in por negocio), registra
 * además el EGRESO por el pago al domiciliario. El cliente pagó el domicilio dentro
 * del total, así que ingreso y egreso se anulan y en caja solo queda la venta.
 *
 * Los dos movimientos van en la MISMA transacción que el cobro: o quedan ambos, o
 * no queda ninguno. Y como este es el único punto donde una orden entra a caja
 * (cobro en despacho, cierre de orden y transferencia del domiciliario pasan todos
 * por aquí), el egreso no se puede duplicar ni quedar huérfano.
 */
async function registrarIngresoOrden({ idNegocio, idOrden, idUsuario, monto, numeroOrden, valorDomicilio = 0, transaction }) {
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

    const domicilio = Number(valorDomicilio ?? 0);
    if (domicilio > 0) {
        await registrarMovimiento({
            idCaja: caja.id_caja,
            tipo: 'EGRESO',
            monto: domicilio,
            concepto: `Pago domicilio orden ${numeroOrden}`,
            idUsuario,
            idOrden,
            transaction,
        });
    }

    return caja;
}

/**
 * Anula un pedido ya cobrado desde Caja.
 *
 * NO borra nada. Por cada movimiento que el pedido dejó en la caja abierta crea
 * uno compensatorio de signo contrario (`id_movimiento_anula` apunta al original):
 *
 *   INGRESO  Orden ORD-0029            +36.000
 *   EGRESO   Pago domicilio ORD-0029    -4.000
 *   EGRESO   Anulación ORD-0029        -36.000   ← nuevo
 *   INGRESO  Anulación ORD-0029         +4.000   ← nuevo
 *                                       ────────
 *                                          0
 *
 * Así el original queda visible en el listado, el neto de caja vuelve a cero y el
 * `id_usuario` del compensatorio deja constancia de quién anuló. La orden pasa a
 * estado ANULADA, que los reportes (que filtran por CERRADA) ya excluyen solos.
 *
 * Solo se permite sobre la caja ABIERTA: reversar contra un turno ya cerrado
 * movería plata de un día a otro y descuadraría el arqueo de ambos.
 */
async function anularOrdenCobrada({ idNegocio, idOrden, idUsuario }) {
    const permitido = await usuarioTieneSubnivel({
        idUsuario,
        idNegocio,
        codigo: SUBNIVEL_ANULAR_PEDIDO,
        // Ni siquiera el administrador lo hereda: se concede uno por uno.
        adminSiempre: false,
    });
    if (!permitido) {
        const e = new Error('No tienes permiso para eliminar pedidos cobrados.');
        e.code = 'SIN_PERMISO_ANULAR'; e.statusCode = 403;
        throw e;
    }

    const t = await Models.sequelize.transaction();
    try {
        const caja = await requireCajaAbierta(idNegocio, { transaction: t });

        const orden = await Models.PedidOrden.findOne({
            where: { id_orden: idOrden, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!orden) {
            const e = new Error('Pedido no encontrado.');
            e.code = 'ORDEN_NO_ENCONTRADA'; e.statusCode = 404;
            throw e;
        }
        if (orden.estado === 'ANULADA') {
            const e = new Error('Este pedido ya fue eliminado.');
            e.code = 'ORDEN_YA_ANULADA'; e.statusCode = 409;
            throw e;
        }

        const candidatos = await Models.RestMovimientoCaja.findAll({
            where: { id_caja: caja.id_caja, id_orden: idOrden, id_movimiento_anula: null },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });

        if (candidatos.length === 0) {
            const e = new Error('El pedido no tiene movimientos en la caja abierta. Solo se pueden eliminar pedidos cobrados en este turno.');
            e.code = 'SIN_MOVIMIENTOS_EN_CAJA'; e.statusCode = 409;
            throw e;
        }

        // Se saltan los que ya tienen reversa: un egreso del pedido pudo anularse
        // por su cuenta antes, y eso no debe impedir anular el resto.
        const yaReversados = await Models.RestMovimientoCaja.findAll({
            where: { id_movimiento_anula: candidatos.map((m) => m.id_movimiento) },
            attributes: ['id_movimiento_anula'],
            transaction: t,
        });
        const reversados = new Set(yaReversados.map((m) => Number(m.id_movimiento_anula)));
        const movimientos = candidatos.filter((m) => !reversados.has(Number(m.id_movimiento)));

        if (movimientos.length === 0) {
            const e = new Error('Este pedido ya fue eliminado.');
            e.code = 'ORDEN_YA_ANULADA'; e.statusCode = 409;
            throw e;
        }

        const numeroOrden = orden.numero_orden || `#${orden.id_orden}`;
        let montoRevertido = 0;

        for (const mov of movimientos) {
            await registrarMovimiento({
                idCaja: caja.id_caja,
                tipo: mov.tipo === 'INGRESO' ? 'EGRESO' : 'INGRESO',
                monto: mov.monto,
                concepto: `Anulación ${numeroOrden}`,
                idUsuario,
                idOrden,
                idMovimientoAnula: mov.id_movimiento,
                transaction: t,
            });
            montoRevertido += mov.tipo === 'INGRESO' ? Number(mov.monto) : -Number(mov.monto);
        }

        await orden.update({ estado: 'ANULADA' }, { transaction: t });

        await t.commit();
        return {
            id_orden: idOrden,
            numero_orden: numeroOrden,
            movimientos_revertidos: movimientos.length,
            monto_revertido: montoRevertido,
        };
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

/**
 * Anula UN movimiento suelto de la caja abierta (típicamente un egreso: el pago
 * al domiciliario o un retiro manual). Mismo principio que `anularOrdenCobrada`:
 * no borra, registra la reversa y deja el original marcado como eliminado.
 *
 * Un INGRESO atado a una orden NO entra por aquí: reversarlo solo dejaría
 * huérfano el egreso del domicilio de esa misma orden. Ese caso va por
 * `anularOrdenCobrada`, que reversa el pedido completo.
 */
async function anularMovimientoCaja({ idNegocio, idMovimiento, idUsuario }) {
    const permitido = await usuarioTieneSubnivel({
        idUsuario,
        idNegocio,
        codigo: SUBNIVEL_ANULAR_PEDIDO,
        adminSiempre: false,
    });
    if (!permitido) {
        const e = new Error('No tienes permiso para eliminar movimientos de caja.');
        e.code = 'SIN_PERMISO_ANULAR'; e.statusCode = 403;
        throw e;
    }

    const t = await Models.sequelize.transaction();
    try {
        const caja = await requireCajaAbierta(idNegocio, { transaction: t });

        const mov = await Models.RestMovimientoCaja.findOne({
            where: { id_movimiento: idMovimiento, id_caja: caja.id_caja },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!mov) {
            const e = new Error('El movimiento no existe en la caja abierta.');
            e.code = 'MOVIMIENTO_NO_ENCONTRADO'; e.statusCode = 404;
            throw e;
        }
        if (mov.id_movimiento_anula != null) {
            const e = new Error('No se puede eliminar una reversa.');
            e.code = 'MOVIMIENTO_ES_REVERSA'; e.statusCode = 409;
            throw e;
        }
        if (mov.tipo === 'INGRESO' && mov.id_orden != null) {
            const e = new Error('Para eliminar el cobro de un pedido usa la fila del pedido, no la del egreso.');
            e.code = 'USAR_ANULAR_PEDIDO'; e.statusCode = 409;
            throw e;
        }

        const yaReversado = await Models.RestMovimientoCaja.count({
            where: { id_movimiento_anula: mov.id_movimiento },
            transaction: t,
        });
        if (yaReversado > 0) {
            const e = new Error('Este movimiento ya fue eliminado.');
            e.code = 'MOVIMIENTO_YA_ANULADO'; e.statusCode = 409;
            throw e;
        }

        const referencia = mov.concepto || `movimiento #${mov.id_movimiento}`;
        await registrarMovimiento({
            idCaja: caja.id_caja,
            tipo: mov.tipo === 'INGRESO' ? 'EGRESO' : 'INGRESO',
            monto: mov.monto,
            concepto: `Anulación ${referencia}`,
            idUsuario,
            idOrden: mov.id_orden || null,
            idMovimientoAnula: mov.id_movimiento,
            transaction: t,
        });

        await t.commit();
        return {
            id_movimiento: mov.id_movimiento,
            tipo: mov.tipo,
            concepto: mov.concepto,
            monto: Number(mov.monto),
        };
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

module.exports = {
    requireCajaAbierta,
    anularOrdenCobrada,
    anularMovimientoCaja,
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
