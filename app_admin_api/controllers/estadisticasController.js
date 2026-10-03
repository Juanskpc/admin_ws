'use strict';
const Respuesta = require('../../app_core/helpers/respuesta');
const Models = require('../../app_core/models/conection');
const { validationResult } = require('express-validator');

/**
 * Estadísticas de plataforma (Super Admin) — la foto del recorrido completo de EscalApp.
 *
 * GET /admin/estadisticas/plataforma?desde=&hasta=
 *
 * Para qué existe: enseñar a un interesado que el sistema SE USA. No es la Consola de operación
 * (eso es `metricasController`, que mira hoy contra ayer) ni Auditoría: aquí todo es acumulado y
 * cross-inquilino, y por defecto abarca desde el primer día.
 *
 * Dos clases de número, y la diferencia importa al leerlas:
 *   • Entidades (negocios, usuarios, clientes) → acumulado HASTA `hasta`. `desde` no les aplica:
 *     un negocio que entró en abril sigue siendo cliente en septiembre.
 *   • Actividad (pedidos, ventas, citas, mensajes) → solo lo ocurrido DENTRO del rango.
 *
 * Fechas: la sesión Postgres vive en America/Bogota (ver conection.js), así que `::date` ya
 * recorta por hora de pared de Bogotá tanto en `timestamp` como en `timestamptz`.
 */

/**
 * Transacciones de todos los verticales en una sola forma: quién, de qué vertical, cuánto y
 * cuándo. Es la pieza que comparten casi todas las consultas de esta vista, y por eso vive una
 * sola vez: si mañana entra un vertical nuevo, se añade aquí y todas las gráficas lo recogen.
 *
 * `cobrada` distingue el dinero realmente confirmado del volumen gestionado. Las dos cifras son
 * ciertas y cuentan cosas distintas: cuántas operaciones pasaron por el sistema, y cuánto de eso
 * quedó cobrado.
 *
 * Dos marcas de tiempo, y confundirlas arruina una gráfica:
 *   • `momento` = el cierre (o la creación si no cerró). Es con lo que se atribuye el dinero a
 *     un mes, igual que hace `metricasController`.
 *   • `creado`  = cuando la operación nació. Es la ÚNICA válida para el ritmo horario: muchos
 *     negocios cierran la caja de golpe al final del turno, así que por `momento` el reparto por
 *     hora sale amontonado a medianoche en vez de enseñar la hora real del servicio.
 */
const TX_CTE = `
    tx AS (
        SELECT o.id_negocio, 'restaurante'::text AS vertical,
               COALESCE(o.total, 0)::numeric AS monto,
               COALESCE(o.fecha_cierre, o.fecha_creacion) AS momento,
               o.fecha_creacion AS creado,
               (o.estado_pago = 'pagado') AS cobrada
          FROM restaurante.pedid_orden o
         WHERE o.estado <> 'CANCELADA'
        UNION ALL
        SELECT f.id_negocio, 'parqueadero',
               COALESCE(f.valor_total, 0),
               COALESCE(f.fecha_cierre, f.fecha_creacion)::timestamp,
               f.fecha_creacion::timestamp,
               (f.estado = 'C')
          FROM parqueadero.parq_factura f
        UNION ALL
        SELECT c.id_negocio, 'reserva',
               COALESCE(c.monto_total, 0), c.fecha_creacion, c.fecha_creacion,
               (c.estado IN ('confirmada', 'completada'))
          FROM reserva.reserva_cita c
         WHERE c.estado <> 'cancelada'
        UNION ALL
        SELECT e.id_negocio, 'reserva',
               COALESCE(e.monto_total, 0), e.fecha_creacion, e.fecha_creacion,
               (e.estado IN ('confirmada', 'en_curso', 'finalizada'))
          FROM reserva.reserva_estancia e
         WHERE e.estado <> 'cancelada'
        UNION ALL
        SELECT p.id_negocio, 'gym', COALESCE(p.monto, 0), p.fecha_pago::timestamp,
               p.fecha_creacion::timestamp,
               (p.estado = 'PAGADO')
          FROM gym.gym_pago p
        UNION ALL
        SELECT v.id_negocio, 'gym', COALESCE(v.total, 0), v.fecha_venta::timestamp,
               v.fecha_creacion::timestamp,
               (v.estado = 'PAGADA')
          FROM gym.gym_venta v
        UNION ALL
        SELECT v.id_negocio, 'tienda', COALESCE(v.total, 0), v.fecha_venta::timestamp,
               v.fecha_creacion::timestamp,
               (v.estado = 'COMPLETADA')
          FROM tienda.tienda_venta v
    ),
    txr AS (
        SELECT * FROM tx
         WHERE momento IS NOT NULL
           AND (CAST(:desde AS date) IS NULL OR momento::date >= CAST(:desde AS date))
           AND (CAST(:hasta AS date) IS NULL OR momento::date <= CAST(:hasta AS date))
    )`;

