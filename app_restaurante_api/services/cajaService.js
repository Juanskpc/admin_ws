'use strict';
const { Op } = require('sequelize');
const Models = require('../../app_core/models/conection');
const { usuarioTieneSubnivel } = require('../../app_core/helpers/permisoSubnivel');
const { avisar, TEMAS } = require('./avisoService');

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

/**
 * Ingresos y egresos del turno con las anulaciones ya descontadas.
 *
 * Una anulación son DOS filas: el original, que se queda para que el turno conserve su
 * historia, y la compensatoria de signo contrario. Sumarlas a ciegas dejaba el neto bien
 * pero inflaba las dos columnas: anular un egreso de 20.000 subía «Egresos» a 20.000 y
 * «Ingresos» otros 20.000, cuando de esa plata nunca salió ni entró nada. El cajero veía
 * un egreso que él mismo había cancelado sumando en el total de egresos.
 *
 * Así que del par no se cuenta ninguna de las dos: ni el original ni su reversa. El neto
 * (`apertura + ingresos - egresos`) no cambia, porque las dos filas ya se anulaban entre
 * sí; lo que cambia es que cada columna dice la verdad por separado.
 *
 * Requiere `id_movimiento`, `id_movimiento_anula`, `tipo` y `monto` en cada fila.
 */
function totalesDeMovimientos(movimientos) {
    const reversados = new Set(
        (movimientos || [])
            .map((m) => m.id_movimiento_anula)
            .filter((id) => id != null)
            .map(Number),
    );
    const vivos = (movimientos || []).filter(
        (m) => m.id_movimiento_anula == null && !reversados.has(Number(m.id_movimiento)),
    );
    const sumar = (tipo) => vivos
        .filter((m) => m.tipo === tipo)
        .reduce((suma, m) => suma + Number(m.monto), 0);

    return { ingresos: sumar('INGRESO'), egresos: sumar('EGRESO') };
}

/** Columnas mínimas para que `totalesDeMovimientos` pueda descartar las anulaciones. */
const COLUMNAS_TOTALES = ['id_movimiento', 'id_movimiento_anula', 'tipo', 'monto'];

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
    const caja = await Models.RestCaja.create({
        id_negocio: idNegocio,
        id_usuario: idUsuario,
        monto_apertura: montoApertura,
        observaciones: observaciones || null,
        estado: 'A',
    });

    // Abrir el turno desbloquea el POS de TODOS los equipos del negocio. Es justo el caso que
    // obligaba a recargar: uno abre la caja en el computador y los demás seguían bloqueados.
    avisar(idNegocio, TEMAS.CAJA, TEMAS.PEDIDOS);
    return caja;
}

/**
 * Retorna el dinero NETO del turno agrupado por forma de pago.
 *
 * Neto quiere decir que los egresos restan de la forma de pago con la que salieron,
 * igual que los ingresos suman: si el cliente pagó 36.000 en efectivo y de ese
 * efectivo salieron 4.000 para el domiciliario, en «Efectivo» quedan 32.000, que es
 * lo que de verdad hay en el cajón. Sumar solo los ingresos hacía que el desglose no
 * cuadrara nunca con el esperado en cuanto había un egreso.
 *
 * Los movimientos sin orden ni forma de pago se listan como "Manual / Sin orden".
 */
