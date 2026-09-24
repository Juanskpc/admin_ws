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
async function listarPlanesParaCliente(
    { moneda = 'COP', ciclo = 'mensual', idNegocio = null, idTipoModulo = null } = {}
) {
    // Cada plan con SU precio: el del aplicativo del negocio si lo tiene, y si no el de por defecto
    // (`id_tipo_modulo IS NULL`). Un negocio de Restaurante, sin filas propias, ve lo de siempre.
    const modulo = await resolverModulo({ idNegocio, idTipoModulo });
    return sequelize.query(
        `SELECT * FROM (
             SELECT DISTINCT ON (p.id_plan)
                    p.id_plan, p.codigo, p.nombre, p.descripcion, pr.precio::float8 AS precio, pr.moneda, pr.ciclo
               FROM cobranza.cob_precio_plan pr
               JOIN general.gener_plan p ON p.id_plan = pr.id_plan AND p.estado = 'A'
              WHERE pr.estado = 'A' AND pr.moneda = :moneda AND pr.ciclo = :ciclo AND pr.precio > 0
                AND (pr.id_tipo_modulo IS NULL OR pr.id_tipo_modulo = :modulo)
              ORDER BY p.id_plan, (pr.id_tipo_modulo IS NULL) ASC
         ) t
         ORDER BY t.precio ASC;`,
        { replacements: { moneda, ciclo, modulo }, type: sequelize.QueryTypes.SELECT }
    );
}

/**
 * El aplicativo (módulo) contra el que se cotiza: el que se dice, o el del negocio.
 * `gener_negocio.id_tipo_negocio` ES el módulo (el oficio va aparte, en `id_rubro`).
 * `null` = sin aplicativo conocido: se cotiza con los precios por defecto.
 */
async function resolverModulo({ idNegocio = null, idTipoModulo = null } = {}, { transaction } = {}) {
    if (idTipoModulo) return Number(idTipoModulo);
    if (!idNegocio) return null;
    const [fila] = await sequelize.query(
        'SELECT id_tipo_negocio FROM general.gener_negocio WHERE id_negocio = :idNegocio;',
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT, transaction }
    );
    return fila?.id_tipo_negocio ? Number(fila.id_tipo_negocio) : null;
}

/**
 * Precio vigente de un plan. Devuelve un número, no el string del DECIMAL: coercer aquí evita
 * que un `'27999.00' + 0` se cuele en un total tres capas más arriba.
 */
