/**
 * DAO de cobranza — el acceso a datos del cobro de NUESTRAS mensualidades.
 *
 * Ver `docs/cobro-mensualidades.md`. Las reglas de negocio (cuándo se extiende un plan, qué
 * pasa con un retenedor, cómo se calcula el período) viven en `cobranzaService`; aquí solo
 * está el acceso a datos y las precondiciones que la base puede comprobar barato.
 *
 * Todas las funciones que escriben aceptan `{ transaction }` y lo propagan: un pago que
 * marca la factura pero no alcanza a extender el plan es peor que un pago que falla entero.
 */
'use strict';
const Models = require('../models/conection');
const { Op } = Models.Sequelize;

const sequelize = Models.sequelize;

function error(mensaje, code, statusCode = 400) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

// ── Catálogo ────────────────────────────────────────────────────────────────────────────

/**
 * Pasarelas que un negocio de este país puede elegir.
 *
 * Filtra por país y por estado 'A'. Las inactivas (hoy dLocal y Wompi, a la espera de
 * credenciales) no se devuelven: ofrecer en pantalla algo que no se puede cobrar es la forma
 * más rápida de que un cliente crea que pagó y no lo haya hecho.
 */
async function listarPasarelas({ pais = 'CO' } = {}) {
    return sequelize.query(
        `SELECT codigo, nombre, descripcion, monedas, soporta_recurrente
           FROM cobranza.cob_pasarela
          WHERE estado = 'A' AND :pais = ANY(paises)
          ORDER BY orden ASC;`,
        { replacements: { pais }, type: sequelize.QueryTypes.SELECT }
    );
}

/**
 * Los planes entre los que un cliente puede elegir y pagar, con su precio en su moneda.
 *
 * Filtra `precio > 0` a propósito: la prueba de 7 días no es algo que se elija ni se pague, se
 * asigna al registrar el negocio. Si algún día hay un plan gratuito, tampoco tiene por qué
 * aparecer aquí (decisión del usuario, 2026-09-15).
 */
async function listarPlanesParaCliente({ moneda = 'COP', ciclo = 'mensual' } = {}) {
    return sequelize.query(
        `SELECT p.id_plan, p.nombre, p.descripcion, pr.precio::float8 AS precio, pr.moneda, pr.ciclo
           FROM cobranza.cob_precio_plan pr
           JOIN general.gener_plan p ON p.id_plan = pr.id_plan AND p.estado = 'A'
          WHERE pr.estado = 'A' AND pr.moneda = :moneda AND pr.ciclo = :ciclo AND pr.precio > 0
          ORDER BY pr.precio ASC;`,
        { replacements: { moneda, ciclo }, type: sequelize.QueryTypes.SELECT }
    );
}

/**
 * Precio vigente de un plan. Devuelve un número, no el string del DECIMAL: coercer aquí evita
 * que un `'27999.00' + 0` se cuele en un total tres capas más arriba.
 */
async function getPrecio({ idPlan, moneda, ciclo = 'mensual' }, { transaction } = {}) {
    const fila = await Models.CobPrecioPlan.findOne({
        where: { id_plan: idPlan, moneda, ciclo, estado: 'A' },
        transaction,
    });
    if (!fila) {
        throw error(
            `No hay precio configurado para el plan ${idPlan} en ${moneda}/${ciclo}.`,
            'PRECIO_NO_CONFIGURADO',
            409
        );
    }
    return Number(fila.precio);
}

// ── Suscripción ─────────────────────────────────────────────────────────────────────────

async function getSuscripcionPorNegocio(idNegocio, { transaction } = {}) {
    return Models.CobSuscripcion.findOne({
        where: { id_negocio: idNegocio },
        transaction,
    });
}

async function exigirSuscripcion(idNegocio, { transaction } = {}) {
    const suscripcion = await getSuscripcionPorNegocio(idNegocio, { transaction });
    if (!suscripcion) {
        throw error(
            'Este negocio no tiene una suscripción de cobro configurada.',
            'SUSCRIPCION_NO_ENCONTRADA',
            404
        );
    }
    return suscripcion;
}

async function crearSuscripcion(datos, { transaction } = {}) {
    return Models.CobSuscripcion.create(datos, { transaction });
}

async function actualizarSuscripcion(idSuscripcion, cambios, { transaction } = {}) {
    await Models.CobSuscripcion.update(
        { ...cambios, actualizado_en: new Date() },
        { where: { id_suscripcion: idSuscripcion }, transaction }
    );
    return Models.CobSuscripcion.findByPk(idSuscripcion, { transaction });
}

// ── Facturas ────────────────────────────────────────────────────────────────────────────