async function getDesglosePorMetodo(idCaja) {
    // El dinero de cada movimiento se atribuye por forma de pago:
    //  - Órdenes con Multipago (filas en rest_pago_orden): se reparte el monto
    //    proporcionalmente al valor de cada forma de pago.
    //  - Órdenes con pago simple o movimientos manuales: el monto completo va
    //    al id_metodo_pago de la orden (o "Manual / Sin orden").
    const rows = await Models.sequelize.query(`
        WITH ingresos AS (
            -- La forma de pago viaja en el propio movimiento solo cuando NO hay pedido detrás
            -- (un abono a la cuenta de un cliente o un egreso manual). Con pedido manda la orden.
            -- El signo lo pone el tipo: un EGRESO entra al desglose en negativo.
            SELECT m.id_orden,
                   CASE WHEN m.tipo = 'EGRESO' THEN -m.monto ELSE m.monto END AS monto,
                   m.id_metodo_pago AS metodo_directo
            FROM restaurante.rest_movimiento_caja m
            WHERE m.id_caja = :idCaja AND m.tipo IN ('INGRESO', 'EGRESO')
              -- Un movimiento anulado ya no es plata que se movió: se excluye del
              -- desglose para que el cuadre por forma de pago sea el real.
              AND NOT EXISTS (
                  SELECT 1 FROM restaurante.rest_movimiento_caja a
                  WHERE a.id_movimiento_anula = m.id_movimiento
              )
              -- Y las filas compensatorias tampoco son un movimiento real: son la reversa.
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
            SELECT COALESCE(po.id_metodo_pago, i.metodo_directo) AS id_metodo_pago,
                   SUM(i.monto) AS total
            FROM ingresos i
            LEFT JOIN restaurante.pedid_orden po ON po.id_orden = i.id_orden
            WHERE NOT EXISTS (
                SELECT 1 FROM restaurante.rest_pago_orden pp WHERE pp.id_orden = i.id_orden
            )
            GROUP BY COALESCE(po.id_metodo_pago, i.metodo_directo)
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
        avisar(idNegocio, TEMAS.CAJA, TEMAS.PEDIDOS);
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

    const { ingresos, egresos } = totalesDeMovimientos(caja.movimientos);

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
    avisar(idNegocio, TEMAS.CAJA, TEMAS.PEDIDOS);
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
                attributes: COLUMNAS_TOTALES,
            },
        ],
    });
    if (!caja) return null;

    const { ingresos, egresos } = totalesDeMovimientos(caja.movimientos);

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

/**
 * Negocio dueño de un turno de caja.
 *
 * Las rutas de movimientos solo reciben el id de la caja, pero los permisos se
 * evalúan siempre dentro de un negocio; esto cierra ese hueco sin cambiar la API.
 */
async function getIdNegocioDeCaja(idCaja) {
    const caja = await Models.RestCaja.findByPk(idCaja, { attributes: ['id_negocio'] });
    return caja ? Number(caja.id_negocio) : null;
}

/**
 * ¿El usuario opera en este negocio?
 *
 * El historial deja pedir cajas por id, así que hace falta comprobar la pertenencia
 * antes de devolver nada: sin esto, iterar ids expondría los turnos de otro
 * inquilino. Un rol global (id_negocio NULL, como Super Admin) pasa siempre.
 */
async function usuarioPerteneceANegocio({ idUsuario, idNegocio }) {
    if (!idUsuario || !idNegocio) return false;

    const vinculo = await Models.GenerUsuarioRol.findOne({
        where: {
            id_usuario: idUsuario,
            estado: 'A',
            [Op.or]: [{ id_negocio: idNegocio }, { id_negocio: null }],
        },
        attributes: ['id_usuario_rol'],
    });

    return Boolean(vinculo);
}

/** Ingresos, egresos, esperado y desglose por forma de pago de un turno cualquiera. */
async function calcularTotalesCaja(caja) {
    const movimientos = await Models.RestMovimientoCaja.findAll({
        where: { id_caja: caja.id_caja },
        attributes: COLUMNAS_TOTALES,
    });

    const { ingresos, egresos } = totalesDeMovimientos(movimientos);

    const json = caja.toJSON();
    json.ingresos            = ingresos;
    json.egresos             = egresos;
    json.monto_esperado      = Number(caja.monto_apertura) + ingresos - egresos;
    json.ingresos_por_metodo = await getDesglosePorMetodo(caja.id_caja);
    delete json.movimientos;
    return json;
}

/**
 * Un turno concreto —abierto o cerrado— con sus totales.
 *
 * Va acotado por negocio a propósito: el id de caja viaja en la URL y no puede ser
 * lo único que decida qué se devuelve.
 */
async function getCajaDetalle({ idCaja, idNegocio }) {
    const caja = await Models.RestCaja.findOne({
        where: { id_caja: idCaja, id_negocio: idNegocio },
        include: [{
            model: Models.GenerUsuario,
            as: 'usuario',
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
        }],
    });
    if (!caja) return null;

    return calcularTotalesCaja(caja);
}

/**
 * Historial de turnos cerrados, del más reciente al más antiguo.
 *
 * Los totales salen de una sola consulta agregada en vez de recorrer las cajas una
 * por una: con un año de turnos, la versión ingenua son cientos de consultas.
 *
 * `desde`/`hasta` son fechas de pared de Bogotá (YYYY-MM-DD) y el rango es
 * inclusivo en ambos extremos: `hasta` se compara contra el día siguiente a las
 * 00:00, para no dejar fuera los turnos de esa misma tarde.
 */
async function listarHistorialCajas({ idNegocio, desde = null, hasta = null, limite = 20, offset = 0 }) {
    const replacements = {
        idNegocio,
        desde: desde || null,
        hasta: hasta || null,
        limite,
        offset,
    };

    const filtroFechas = `
        AND (CAST(:desde AS date) IS NULL OR c.fecha_apertura >= CAST(:desde AS date))
        AND (CAST(:hasta AS date) IS NULL OR c.fecha_apertura < CAST(:hasta AS date) + INTERVAL '1 day')
    `;

    const [filas] = await Models.sequelize.query(`
        SELECT
            c.id_caja,
            c.monto_apertura,
            c.monto_cierre,
            c.monto_reportado,
            c.diferencia,
            c.fecha_apertura,
            c.fecha_cierre,
            c.observaciones,
            c.estado,
            u.id_usuario,
            u.primer_nombre,
            u.primer_apellido,
            COALESCE(mv.ingresos, 0)          AS ingresos,
            COALESCE(mv.egresos, 0)           AS egresos,
            COALESCE(mv.total_movimientos, 0) AS total_movimientos
        FROM restaurante.rest_caja c
        JOIN general.gener_usuario u ON u.id_usuario = c.id_usuario
        LEFT JOIN (
            -- Mismo criterio que totalesDeMovimientos: del par anulado no cuenta ninguna
            -- de las dos filas, ni el original ni su reversa. total_movimientos sí las
            -- cuenta todas, porque el listado del turno las sigue mostrando.
            SELECT
                m.id_caja,
                SUM(CASE WHEN m.tipo = 'INGRESO' AND m.id_movimiento_anula IS NULL
                              AND r.id_movimiento_anula IS NULL
                         THEN m.monto ELSE 0 END) AS ingresos,
                SUM(CASE WHEN m.tipo = 'EGRESO'  AND m.id_movimiento_anula IS NULL
                              AND r.id_movimiento_anula IS NULL
                         THEN m.monto ELSE 0 END) AS egresos,
                COUNT(*) AS total_movimientos
            FROM restaurante.rest_movimiento_caja m
            LEFT JOIN (
                SELECT DISTINCT id_movimiento_anula
                FROM restaurante.rest_movimiento_caja
                WHERE id_movimiento_anula IS NOT NULL
            ) r ON r.id_movimiento_anula = m.id_movimiento
            GROUP BY m.id_caja
        ) mv ON mv.id_caja = c.id_caja
        WHERE c.id_negocio = :idNegocio
          AND c.estado = 'C'
          ${filtroFechas}
        ORDER BY c.fecha_cierre DESC NULLS LAST, c.id_caja DESC
        LIMIT :limite OFFSET :offset;
    `, { replacements });

    const [[conteo]] = await Models.sequelize.query(`
        SELECT COUNT(*)::int AS total
        FROM restaurante.rest_caja c
        WHERE c.id_negocio = :idNegocio
          AND c.estado = 'C'
          ${filtroFechas};
    `, { replacements });

    return {
        total: Number(conteo?.total ?? 0),
        rows: filas.map((f) => ({
            id_caja: Number(f.id_caja),
            fecha_apertura: f.fecha_apertura,
            fecha_cierre: f.fecha_cierre,
            estado: f.estado,
            observaciones: f.observaciones,
            usuario: {
                id_usuario: Number(f.id_usuario),
                primer_nombre: f.primer_nombre,
                primer_apellido: f.primer_apellido,
            },
            monto_apertura: Number(f.monto_apertura ?? 0),
            ingresos: Number(f.ingresos ?? 0),
            egresos: Number(f.egresos ?? 0),
            // `monto_cierre` es el esperado que se congeló al cerrar. Se prefiere al
            // recálculo para que el historial muestre lo mismo que se vio ese día.
            monto_esperado: f.monto_cierre != null ? Number(f.monto_cierre) : null,
            monto_reportado: f.monto_reportado != null ? Number(f.monto_reportado) : null,
            diferencia: f.diferencia != null ? Number(f.diferencia) : null,
            total_movimientos: Number(f.total_movimientos ?? 0),
        })),
    };
}

/**
 * Con qué se pagó (o de dónde salió) el dinero de un movimiento.
 *
 * La forma de pago vive en tres sitios distintos según el movimiento, y esto los
 * unifica en una sola lista para que la pantalla no tenga que saberlo:
 *  - pedido con multipago → una entrada por cada forma de pago del desglose;
 *  - pedido con pago simple → la forma de pago de la orden;
 *  - movimiento manual o abono → la del propio movimiento.
 *
 * Es una lista y no un valor porque un pedido cobrado en efectivo y transferencia
 * pertenece a las dos, y al filtrar por cualquiera de ellas debe aparecer.
 */
function formasPagoDeMovimiento(json) {
    const pagos = (json.orden?.pagos || []).filter((p) => p.id_metodo_pago != null);
    if (pagos.length > 0) {
        // El `valor` que se devuelve es la parte de ESTE movimiento, no la de la orden:
        // el egreso del domicilio de un pedido de 36.000 son 4.000, y copiar ahí el
        // desglose de la orden diría que ese egreso fueron 36.000. Se reparte el monto
        // del movimiento en la misma proporción que el multipago, igual que el desglose
        // del turno.
        const suma = pagos.reduce((total, p) => total + Number(p.valor ?? 0), 0);
        const monto = json.monto != null ? Number(json.monto) : null;
        return pagos.map((p) => ({
            id_metodo_pago: Number(p.id_metodo_pago),
            nombre: p.metodoPago?.nombre || 'Forma de pago',
            valor: monto != null && suma > 0
                ? Math.round(monto * (Number(p.valor ?? 0) / suma) * 100) / 100
                : null,
        }));
    }

    const directo = json.orden?.metodoPago || json.metodoPago;
    if (directo?.id_metodo_pago != null) {
        return [{
            id_metodo_pago: Number(directo.id_metodo_pago),
            nombre: directo.nombre || 'Forma de pago',
            valor: json.monto != null ? Number(json.monto) : null,
        }];
    }

    return [];
}

async function getMovimientos(idCaja) {
    // Una fábrica y no un objeto compartido: Sequelize anota la asociación dentro del
    // propio include, así que reutilizar el mismo literal en tres sitios hace que los
    // tres se resuelvan como el mismo alias («table name specified more than once»).
    const metodo = () => ({
        model: Models.RestMetodoPago,
        as: 'metodoPago',
        attributes: ['id_metodo_pago', 'nombre'],
        required: false,
    });

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
                include: [
                    metodo(),
                    {
                        model: Models.RestPagoOrden,
                        as: 'pagos',
                        attributes: ['id_pago', 'id_metodo_pago', 'valor'],
                        required: false,
                        include: [metodo()],
                    },
                ],
            },
            // La del propio movimiento: solo la llevan los manuales y los abonos.
            metodo(),
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
        // Con qué se pagó, ya resuelto: es lo que alimenta los filtros por forma de pago.
        json.formas_pago = formasPagoDeMovimiento(json);
        // Las filas anidadas ya cumplieron su función; devolverlas duplicaría la
        // respuesta y la pantalla no las usa.
        delete json.metodoPago;
        if (json.orden) {
            delete json.orden.metodoPago;
            delete json.orden.pagos;
        }
        return json;
    });
}

/**
 * La forma de pago de un movimiento manual, comprobada contra el negocio.
 *
 * Sirve para los dos sentidos: un ingreso suma a esa forma de pago y un egreso le
 * resta, así que en ambos casos tiene que ser una del negocio y estar activa. La
 * de «Cuenta / Tiquetera» queda fuera: ese dinero no está en el cajón, y meter un
 * movimiento manual ahí descuadraría la cuenta del cliente sin tocar su saldo.
 *
 * Devuelve `null` cuando no se indicó ninguna: el movimiento sin forma de pago
 * sigue siendo válido y cae en «Manual / Sin orden», como los de siempre.
 */
async function validarMetodoPagoManual({ idMetodoPago, idNegocio }) {
    if (!idMetodoPago) return null;

    const mp = await Models.RestMetodoPago.findOne({
        where: { id_metodo_pago: idMetodoPago, id_negocio: idNegocio, estado: 'A' },
    });
    if (!mp) {
        const e = new Error('Forma de pago inválida para este negocio.');
        e.code = 'METODO_PAGO_INVALIDO'; e.statusCode = 422;
        throw e;
    }
    if (mp.es_cuenta) {
        const e = new Error('La forma de pago de las cuentas de cliente no se puede usar en un movimiento manual.');
        e.code = 'METODO_PAGO_INVALIDO'; e.statusCode = 422;
        throw e;
    }
    return mp;
}

async function registrarMovimiento({
    idCaja, tipo, monto, concepto, idUsuario, idOrden,
    idMetodoPago = null,
    idMovimientoAnula = null, permitirCero = false, transaction,
}) {
    if (!['INGRESO', 'EGRESO'].includes(tipo)) {
        const err = new Error('Tipo de movimiento inválido (INGRESO o EGRESO).');
        err.statusCode = 422;
        throw err;
    }
    const importe = Number(monto);
    // El cero se permite **solo** cuando quien llama ya justificó por qué, y nunca por
    // omisión: un movimiento manual de cero pesos no significa nada y ensucia el arqueo.
    // Hoy lo justifican dos sitios, los dos en este archivo: el cobro de un pedido que un
    // descuento dejó en cero, y la reversa de ese mismo movimiento al anularlo.
    // Los negativos siguen prohibidos siempre: el signo lo pone `tipo`, no el monto.
    if (!Number.isFinite(importe) || importe < 0 || (importe === 0 && !permitirCero)) {
        const err = new Error('El monto debe ser mayor a cero.');
        err.statusCode = 422;
        throw err;
    }
    const movimiento = await Models.RestMovimientoCaja.create({
        id_caja: idCaja,
        tipo,
        monto,
        concepto: concepto || null,
        id_orden: idOrden || null,
        id_usuario: idUsuario,
        // Solo tiene sentido cuando el movimiento NO cuelga de un pedido: si hay pedido, la
        // forma de pago la manda la orden (o su desglose de multipago) y guardarla otra vez
        // aquí crearía dos verdades para el mismo cobro.
        id_metodo_pago: idOrden ? null : (idMetodoPago || null),
        id_movimiento_anula: idMovimientoAnula || null,
    }, { transaction });

    // Solo el movimiento MANUAL avisa desde aquí. Los que entran con transacción vienen del
    // cobro de un pedido o de una anulación, y esos ya avisan al confirmar la suya: hacerlo
    // también aquí sería un aviso dentro de una transacción sin confirmar, más una consulta
    // extra por cada cobro para averiguar el negocio.
    if (!transaction) {
        avisar(await getIdNegocioDeCaja(idCaja), TEMAS.CAJA);
    }
    return movimiento;
}

/**
 * Un pedido puede cobrarse en CERO, pero solo si un descuento se comió su valor.
 *
 * El caso real es la cena de los empleados: el restaurante la registra como pedido para que
 * salga en el consumo y en el inventario, y la descuenta entera porque no la cobra. Sin esto
 * la única salida era no tomar el pedido, y entonces ni el inventario ni el informe se
 * enteraban de esa comida.
 *
 * La condición se comprueba contra la orden guardada, no contra el `monto` que llega por
 * parámetro: son dos caminos distintos hasta el mismo número y solo uno es la fuente de
 * verdad. Y se exige que **haya** descuento y que **haya** algo que descontar, porque el otro
 * modo de llegar a cero es un pedido vacío o roto, y ese sí debe seguir rebotando.
 */
async function exigirCeroJustificadoPorDescuento({ idOrden, transaction }) {
    const orden = await Models.PedidOrden.findByPk(idOrden, {
        attributes: ['id_orden', 'subtotal', 'impuesto', 'valor_domicilio', 'descuento', 'total'],
        transaction,
    });

    const bruto = Number(orden?.subtotal ?? 0)
        + Number(orden?.impuesto ?? 0)
        + Number(orden?.valor_domicilio ?? 0);
    const rebaja = Number(orden?.descuento ?? 0);

    // En centavos, como el cuadre del multipago: comparar decimales a pelo miente.
    const cubreElTotal = Math.round(bruto * 100) === Math.round(rebaja * 100);

    if (!orden || rebaja <= 0 || bruto <= 0 || !cubreElTotal) {
        const err = new Error(
            'Un pedido solo puede cobrarse en cero cuando el descuento cubre su valor completo.',
        );
        err.code = 'COBRO_CERO_SIN_DESCUENTO';
        err.statusCode = 422;
        throw err;
    }
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

    const importe = Number(monto ?? 0);
    const esCero = Number.isFinite(importe) && importe === 0;
    if (esCero) await exigirCeroJustificadoPorDescuento({ idOrden, transaction });

    await registrarMovimiento({
        idCaja: caja.id_caja,
        tipo: 'INGRESO',
        monto,
        concepto: `Orden ${numeroOrden}`,
        idUsuario,
        idOrden,
        // Queda un INGRESO de cero, y es a propósito: no mueve el arqueo pero deja el pedido
        // en el listado del turno. Saltarse el movimiento lo haría desaparecer de la caja,
        // que es justo donde el negocio quiere ver las cenas que regaló.
        permitirCero: esCero,
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
                // Reversar un cero da un cero. El original ya pasó por la comprobación del
                // descuento; volver a exigirla aquí impediría anular una cena de empleado.
                permitirCero: Number(mov.monto) === 0,
                transaction: t,
            });
            montoRevertido += mov.tipo === 'INGRESO' ? Number(mov.monto) : -Number(mov.monto);
        }

        await orden.update({ estado: 'ANULADA' }, { transaction: t });

        // Si el pedido se había pagado con una tiquetera, hay que devolverle al cliente lo que
        // se le descontó. Sin esto, anular el pedido le quitaba la comida Y el almuerzo.
        await require('./cuentaService').revertirConsumoDeOrden({
            idNegocio, idOrden, idUsuario, transaction: t,
        });

        await t.commit();
        avisar(idNegocio, TEMAS.CAJA, TEMAS.PEDIDOS, TEMAS.MESAS, TEMAS.CLIENTES);
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
        avisar(idNegocio, TEMAS.CAJA);
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

/**
 * Los productos de un pedido, para desplegarlos bajo su fila en Caja.
 *
 * Se piden uno a uno al abrir el acordeón y no junto con los movimientos: un turno
 * largo son cientos de filas, y devolver el detalle de todas convierte una consulta
 * barata en una respuesta enorme que además casi nadie mira.
 *
 * El `id_negocio` va en el WHERE, no solo comprobado antes: la ruta recibe un id de
 * orden suelto y sin eso, iterar ids leería los pedidos de otro inquilino.
 */
async function getItemsOrden({ idOrden, idNegocio }) {
    const orden = await Models.PedidOrden.findOne({
        where: { id_orden: idOrden, id_negocio: idNegocio },
        attributes: [
            'id_orden', 'numero_orden', 'tipo_pedido', 'estado', 'nota',
            'subtotal', 'impuesto', 'descuento', 'valor_domicilio', 'total',
        ],
        include: [{
            model: Models.PedidDetalle,
            as: 'detalles',
            attributes: ['id_detalle', 'cantidad', 'precio_unitario', 'subtotal', 'nota'],
            include: [
                {
                    model: Models.CartaProducto,
                    as: 'producto',
                    attributes: ['id_producto', 'nombre', 'icono'],
                },
                {
                    model: Models.PedidDetalleExclu,
                    as: 'exclusiones',
                    attributes: ['id_detalle_exclu'],
                    required: false,
                    include: [{
                        model: Models.CartaIngrediente,
                        as: 'ingrediente',
                        attributes: ['id_ingrediente', 'nombre'],
                    }],
                },
            ],
        }],
        order: [[{ model: Models.PedidDetalle, as: 'detalles' }, 'id_detalle', 'ASC']],
    });

    if (!orden) return null;

    const json = orden.toJSON();
    return {
        id_orden: json.id_orden,
        numero_orden: json.numero_orden,
        tipo_pedido: json.tipo_pedido,
        estado: json.estado,
        nota: json.nota || null,
        subtotal: Number(json.subtotal || 0),
        impuesto: Number(json.impuesto || 0),
        descuento: Number(json.descuento || 0),
        valor_domicilio: Number(json.valor_domicilio || 0),
        total: Number(json.total || 0),
        items: (json.detalles || []).map((d) => ({
            id_detalle: d.id_detalle,
            nombre: d.producto?.nombre || 'Producto',
            icono: d.producto?.icono || null,
            cantidad: Number(d.cantidad || 0),
            precio_unitario: Number(d.precio_unitario || 0),
            subtotal: Number(d.subtotal || 0),
            nota: d.nota || null,
            sin: (d.exclusiones || [])
                .map((e) => e.ingrediente?.nombre)
                .filter(Boolean),
        })),
    };
}

module.exports = {
    requireCajaAbierta,
    anularOrdenCobrada,
    anularMovimientoCaja,
    abrirCaja,
    cerrarCaja,
    getCajaAbierta,
    getCajaDetalle,
    getIdNegocioDeCaja,
    listarHistorialCajas,
    usuarioPerteneceANegocio,
    getMovimientos,
    getItemsOrden,
    getResumenDomiciliarios,
    transferirDomiciliarioACaja,
    registrarMovimiento,
    validarMetodoPagoManual,
    registrarIngresoOrden,
    getDesglosePorMetodo,
    validarPendientesCierre,
};