async function getPrecio(
    { idPlan, moneda, ciclo = 'mensual', idNegocio = null, idTipoModulo = null },
    { transaction } = {}
) {
    // El precio propio del aplicativo del negocio manda; si no lo tiene, el de por defecto.
    const modulo = await resolverModulo({ idNegocio, idTipoModulo }, { transaction });
    const [fila] = await sequelize.query(
        `SELECT precio FROM cobranza.cob_precio_plan
          WHERE id_plan = :idPlan AND moneda = :moneda AND ciclo = :ciclo AND estado = 'A'
            AND (id_tipo_modulo IS NULL OR id_tipo_modulo = :modulo)
          ORDER BY (id_tipo_modulo IS NULL) ASC
          LIMIT 1;`,
        { replacements: { idPlan, moneda, ciclo, modulo }, type: sequelize.QueryTypes.SELECT, transaction }
    );
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

// ── Complementos ────────────────────────────────────────────────────────────────────────
//
// Van en SQL y no en modelos de Sequelize porque son cuatro consultas cortas y siempre con
// joins: el catálogo con su precio, lo contratado con su precio vigente. Ver
// migrations/migrate_cobranza_complementos.js para el porqué de cada tabla.

/**
 * El catálogo que se puede contratar en una moneda y ciclo: solo complementos activos **con**
 * precio. Uno sin precio en esa moneda no se ofrece, igual que un plan sin fila en
 * `cob_precio_plan`.
 */
async function listarComplementosCatalogo({ moneda = 'COP', ciclo = 'mensual' } = {}, { transaction } = {}) {
    const filas = await sequelize.query(
        `SELECT c.id_complemento, c.codigo, c.nombre, c.descripcion, c.amplia,
                c.cantidad_maxima, p.precio
           FROM cobranza.cob_complemento c
           JOIN cobranza.cob_precio_complemento p
             ON p.id_complemento = c.id_complemento
            AND p.moneda = :moneda AND p.ciclo = :ciclo AND p.estado = 'A'
          WHERE c.estado = 'A'
          ORDER BY c.orden, c.id_complemento;`,
        { replacements: { moneda, ciclo }, type: sequelize.QueryTypes.SELECT, transaction }
    );
    return filas.map((f) => ({ ...f, precio: Number(f.precio) }));
}

/**
 * Lo que tiene contratado una suscripción, con el precio **de hoy** de cada complemento.
 *
 * Es el precio de hoy a propósito, igual que el plan: `generarFacturaPeriodo` cobra lo que
 * vale el plan el día que se genera la factura, y un complemento no puede quedar congelado en
 * un precio que el plan ya no respeta. Si un complemento perdió su precio en esa moneda, sale
 * con `precio: null` y quien cobra decide (hoy: error explícito, nunca cobrarlo a cero).
 */
async function listarComplementosSuscripcion(idSuscripcion, { moneda, ciclo }, { transaction } = {}) {
    const filas = await sequelize.query(
        `SELECT sc.id_complemento, sc.cantidad, sc.cantidad_facturable, sc.cantidad_solicitada,
                c.codigo, c.nombre, c.amplia, p.precio
           FROM cobranza.cob_suscripcion_complemento sc
           JOIN cobranza.cob_complemento c ON c.id_complemento = sc.id_complemento
           LEFT JOIN cobranza.cob_precio_complemento p
             ON p.id_complemento = sc.id_complemento
            AND p.moneda = :moneda AND p.ciclo = :ciclo AND p.estado = 'A'
          WHERE sc.id_suscripcion = :idSuscripcion AND sc.estado = 'A'
          ORDER BY c.orden, c.id_complemento;`,
        {
            replacements: { idSuscripcion, moneda, ciclo },
            type: sequelize.QueryTypes.SELECT,
            transaction,
        }
    );
    return filas.map((f) => ({ ...f, precio: f.precio == null ? null : Number(f.precio) }));
}

/**
 * Deja anotado lo que el cliente pidió y todavía no ha pagado.
 *
 * No toca `cantidad`: esa es la que manda en los límites de uso, y moverla antes de cobrar sería
 * regalar el complemento. Lo pedido vive en `cantidad_solicitada` hasta que un pago lo aplique
 * (`aplicarComplementosSolicitados`), igual que `id_plan_solicitado` con el plan.
 *
 * Un complemento que el cliente aún no tiene se crea con `cantidad = 0`: la fila existe para
 * poder recordar lo pedido, pero no amplía ningún límite hasta que se pague.
 *
 * @param {{ id_complemento: number, cantidad: number }[]} lista la elección COMPLETA del cliente.
 */
async function solicitarComplementosSuscripcion(idSuscripcion, idNegocio, lista, { transaction } = {}) {
    const pedidos = new Map(lista.map((c) => [Number(c.id_complemento), Number(c.cantidad)]));

    const vivos = await sequelize.query(
        `SELECT id_complemento, cantidad FROM cobranza.cob_suscripcion_complemento
          WHERE id_suscripcion = :idSuscripcion AND estado = 'A';`,
        { replacements: { idSuscripcion }, type: sequelize.QueryTypes.SELECT, transaction }
    );

    // Lo que tenía y ya no pide: queda solicitado en cero (se le quitará al renovar), no se
    // desactiva de golpe — el mes en curso ya está pagado y lo sigue usando.
    for (const fila of vivos) {
        if (!pedidos.has(Number(fila.id_complemento))) pedidos.set(Number(fila.id_complemento), 0);
    }

    for (const [idComplemento, cantidad] of pedidos) {
        await sequelize.query(
            `INSERT INTO cobranza.cob_suscripcion_complemento
                    (id_suscripcion, id_negocio, id_complemento, cantidad, cantidad_facturable,
                     cantidad_solicitada, estado)
             VALUES (:idSuscripcion, :idNegocio, :idComplemento, 0, 0, :cantidad, 'A')
             ON CONFLICT (id_suscripcion, id_complemento)
             DO UPDATE SET cantidad_solicitada =
                               CASE WHEN EXCLUDED.cantidad_solicitada = cob_suscripcion_complemento.cantidad
                                    THEN NULL           -- pidió justo lo que ya tiene: no hay nada pendiente
                                    ELSE EXCLUDED.cantidad_solicitada END,
                           estado = 'A',
                           actualizado_en = now();`,
            {
                replacements: { idSuscripcion, idNegocio, idComplemento, cantidad },
                transaction,
            }
        );
    }
}

/**
 * Hace efectivo lo pedido: `cantidad_solicitada` pasa a ser `cantidad` y se limpia.
 *
 * Se llama al pagar, y solo ahí. La cortesía se conserva en unidades: quien tenía 5 de 8 gratis
 * y sube a 10 sigue con 5 gratis y paga 5. Una fila que queda en cero se desactiva, que es como
 * el resto del módulo dice «esto ya no está contratado».
 */
async function aplicarComplementosSolicitados(idSuscripcion, { transaction } = {}) {
    await sequelize.query(
        `UPDATE cobranza.cob_suscripcion_complemento
            SET cantidad_facturable = GREATEST(
                    0,
                    cantidad_solicitada - GREATEST(0, cantidad - cantidad_facturable)
                ),
                cantidad = cantidad_solicitada,
                cantidad_solicitada = NULL,
                estado = CASE WHEN cantidad_solicitada = 0 THEN 'I' ELSE 'A' END,
                actualizado_en = now()
          WHERE id_suscripcion = :idSuscripcion
            AND cantidad_solicitada IS NOT NULL;`,
        { replacements: { idSuscripcion }, transaction }
    );
}

/** Olvida lo pedido y no pagado. Se usa al deshacer una solicitud. */
async function limpiarComplementosSolicitados(idSuscripcion, { transaction } = {}) {
    await sequelize.query(
        `UPDATE cobranza.cob_suscripcion_complemento
            SET cantidad_solicitada = NULL, actualizado_en = now()
          WHERE id_suscripcion = :idSuscripcion AND cantidad_solicitada IS NOT NULL;`,
        { replacements: { idSuscripcion }, transaction }
    );
}

/**
 * Deja la suscripción con **exactamente** estos complementos.
 *
 * Es un reemplazo y no una suma porque lo que llega es la elección completa del cliente (la
 * pantalla manda las cantidades finales, no incrementos): lo que no viene se desactiva, lo que
 * viene se crea o se actualiza. Desactivar y no borrar deja rastro en la auditoría de cuándo
 * dejó de tener cada cosa.
 *
 * `cantidad_facturable` es opcional: si no viene, se cobra todo lo contratado. Solo la consola
 * de super-admin la manda distinta, que es donde se regalan unidades a un cliente.
 *
 * @param {{ id_complemento: number, cantidad: number, cantidad_facturable?: number }[]} lista
 */
async function fijarComplementosSuscripcion(idSuscripcion, idNegocio, lista, { transaction } = {}) {
    const ids = lista.map((c) => c.id_complemento);

    await sequelize.query(
        `UPDATE cobranza.cob_suscripcion_complemento
            SET estado = 'I', actualizado_en = now()
          WHERE id_suscripcion = :idSuscripcion
            AND estado = 'A'
            AND (:sinIds OR id_complemento <> ALL (ARRAY[:ids]::int[]));`,
        {
            replacements: { idSuscripcion, sinIds: ids.length === 0, ids: ids.length ? ids : [0] },
            transaction,
        }
    );

    for (const { id_complemento, cantidad, cantidad_facturable } of lista) {
        const facturable = Math.min(cantidad, Math.max(0, cantidad_facturable ?? cantidad));
        await sequelize.query(
            `INSERT INTO cobranza.cob_suscripcion_complemento
                    (id_suscripcion, id_negocio, id_complemento, cantidad, cantidad_facturable, estado)
             VALUES (:idSuscripcion, :idNegocio, :idComplemento, :cantidad, :facturable, 'A')
             ON CONFLICT (id_suscripcion, id_complemento)
             DO UPDATE SET cantidad = EXCLUDED.cantidad,
                           cantidad_facturable = EXCLUDED.cantidad_facturable,
                           estado = 'A',
                           actualizado_en = now();`,
            {
                replacements: {
                    idSuscripcion,
                    idNegocio,
                    idComplemento: id_complemento,
                    cantidad,
                    facturable,
                },
                transaction,
            }
        );
    }
}

/**
 * Reescribe las líneas de una factura. Se llama cada vez que se fija su total —al crearla y al
 * recalcularla—, así que detalle y total no pueden quedar desalineados.
 */
async function reemplazarDetalleFactura(idFactura, lineas, { transaction } = {}) {
    await sequelize.query(`DELETE FROM cobranza.cob_factura_detalle WHERE id_factura = :idFactura;`, {
        replacements: { idFactura },
        transaction,
    });
    for (const l of lineas) {
        await sequelize.query(
            `INSERT INTO cobranza.cob_factura_detalle
                    (id_factura, tipo, id_plan, id_complemento, descripcion, cantidad,
                     precio_unitario, subtotal)
             VALUES (:idFactura, :tipo, :idPlan, :idComplemento, :descripcion, :cantidad,
                     :precioUnitario, :subtotal);`,
            {
                replacements: {
                    idFactura,
                    tipo: l.tipo,
                    idPlan: l.id_plan ?? null,
                    idComplemento: l.id_complemento ?? null,
                    descripcion: l.descripcion,
                    cantidad: l.cantidad,
                    precioUnitario: l.precio_unitario,
                    subtotal: l.subtotal,
                },
                transaction,
            }
        );
    }
}

async function listarDetalleFactura(idFactura, { transaction } = {}) {
    const filas = await sequelize.query(
        `SELECT tipo, id_plan, id_complemento, descripcion, cantidad, precio_unitario, subtotal
           FROM cobranza.cob_factura_detalle
          WHERE id_factura = :idFactura
          ORDER BY id_factura_detalle;`,
        { replacements: { idFactura }, type: sequelize.QueryTypes.SELECT, transaction }
    );
    return filas.map((f) => ({
        ...f,
        precio_unitario: Number(f.precio_unitario),
        subtotal: Number(f.subtotal),
    }));
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
    resolverModulo,
    listarComplementosCatalogo,
    listarComplementosSuscripcion,
    fijarComplementosSuscripcion,
    solicitarComplementosSuscripcion,
    aplicarComplementosSolicitados,
    limpiarComplementosSolicitados,
    reemplazarDetalleFactura,
    listarDetalleFactura,
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