async function getFacturaPorReferencia(referencia, { transaction } = {}) {
    return Models.CobFactura.findOne({ where: { referencia }, transaction });
}

async function getFactura(idFactura, { transaction, lock = false } = {}) {
    return Models.CobFactura.findByPk(idFactura, {
        transaction,
        ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
    });
}

/**
 * Crea la factura de un período.
 *
 * El `UNIQUE` sobre `referencia` es la llave de idempotencia del módulo, así que la violación
 * se traduce a un error tipado en vez de dejar salir un 23505 crudo: quien llama necesita
 * distinguir «ya existe» (que casi siempre es correcto y hay que seguir) de «la base falló».
 */
async function crearFactura(datos, { transaction } = {}) {
    try {
        return await Models.CobFactura.create(datos, { transaction });
    } catch (err) {
        if (err?.name === 'SequelizeUniqueConstraintError') {
            throw error(
                `Ya existe una factura con la referencia ${datos.referencia}.`,
                'FACTURA_DUPLICADA',
                409
            );
        }
        throw err;
    }
}

async function actualizarFactura(idFactura, cambios, { transaction } = {}) {
    await Models.CobFactura.update(
        { ...cambios, actualizado_en: new Date() },
        { where: { id_factura: idFactura }, transaction }
    );
    return Models.CobFactura.findByPk(idFactura, { transaction });
}

async function listarFacturasDeNegocio(idNegocio, { limite = 24 } = {}) {
    return Models.CobFactura.findAll({
        where: { id_negocio: idNegocio },
        order: [['periodo_inicio', 'DESC']],
        limit: limite,
    });
}

async function registrarTransaccion(datos, { transaction } = {}) {
    return Models.CobTransaccion.create(datos, { transaction });
}

// ── Cartera (vista de super-admin) ──────────────────────────────────────────────────────

/**
 * Una fila por negocio con suscripción: quién es, qué plan tiene, cómo paga y cuánto debe.
 *
 * Va en SQL crudo y no en cuatro `findAll` porque son cuatro tablas y un agregado, y el
 * equivalente en Sequelize sería más largo, más lento y menos legible. `deuda` cuenta solo
 * facturas `pendiente`: una `fallida` ya fue reintentada y una `anulada` se perdonó a mano.
 */
async function listarCartera({ estado = null, busqueda = null } = {}) {
    return sequelize.query(
        `
        SELECT s.id_suscripcion,
               s.id_negocio,
               n.nombre               AS negocio,
               n.email_contacto,
               p.id_plan,
               p.nombre               AS plan,
               s.ciclo,
               s.moneda,
               s.pasarela,
               s.estado,
               s.proximo_cobro,
               s.es_retenedor,
               np.fecha_fin           AS plan_hasta,
               COALESCE(f.pendientes, 0)::int      AS facturas_pendientes,
               COALESCE(f.deuda, 0)::numeric       AS deuda,
               f.mas_vieja            AS pendiente_desde
          FROM cobranza.cob_suscripcion s
          JOIN general.gener_negocio n ON n.id_negocio = s.id_negocio
          JOIN general.gener_plan    p ON p.id_plan    = s.id_plan
          LEFT JOIN LATERAL (
                -- El plan de MAYOR cobertura, el mismo que renueva un pago (planParaRenovar).
                -- Por fecha_inicio, con dos planes activos la columna mostraba otro vencimiento.
                SELECT fecha_fin
                  FROM general.gener_negocio_plan
                 WHERE id_negocio = s.id_negocio AND estado = 'A'
                 ORDER BY fecha_fin DESC NULLS FIRST
                 LIMIT 1
          ) np ON true
          LEFT JOIN LATERAL (
                SELECT COUNT(*)          AS pendientes,
                       SUM(total)        AS deuda,
                       MIN(periodo_inicio) AS mas_vieja
                  FROM cobranza.cob_factura
                 WHERE id_suscripcion = s.id_suscripcion AND estado = 'pendiente'
          ) f ON true
         WHERE (:estado::text IS NULL OR s.estado = :estado)
           AND (:busqueda::text IS NULL OR n.nombre ILIKE '%' || :busqueda || '%')
         ORDER BY COALESCE(f.deuda, 0) DESC, n.nombre ASC;
        `,
        { replacements: { estado, busqueda }, type: sequelize.QueryTypes.SELECT }
    );
}

/**
 * Lo que se facturó y lo que de verdad llegó, mes a mes.
 *
 * `total` y `neto_recibido` se devuelven por separado a propósito: su diferencia son las
 * comisiones y las retenciones, y es exactamente lo que descuadra la conciliación de
 * cualquiera que mire solo el extracto (docs/obligaciones-escalapp.md §3).
 */
