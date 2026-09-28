'use strict';
const Models = require('../../app_core/models/conection');
const { usuarioTieneSubnivel } = require('../../app_core/helpers/permisoSubnivel');

/**
 * Seguimiento del flujo mesero → caja (sección «Movimientos» en Caja).
 *
 * ## El problema que resuelve
 *
 * Un pedido se toma en el POS (mesero) y se resuelve en Caja (cajero): cobrado, o
 * cancelado — con o sin haber llegado a cobrarse. Esas dos decisiones las toma
 * gente distinta, en momentos distintos, y hoy no hay ninguna pantalla que junte
 * «quién tomó esto» con «quién lo resolvió y cómo». Eso es lo que permite que un
 * pedido se cancele sin que nadie más se entere de que ahí había un ingreso.
 *
 * ## Por qué no hace falta ninguna tabla nueva
 *
 * El rastro completo ya existe, repartido en tres sitios que esta consulta junta:
 *
 * 1. **Quién tomó el pedido** — `pedid_orden.id_usuario` + `fecha_creacion`.
 * 2. **Quién lo cobró** (y con qué método) — `rest_movimiento_caja` con
 *    `id_orden` = esta orden, `tipo = 'INGRESO'`, `id_movimiento_anula IS NULL`.
 *    Si más tarde alguien anuló ese cobro, la reversa es la fila con
 *    `id_movimiento_anula` apuntando a la original — mismo `id_orden`, otro
 *    `id_usuario` (quien anuló) y su propia fecha.
 * 3. **Quién lo canceló sin cobrar** — `cancelarOrden` deja `pedid_orden.estado =
 *    'CANCELADA'` pero NO guarda ahí quién lo hizo (`id_usuario` sigue siendo el
 *    mesero que la creó). Ese dato solo queda en `auditoria.audit_dato`, en la
 *    fila que el trigger `trg_audit` escribe para ese UPDATE — es la única pieza
 *    de este seguimiento que no sale de una tabla de negocio directamente.
 *
 * Con eso alcanza para las cuatro salidas de un pedido: `CERRADA` (cobrado),
 * `CANCELADA` (nunca se cobró), `ANULADA` (se cobró y se revirtió) y `ABIERTA`
 * (todavía en curso, nadie en caja lo ha tocado).
 *
 * ## Por qué es de solo lectura y con su propio permiso
 *
 * Esta pantalla no cambia nada: es la manera de que el dueño vea el flujo
 * completo sin tener que cruzar Caja, Despacho y el historial a mano. Por eso el
 * permiso (`caja_ver_movimientos`) se comprueba aquí exactamente igual que
 * `caja_eliminar_pedido` — apagado para todos, incluido el administrador, hasta
 * que se conceda a mano en Usuarios → Roles y permisos (ver
 * `migrate_restaurante_caja_movimientos.js`).
 */

const SUBNIVEL_VER_MOVIMIENTOS = 'caja_ver_movimientos';
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 30;

function error(mensaje, statusCode = 400, code = null) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    if (code) e.code = code;
    return e;
}

/** `YYYY-MM-DD` sin más: el rango se compara contra `timestamp without time zone`. */
function parseFecha(valor) {
    if (!valor || typeof valor !== 'string') return null;
    const token = valor.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(token) ? token : null;
}

/** Hoy en hora de Bogotá, como `YYYY-MM-DD`. */
function hoyBogota() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

function buildPagination(limite, offset) {
    const safeLimite = Number.isFinite(Number(limite))
        ? Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limite)))
        : DEFAULT_PAGE_SIZE;
    const safeOffset = Number.isFinite(Number(offset)) ? Math.max(0, Number(offset)) : 0;
    return { limite: safeLimite, offset: safeOffset };
}

const ESTADOS_VALIDOS = ['ABIERTA', 'CERRADA', 'CANCELADA', 'ANULADA'];