/** Rango de la petición, ya normalizado a lo que entiende Postgres. */
function rango(req) {
    const desde = req.query.desde ? String(req.query.desde).slice(0, 10) : null;
    const hasta = req.query.hasta ? String(req.query.hasta).slice(0, 10) : null;
    return { desde, hasta };
}

const num = (v) => Number(v ?? 0);

async function getPlataforma(req, res) {
    const errores = validationResult(req);
    if (!errores.isEmpty()) {
        return Respuesta.error(res, 'Parámetros inválidos', 400, errores.array());
    }

    const { desde, hasta } = rango(req);
    const repl = { desde, hasta };
    const opts = { replacements: repl, type: Models.sequelize.QueryTypes.SELECT };

    try {
        // ── 1. Totales ──────────────────────────────────────────────────────────
        // Una sola consulta: son ~18 escalares y partirlos en 18 viajes a la base no haría
        // más legible nada.
        const [resumen] = await Models.sequelize.query(`
            WITH ${TX_CTE}
            SELECT
                (SELECT COUNT(*) FROM general.gener_negocio n
                  WHERE (CAST(:hasta AS date) IS NULL OR n.fecha_registro::date <= CAST(:hasta AS date))) AS negocios,
                (SELECT COUNT(*) FROM general.gener_negocio n
                  WHERE n.estado = 'A'
                    AND (CAST(:hasta AS date) IS NULL OR n.fecha_registro::date <= CAST(:hasta AS date))) AS negocios_activos,
                (SELECT COUNT(*) FROM general.gener_usuario u
                  WHERE u.estado = 'A'
                    AND (CAST(:hasta AS date) IS NULL OR u.fecha_creacion::date <= CAST(:hasta AS date))) AS usuarios,
                (SELECT COUNT(*) FROM platform.persona_negocio pn
                  WHERE (CAST(:hasta AS date) IS NULL OR pn.creado_en::date <= CAST(:hasta AS date))) AS clientes,
                (SELECT COUNT(*) FROM txr)                                                    AS transacciones,
                (SELECT COUNT(*) FROM txr WHERE cobrada)                                      AS transacciones_cobradas,
                (SELECT COALESCE(SUM(monto), 0) FROM txr WHERE cobrada)                       AS monto_cobrado,
                (SELECT COUNT(*) FROM txr WHERE vertical = 'restaurante')                     AS pedidos,
                (SELECT COALESCE(SUM(d.cantidad), 0)
                   FROM restaurante.pedid_detalle d
                   JOIN restaurante.pedid_orden o ON o.id_orden = d.id_orden
                  WHERE o.estado <> 'CANCELADA'
                    AND (CAST(:desde AS date) IS NULL
                         OR COALESCE(o.fecha_cierre, o.fecha_creacion)::date >= CAST(:desde AS date))
                    AND (CAST(:hasta AS date) IS NULL
                         OR COALESCE(o.fecha_cierre, o.fecha_creacion)::date <= CAST(:hasta AS date))) AS items_vendidos,
                (SELECT COUNT(*) FROM txr WHERE vertical = 'reserva')                         AS agendamientos,
                (SELECT COUNT(*) FROM restaurante.carta_producto)                             AS productos_catalogo,
                (SELECT COUNT(*) FROM reserva.reserva_servicio)                               AS servicios_catalogo,
                (SELECT COUNT(*) FROM intelligence.mensaje m
                  WHERE (CAST(:desde AS date) IS NULL OR m.creado_en::date >= CAST(:desde AS date))
                    AND (CAST(:hasta AS date) IS NULL OR m.creado_en::date <= CAST(:hasta AS date))) AS mensajes_asistente,
                (SELECT COUNT(*) FROM intelligence.conversacion)                              AS conversaciones,
                (SELECT COUNT(*) FROM auditoria.audit_evento e
                  WHERE e.modulo = 'auth' AND e.accion = 'login_ok'
                    AND (CAST(:desde AS date) IS NULL OR e.fecha::date >= CAST(:desde AS date))
                    AND (CAST(:hasta AS date) IS NULL OR e.fecha::date <= CAST(:hasta AS date))) AS sesiones,
                (SELECT MIN(n.fecha_registro)::date FROM general.gener_negocio n)              AS inicio_operacion,
                (SELECT MIN(momento)::date FROM tx)                                           AS primera_transaccion,
                (SELECT MAX(momento)::date FROM tx)                                           AS ultima_transaccion
        `, opts);

        // ── 2. Serie mensual: el crecimiento, que es la gráfica que cuenta la historia ──
        const serie = await Models.sequelize.query(`
            WITH ${TX_CTE}
            SELECT to_char(date_trunc('month', momento), 'YYYY-MM')       AS mes,
                   COUNT(*)                                               AS transacciones,
                   COALESCE(SUM(monto) FILTER (WHERE cobrada), 0)          AS monto,
                   COUNT(*) FILTER (WHERE vertical = 'restaurante')        AS pedidos,
                   COUNT(*) FILTER (WHERE vertical = 'reserva')            AS agendamientos,
                   COUNT(DISTINCT id_negocio)                              AS negocios
              FROM txr
             GROUP BY 1
             ORDER BY 1
        `, opts);

        // ── 3. Altas de negocios por mes (nuevos + acumulado) ──────────────────
        const altas = await Models.sequelize.query(`
            SELECT to_char(date_trunc('month', fecha_registro), 'YYYY-MM') AS mes,
                   COUNT(*)                                                AS nuevos,
                   SUM(COUNT(*)) OVER (ORDER BY date_trunc('month', fecha_registro)) AS acumulado
              FROM general.gener_negocio
             WHERE (CAST(:hasta AS date) IS NULL OR fecha_registro::date <= CAST(:hasta AS date))
             GROUP BY date_trunc('month', fecha_registro)
             ORDER BY 1
        `, opts);

        // ── 4. Reparto por vertical ────────────────────────────────────────────
        // `negocios` sale de gener_negocio y no de las transacciones: un inquilino recién
        // registrado cuenta como cliente aunque todavía no haya facturado nada.
        //
        // El vertical de un inquilino es el APLICATIVO que lo atiende: un oficio apunta al suyo
        // por `id_tipo_modulo` (PIZZERIA → RESTAURANTE) y el aplicativo que no se apunta a sí
        // mismo se atiende solo (RESERVA, ver tipoNegocioDao).
        //
        // La traducción va por NOMBRE del aplicativo y no por su id: los ids de
        // `gener_tipo_negocio` no coinciden entre desarrollo y producción —ese catálogo se ha
        // ido llenando por separado—, y con ids a mano la gráfica contaba un vertical como otro.
        // Los cinco nombres sí son constantes sembradas.
        const verticales = await Models.sequelize.query(`
            WITH ${TX_CTE},
            act AS (
                SELECT vertical, COUNT(*) AS transacciones,
                       COALESCE(SUM(monto) FILTER (WHERE cobrada), 0) AS monto
                  FROM txr GROUP BY 1
            ),
            neg AS (
                SELECT CASE UPPER(TRIM(COALESCE(tm.nombre, t.nombre)))
                           WHEN 'RESTAURANTE' THEN 'restaurante'
                           WHEN 'PARQUEADERO' THEN 'parqueadero'
                           WHEN 'GIMNASIO'    THEN 'gym'
                           WHEN 'TIENDA'      THEN 'tienda'
                           WHEN 'RESERVA'     THEN 'reserva'
                           ELSE 'otro'
                       END AS vertical,
                       COUNT(*) AS negocios
                  FROM general.gener_negocio n
                  JOIN general.gener_tipo_negocio t ON t.id_tipo_negocio = n.id_tipo_negocio
                  LEFT JOIN general.gener_tipo_negocio tm
                         ON tm.id_tipo_negocio = t.id_tipo_modulo
                 WHERE n.estado = 'A'
                 GROUP BY 1
            )
            SELECT COALESCE(neg.vertical, act.vertical) AS vertical,
                   COALESCE(neg.negocios, 0)            AS negocios,
                   COALESCE(act.transacciones, 0)       AS transacciones,
                   COALESCE(act.monto, 0)               AS monto
              FROM neg FULL OUTER JOIN act ON act.vertical = neg.vertical
             ORDER BY 3 DESC, 1
        `, opts);

        // ── 5. Ritmo de uso: por hora del día y por día de semana ──────────────
        // Dice algo que ningún total dice: que el sistema se usa en el horario real del negocio,
        // no a ratos. Va por `creado` y no por `momento` — ver la nota de TX_CTE.
        const porHora = await Models.sequelize.query(`
            WITH ${TX_CTE}
            SELECT EXTRACT(HOUR FROM creado)::int AS hora, COUNT(*) AS transacciones
              FROM txr WHERE creado IS NOT NULL GROUP BY 1 ORDER BY 1
        `, opts);

        const porDia = await Models.sequelize.query(`
            WITH ${TX_CTE}
            SELECT EXTRACT(ISODOW FROM creado)::int AS dia, COUNT(*) AS transacciones
              FROM txr WHERE creado IS NOT NULL GROUP BY 1 ORDER BY 1
        `, opts);

        // ── 6. Los negocios que más mueven ─────────────────────────────────────
        const topNegocios = await Models.sequelize.query(`
            WITH ${TX_CTE}
            SELECT n.id_negocio, n.nombre, t.nombre AS tipo,
                   COUNT(*)                                           AS transacciones,
                   COALESCE(SUM(txr.monto) FILTER (WHERE cobrada), 0) AS monto,
                   MIN(txr.momento)::date                             AS desde
              FROM txr
              JOIN general.gener_negocio n ON n.id_negocio = txr.id_negocio
              LEFT JOIN general.gener_tipo_negocio t ON t.id_tipo_negocio = n.id_tipo_negocio
             GROUP BY n.id_negocio, n.nombre, t.nombre
             ORDER BY 4 DESC
             LIMIT 10
        `, opts);

        const totalCobradas = num(resumen.transacciones_cobradas);
        const montoCobrado = num(resumen.monto_cobrado);

        // Cuántos aplicativos tienen al menos un inquilino. Se cuenta sobre el mismo reparto que
        // dibuja la gráfica y no con un COUNT DISTINCT aparte: así la cifra del titular y las
        // porciones del anillo no pueden discrepar.
        const verticalesActivos = verticales.filter((v) => num(v.negocios) > 0).length;

        return Respuesta.success(res, 'Estadísticas de plataforma obtenidas', {
            periodo: {
                desde,
                hasta,
                inicio_operacion: resumen.inicio_operacion,
                primera_transaccion: resumen.primera_transaccion,
                ultima_transaccion: resumen.ultima_transaccion,
            },
            resumen: {
                negocios: num(resumen.negocios),
                negocios_activos: num(resumen.negocios_activos),
                verticales: verticalesActivos,
                usuarios: num(resumen.usuarios),
                clientes: num(resumen.clientes),
                transacciones: num(resumen.transacciones),
                transacciones_cobradas: totalCobradas,
                monto_cobrado: montoCobrado,
                ticket_promedio: totalCobradas > 0 ? Math.round(montoCobrado / totalCobradas) : 0,
                pedidos: num(resumen.pedidos),
                items_vendidos: num(resumen.items_vendidos),
                agendamientos: num(resumen.agendamientos),
                productos_catalogo: num(resumen.productos_catalogo),
                servicios_catalogo: num(resumen.servicios_catalogo),
                mensajes_asistente: num(resumen.mensajes_asistente),
                conversaciones: num(resumen.conversaciones),
                sesiones: num(resumen.sesiones),
            },
            serie_mensual: serie.map((r) => ({
                mes: r.mes,
                transacciones: num(r.transacciones),
                monto: num(r.monto),
                pedidos: num(r.pedidos),
                agendamientos: num(r.agendamientos),
                negocios: num(r.negocios),
            })),
            altas_negocios: altas.map((r) => ({
                mes: r.mes,
                nuevos: num(r.nuevos),
                acumulado: num(r.acumulado),
            })),
            verticales: verticales.map((r) => ({
                vertical: r.vertical,
                negocios: num(r.negocios),
                transacciones: num(r.transacciones),
                monto: num(r.monto),
            })),
            por_hora: porHora.map((r) => ({
                hora: num(r.hora),
                transacciones: num(r.transacciones),
            })),
            por_dia_semana: porDia.map((r) => ({
                dia: num(r.dia),
                transacciones: num(r.transacciones),
            })),
            top_negocios: topNegocios.map((r) => ({
                id_negocio: num(r.id_negocio),
                nombre: r.nombre,
                tipo: r.tipo,
                transacciones: num(r.transacciones),
                monto: num(r.monto),
                desde: r.desde,
            })),
        });
    } catch (error) {
        console.error('Error en getPlataforma (estadísticas):', error);
        return Respuesta.error(res, 'Error al obtener las estadísticas de la plataforma');
    }
}

module.exports = { getPlataforma };