async function resumenIngresos({ meses = 6 } = {}) {
    return sequelize.query(
        `
        SELECT to_char(date_trunc('month', periodo_inicio), 'YYYY-MM') AS mes,
               COUNT(*) FILTER (WHERE estado = 'pagada')::int          AS pagadas,
               COUNT(*) FILTER (WHERE estado = 'pendiente')::int       AS pendientes,
               COALESCE(SUM(total) FILTER (WHERE estado = 'pagada'), 0)::numeric         AS facturado,
               COALESCE(SUM(neto_recibido) FILTER (WHERE estado = 'pagada'), 0)::numeric AS neto,
               COALESCE(SUM(comision_pasarela) FILTER (WHERE estado = 'pagada'), 0)::numeric   AS comisiones,
               COALESCE(SUM(retencion_declarada) FILTER (WHERE estado = 'pagada'), 0)::numeric AS retenciones
          FROM cobranza.cob_factura
         WHERE periodo_inicio >= date_trunc('month', CURRENT_DATE) - make_interval(months => :meses)
         GROUP BY 1
         ORDER BY 1 DESC;
        `,
        { replacements: { meses }, type: sequelize.QueryTypes.SELECT }
    );
}

// ── Plan (el puente hacia general.gener_negocio_plan) ───────────────────────────────────

/**
 * El plan que se renueva con un pago: el de MAYOR cobertura del negocio (la fecha de fin más
 * lejana; un plan sin fecha de fin gana, porque no vence).
 *
 * Va con `FOR UPDATE` porque la renovación ahora SUMA un ciclo a la fecha de fin que lee aquí.
 * Antes el pago fijaba una fecha absoluta con GREATEST y aplicarlo dos veces daba igual; sumando,
 * dos procesos que leyeran la misma fecha a la vez extenderían dos meses por un pago. El bloqueo
 * de la factura ya lo impide para el mismo pago; este lo impide también para dos pagos distintos
 * que se confirman en el mismo instante.
 *
 * @returns {Promise<{ id_negocio_plan: number, fin: string|null } | null>}
 *          `fin` como 'YYYY-MM-DD' (día Bogotá), null si el plan no vence. null si no hay plan.
 */
async function planParaRenovar(idNegocio, { transaction } = {}) {
    const [fila] = await sequelize.query(
        `SELECT id_negocio_plan, to_char(fecha_fin::date, 'YYYY-MM-DD') AS fin
           FROM general.gener_negocio_plan
          WHERE id_negocio = :idNegocio AND estado = 'A'
          ORDER BY fecha_fin DESC NULLS FIRST
          LIMIT 1
          FOR UPDATE;`,
        { replacements: { idNegocio }, transaction, type: sequelize.QueryTypes.SELECT }
    );
    return fila || null;
}

/**
 * Fija el vencimiento que compró un pago. Si el negocio no tenía plan activo, lo crea desde
 * `inicio` —el cliente que vuelve después de quedarse sin plan—.
 *
 * `hasta` llega ya calculado (fin del día en Bogotá): esta función no decide cuánto se extiende,
 * eso es regla de negocio y vive en `cobranzaService.calcularRenovacion`.
 */
async function fijarVencimientoPlan({ idNegocio, idNegocioPlan, idPlan, inicio, hasta }, { transaction } = {}) {
    if (idNegocioPlan) {
        await sequelize.query(
            `UPDATE general.gener_negocio_plan
                SET fecha_fin = :hasta::timestamp,
                    id_plan   = :idPlan
              WHERE id_negocio_plan = :idNegocioPlan;`,
            { replacements: { hasta, idPlan, idNegocioPlan }, transaction }
        );
        return idNegocioPlan;
    }

    const [creada] = await sequelize.query(
        `INSERT INTO general.gener_negocio_plan
             (id_negocio, id_plan, fecha_inicio, fecha_fin, estado, auto_renovacion)
         VALUES (:idNegocio, :idPlan, :inicio::timestamp, :hasta::timestamp, 'A', true)
         RETURNING id_negocio_plan;`,
        {
            replacements: { idNegocio, idPlan, inicio: `${inicio} 00:00:00`, hasta },
            transaction,
            type: sequelize.QueryTypes.SELECT,
        }
    );
    return creada?.id_negocio_plan ?? null;
}

module.exports = {
    listarPlanesParaCliente,
    planParaRenovar,
    fijarVencimientoPlan,
    listarPasarelas,
    getPrecio,
    getSuscripcionPorNegocio,
    exigirSuscripcion,
    crearSuscripcion,
    actualizarSuscripcion,
    getFactura,
    getFacturaPorReferencia,
    crearFactura,
    actualizarFactura,
    listarFacturasDeNegocio,
    registrarTransaccion,
    listarCartera,
    resumenIngresos,
    Op,
};