/**
 * Lista los pedidos con su línea de tiempo (tomado / cobrado / cancelado / anulado), más un
 * resumen. Hay dos maneras de acotarlos:
 *
 * - **Por caja (`idCaja`)** — la que usa la pantalla desde 2026-09-29: los pedidos de UN turno, sin
 *   fechas. Ver `condicionDeCaja`.
 * - **Por rango de días** (`desde`/`hasta`, hoy por defecto) — filtra por `fecha_creacion`, «el día
 *   laboral en que se tomó», no en que se cerró: un pedido tomado a las 11 p. m. y cerrado pasada la
 *   medianoche sigue siendo del turno de esa noche. Se conserva para quien no pase caja.
 *
 * Si llega `idCaja`, manda sobre las fechas.
 */
async function listar({
    idUsuario, idNegocio, desde, hasta, estado, idPuntoCaja, idCaja, q, limite, offset,
}) {
    const permitido = await usuarioTieneSubnivel({
        idUsuario, idNegocio, codigo: SUBNIVEL_VER_MOVIMIENTOS,
        // Ni el administrador lo hereda por serlo: se concede uno por uno, igual
        // que `caja_eliminar_pedido`.
        adminSiempre: false,
    });
    if (!permitido) {
        throw error('No tienes permiso para ver el seguimiento de pedidos.', 403, 'SIN_PERMISO_VER_MOVIMIENTOS');
    }

    if (estado && !ESTADOS_VALIDOS.includes(estado)) {
        throw error('Estado inválido.', 422, 'ESTADO_INVALIDO');
    }

    const { limite: safeLimite, offset: safeOffset } = buildPagination(limite, offset);

    const condiciones = ['o.id_negocio = $1'];
    const params = [idNegocio];
    let rango = null;

    if (idCaja) {
        // Se comprueba aparte para poder decir «esa caja no existe» en vez de devolver una lista
        // vacía que parece «esa caja no tuvo pedidos». Y de este negocio: el id viene del cliente.
        const existe = await Models.pool.query(
            'SELECT 1 FROM restaurante.rest_caja WHERE id_caja = $1 AND id_negocio = $2',
            [idCaja, idNegocio],
        );
        if (existe.rowCount === 0) throw error('No encuentro esa caja.', 404, 'CAJA_NO_ENCONTRADA');
        params.push(idCaja);
        condiciones.push(condicionDeCaja(params.length));
    } else {
        const hoy = hoyBogota();
        const fechaDesde = parseFecha(desde) || hoy;
        const fechaHasta = parseFecha(hasta) || hoy;
        if (fechaDesde > fechaHasta) {
            throw error('El rango de fechas es inválido.', 422, 'RANGO_FECHAS_INVALIDO');
        }
        params.push(fechaDesde, fechaHasta);
        condiciones.push(
            `o.fecha_creacion >= $${params.length - 1}::date::timestamp`,
            `o.fecha_creacion < ($${params.length}::date + 1)::timestamp`,
        );
        rango = { desde: fechaDesde, hasta: fechaHasta };
    }

    if (idPuntoCaja) {
        params.push(idPuntoCaja);
        condiciones.push(`o.id_punto_caja = $${params.length}`);
    }
    if (estado) {
        params.push(estado);
        condiciones.push(`o.estado = $${params.length}`);
    }
    if (q && String(q).trim()) {
        params.push(`%${String(q).trim()}%`);
        const idx = params.length;
        condiciones.push(`(
            o.numero_orden ILIKE $${idx}
            OR TRIM(CONCAT(mesero.primer_nombre, ' ', mesero.primer_apellido)) ILIKE $${idx}
        )`);
    }

    const whereSql = condiciones.join(' AND ');

    const dataQuery = `
        SELECT
            o.id_orden,
            COALESCE(o.numero_orden, '#' || o.id_orden::text) AS numero_orden,
            COALESCE(o.tipo_pedido, 'MESA') AS tipo_pedido,
            o.estado,
            o.estado_pago,
            o.cancelado_por,
            o.total,
            o.fecha_creacion,
            o.fecha_cierre,
            o.id_usuario AS id_mesero,
            TRIM(CONCAT(mesero.primer_nombre, ' ', mesero.primer_apellido)) AS mesero,
            CASE WHEN o.tipo_pedido = 'MESA' AND m.id_mesa IS NOT NULL
                THEN COALESCE(CONCAT(m.nombre, ' · #', m.numero::text), 'Mesa')
                ELSE NULL
            END AS mesa,
            pc.nombre AS punto_caja
        FROM restaurante.pedid_orden o
        LEFT JOIN general.gener_usuario mesero ON mesero.id_usuario = o.id_usuario
        LEFT JOIN restaurante.rest_mesa m ON m.id_mesa = o.id_mesa
        LEFT JOIN restaurante.rest_punto_caja pc ON pc.id_punto_caja = o.id_punto_caja
        WHERE ${whereSql}
        ORDER BY o.fecha_creacion DESC, o.id_orden DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const countQuery = `SELECT COUNT(*)::int AS total FROM restaurante.pedid_orden o
        LEFT JOIN general.gener_usuario mesero ON mesero.id_usuario = o.id_usuario
        WHERE ${whereSql}`;
    const resumenQuery = `
        SELECT
            COUNT(*) FILTER (WHERE o.estado = 'ABIERTA')::int   AS abiertas,
            COUNT(*) FILTER (WHERE o.estado = 'CERRADA')::int   AS cobradas,
            COUNT(*) FILTER (WHERE o.estado = 'CANCELADA')::int AS canceladas,
            COUNT(*) FILTER (WHERE o.estado = 'ANULADA')::int   AS anuladas,
            COALESCE(SUM(o.total) FILTER (WHERE o.estado = 'CERRADA'), 0)::numeric AS monto_cobrado,
            COALESCE(SUM(o.total) FILTER (WHERE o.estado IN ('CANCELADA', 'ANULADA')), 0)::numeric AS monto_no_cobrado
        FROM restaurante.pedid_orden o
        LEFT JOIN general.gener_usuario mesero ON mesero.id_usuario = o.id_usuario
        WHERE ${whereSql}
    `;

    const [dataRes, countRes, resumenRes] = await Promise.all([
        Models.pool.query(dataQuery, [...params, safeLimite, safeOffset]),
        Models.pool.query(countQuery, params),
        Models.pool.query(resumenQuery, params),
    ]);

    const ordenes = dataRes.rows;
    const ids = ordenes.map((o) => o.id_orden);
    const eventosPorOrden = await cargarEventos(ids);

    return {
        rows: ordenes.map((o) => ({
            id_orden: Number(o.id_orden),
            numero_orden: o.numero_orden,
            tipo_pedido: o.tipo_pedido,
            estado: o.estado,
            estado_pago: o.estado_pago,
            total: Number(o.total || 0),
            mesa: o.mesa,
            punto_caja: o.punto_caja,
            fecha_creacion: o.fecha_creacion,
            mesero: o.mesero?.trim() || null,
            eventos: eventosPorOrden.get(Number(o.id_orden)) || [],
        })),
        total: Number(countRes.rows[0]?.total || 0),
        limite: safeLimite,
        offset: safeOffset,
        resumen: resumenRes.rows[0] || {},
        rango,
        id_caja: idCaja || null,
    };
}

/**
 * Los pedidos «de una caja» (un turno). Son dos grupos, y hacen falta los dos:
 *
 * 1. **Los que se cobraron en ese turno** (`o.id_caja`). Esa columna dice en qué turno se COBRÓ y
 *    llega nula hasta que se cobra, así que sola dejaría fuera todo lo que sigue abierto o se
 *    canceló sin cobrar — justo lo que esta pantalla existe para vigilar.
 * 2. **Los que se tomaron durante el turno, en su mismo rubro** (`id_punto_caja`, entre la apertura y
 *    el cierre; sin cierre = turno en curso). Cubre los abiertos, los cancelados y los anulados.
 *
 * Va como `EXISTS` sobre `rest_caja` para servir igual a las tres consultas (lista, conteo y
 * resumen) sin pasar fechas: comparar dentro de Postgres evita reinterpretar un `timestamp` sin
 * huso en Node.
 */
function condicionDeCaja(posicionParametro) {
    return `EXISTS (
        SELECT 1 FROM restaurante.rest_caja c
        WHERE c.id_caja = $${posicionParametro}
          AND c.id_negocio = o.id_negocio
          AND (
                o.id_caja = c.id_caja
                OR (
                    o.id_punto_caja = c.id_punto_caja
                    AND o.fecha_creacion >= c.fecha_apertura
                    AND (c.fecha_cierre IS NULL OR o.fecha_creacion <= c.fecha_cierre)
                )
          )
    )`;
}

/**
 * La línea de tiempo de cada orden: creación, cobro(s), anulación(es) y —solo si
 * hace falta, porque no está en `rest_movimiento_caja`— quién la canceló sin
 * cobrar, leído de `auditoria.audit_dato`.
 */
async function cargarEventos(idsOrden) {
    const eventos = new Map();
    if (!idsOrden.length) return eventos;

    const push = (idOrden, evento) => {
        if (!eventos.has(idOrden)) eventos.set(idOrden, []);
        eventos.get(idOrden).push(evento);
    };

    // Creación: ya viene en la fila principal, pero como EVENTO se arma aparte
    // para que la línea de tiempo no tenga que distinguir «la fila» de «el primer paso».
    const creaciones = await Models.pool.query(`
        SELECT o.id_orden, o.fecha_creacion, o.id_usuario,
               TRIM(CONCAT(u.primer_nombre, ' ', u.primer_apellido)) AS nombre
        FROM restaurante.pedid_orden o
        LEFT JOIN general.gener_usuario u ON u.id_usuario = o.id_usuario
        WHERE o.id_orden = ANY($1::int[])
    `, [idsOrden]);
    for (const r of creaciones.rows) {
        push(Number(r.id_orden), {
            tipo: 'tomado', fecha: r.fecha_creacion,
            id_usuario: r.id_usuario, actor: r.nombre?.trim() || null,
        });
    }

    // Con qué se pagó. `rest_movimiento_caja.id_metodo_pago` solo se llena en
    // movimientos manuales (sin pedido detrás): el de una orden vive en
    // `pedid_orden.id_metodo_pago` (pago simple) o en `rest_pago_orden` (multipago).
    const metodosPorOrden = new Map();
    const metodosSimples = await Models.pool.query(`
        SELECT o.id_orden, mp.nombre
        FROM restaurante.pedid_orden o
        JOIN restaurante.rest_metodo_pago mp ON mp.id_metodo_pago = o.id_metodo_pago
        WHERE o.id_orden = ANY($1::int[])
    `, [idsOrden]);
    for (const r of metodosSimples.rows) metodosPorOrden.set(Number(r.id_orden), [r.nombre]);
    const metodosMulti = await Models.pool.query(`
        SELECT p.id_orden, mp.nombre
        FROM restaurante.rest_pago_orden p
        JOIN restaurante.rest_metodo_pago mp ON mp.id_metodo_pago = p.id_metodo_pago
        WHERE p.id_orden = ANY($1::int[])
        ORDER BY p.id_pago ASC
    `, [idsOrden]);
    // El multipago manda sobre el simple: una orden con desglose reemplaza (no acumula)
    // la única forma que le hubiera dejado `pedid_orden.id_metodo_pago`.
    const multiPorOrden = new Map();
    for (const r of metodosMulti.rows) {
        const idOrden = Number(r.id_orden);
        if (!multiPorOrden.has(idOrden)) multiPorOrden.set(idOrden, []);
        multiPorOrden.get(idOrden).push(r.nombre);
    }
    for (const [idOrden, nombres] of multiPorOrden) metodosPorOrden.set(idOrden, nombres);

    // Cobros y anulaciones: ambos viven en rest_movimiento_caja, distinguidos por
    // si la fila tiene `id_movimiento_anula` (es una reversa) o no.
    const movimientos = await Models.pool.query(`
        SELECT m.id_orden, m.tipo, m.monto, m.fecha, m.id_usuario, m.id_movimiento_anula,
               TRIM(CONCAT(u.primer_nombre, ' ', u.primer_apellido)) AS nombre
        FROM restaurante.rest_movimiento_caja m
        LEFT JOIN general.gener_usuario u ON u.id_usuario = m.id_usuario
        WHERE m.id_orden = ANY($1::int[])
        ORDER BY m.fecha ASC
    `, [idsOrden]);

    // Se agrupan por orden + si es reversa, porque un cobro con multipago deja
    // varias filas (una por forma de pago) que son EL MISMO evento.
    const agrupados = new Map();
    for (const r of movimientos.rows) {
        const idOrden = Number(r.id_orden);
        const esReversa = r.id_movimiento_anula != null;
        const clave = `${idOrden}:${esReversa}`;
        if (!agrupados.has(clave)) {
            agrupados.set(clave, {
                idOrden, esReversa, fecha: r.fecha, id_usuario: r.id_usuario,
                actor: r.nombre?.trim() || null, monto: 0,
            });
        }
        const g = agrupados.get(clave);
        // El signo de la reversa es el contrario del cobro; lo que importa mostrar
        // es cuánto se movió, no el signo contable de esa fila concreta.
        g.monto += r.tipo === 'INGRESO' ? Number(r.monto) : -Number(r.monto);
    }
    for (const g of agrupados.values()) {
        push(g.idOrden, {
            tipo: g.esReversa ? 'anulado' : 'cobrado',
            fecha: g.fecha, id_usuario: g.id_usuario, actor: g.actor,
            monto: Math.abs(g.monto),
            // La reversa no vuelve a decir con qué se pagó: ya lo dijo el cobro que revierte.
            metodo_pago: g.esReversa ? null : (metodosPorOrden.get(g.idOrden) || []).join(', ') || null,
        });
    }

    // Cancelado sin cobro: el único paso que no está en una tabla de negocio.
    // `datos_despues` es el DELTA del UPDATE (`fn_audit` solo guarda lo que cambió),
    // así que un cambio a CANCELADA siempre lo trae la clave 'estado'.
    const idsCandidatos = idsOrden; // se filtra por estado en el propio JOIN de arriba sería más caro; aquí se pregunta a todas y no cuesta si no hay fila
    const cancelaciones = await Models.pool.query(`
        SELECT DISTINCT ON (a.pk_registro)
            (a.pk_registro)::int AS id_orden, a.fecha, a.id_usuario,
            TRIM(CONCAT(u.primer_nombre, ' ', u.primer_apellido)) AS nombre
        FROM auditoria.audit_dato a
        LEFT JOIN general.gener_usuario u ON u.id_usuario = a.id_usuario
        WHERE a.esquema = 'restaurante' AND a.tabla = 'pedid_orden' AND a.operacion = 'U'
          AND a.pk_registro = ANY($1::text[])
          AND a.datos_despues ->> 'estado' = 'CANCELADA'
        ORDER BY a.pk_registro, a.fecha DESC
    `, [idsCandidatos.map(String)]);
    for (const r of cancelaciones.rows) {
        push(Number(r.id_orden), {
            tipo: 'cancelado', fecha: r.fecha,
            id_usuario: r.id_usuario, actor: r.nombre?.trim() || null,
        });
    }

    for (const lista of eventos.values()) {
        lista.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    }
    return eventos;
}

module.exports = { listar, SUBNIVEL_VER_MOVIMIENTOS };
