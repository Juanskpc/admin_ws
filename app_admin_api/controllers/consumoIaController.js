'use strict';
const { validationResult } = require('express-validator');
const Respuesta = require('../../app_core/helpers/respuesta');
const Models = require('../../app_core/models/conection');
const Audit = require('../../app_core/helpers/auditHelper');
const Consumo = require('../services/consumoIaService');

/**
 * Consumo IA — cuánto se gasta en OpenAI, cuánto queda y en qué se va. Solo super admin.
 *
 * Junta las dos fuentes que explica `consumoIaService`: el gasto **oficial** de OpenAI (todo lo
 * que cobra) y el **interno** del Ledger (solo el bot, pero repartido por negocio y modelo).
 * Si OpenAI no contesta, la pantalla sigue en pie con la fuente interna y lo dice: una vista de
 * gasto que se cae justo cuando OpenAI falla es la que no sirve el día que importa.
 *
 * Los días van en **UTC**, como los cuenta OpenAI, también en la fuente interna: así las dos
 * barras del mismo día son comparables. El día se corta a las 7 p.m. de Colombia.
 *
 * Como la Consola de Intelligence, lee `intelligence.costo` con SQL y no importa `intelligence/`.
 */

const PROVEEDOR = 'openai';
const VENTANAS = [7, 30, 90];

async function hayEsquemaIntelligence() {
    const filas = await Models.sequelize.query(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'intelligence' LIMIT 1;`,
        { type: Models.sequelize.QueryTypes.SELECT }
    );
    return filas.length > 0;
}

async function listarMovimientos() {
    return Models.sequelize.query(
        `SELECT r.id_recarga, r.tipo, r.monto_usd::float AS monto_usd, r.fecha, r.nota,
                r.creado_en,
                NULLIF(TRIM(CONCAT(u.primer_nombre, ' ', u.primer_apellido)), '') AS registrado_por
           FROM general.gener_recarga_ia r
           LEFT JOIN general.gener_usuario u ON u.id_usuario = r.id_usuario
          WHERE r.proveedor = :proveedor AND r.estado = 'A'
          ORDER BY r.fecha DESC, r.id_recarga DESC;`,
        { replacements: { proveedor: PROVEEDOR }, type: Models.sequelize.QueryTypes.SELECT }
    );
}

/** El gasto del bot según el Ledger, desde `desdeSeg` (por día) y dentro de la ventana. */
async function gastoInterno(desdeSeg, desdeRangoSeg) {
    const q = (sql, replacements) =>
        Models.sequelize.query(sql, { replacements, type: Models.sequelize.QueryTypes.SELECT });

    const [porDia, porNegocio, porModelo, [turnos]] = await Promise.all([
        q(
            `SELECT to_char((creado_en AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS fecha,
                    SUM(costo_usd)::float AS usd
               FROM intelligence.costo
              WHERE creado_en >= to_timestamp(:desde)
              GROUP BY 1 ORDER BY 1;`,
            { desde: desdeSeg }
        ),
        q(
            `SELECT k.id_negocio, n.nombre AS negocio,
                    SUM(k.costo_usd)::float                 AS costo_usd,
                    COUNT(*)::int                           AS llamadas,
                    COUNT(DISTINCT k.id_conversacion)::int  AS conversaciones
               FROM intelligence.costo k
               LEFT JOIN general.gener_negocio n ON n.id_negocio = k.id_negocio
              WHERE k.creado_en >= to_timestamp(:desde)
              GROUP BY k.id_negocio, n.nombre
              ORDER BY costo_usd DESC;`,
            { desde: desdeRangoSeg }
        ),
        q(
            `SELECT proveedor, modelo,
                    SUM(costo_usd)::float                    AS costo_usd,
                    COUNT(*)::int                            AS llamadas,
                    SUM(tokens_entrada)::bigint::float       AS tokens_entrada,
                    SUM(tokens_salida)::bigint::float        AS tokens_salida,
                    SUM(tokens_cache_lectura)::bigint::float AS tokens_cache_lectura
               FROM intelligence.costo
              WHERE creado_en >= to_timestamp(:desde)
              GROUP BY proveedor, modelo
              ORDER BY costo_usd DESC;`,
            { desde: desdeRangoSeg }
        ),
        q(
            `SELECT COUNT(*)::int                                          AS total,
                    COUNT(*) FILTER (WHERE nivel = 'llm')::int             AS con_ia,
                    COUNT(*) FILTER (WHERE nivel = 'determinista')::int    AS sin_ia,
                    COUNT(*) FILTER (WHERE nivel = 'humano')::int          AS humano
               FROM intelligence.turno
              WHERE creado_en >= to_timestamp(:desde);`,
            { desde: desdeRangoSeg }
        ),
    ]);

    return { porDia, porNegocio, porModelo, turnos };
}

/** Rellena con ceros los días sin gasto para que la gráfica no se salte fechas. */
function serieCompleta(desdeSeg, hastaSeg, oficial, interno) {
    const mapaOficial = oficial ? new Map(oficial.map((d) => [d.fecha, d.usd])) : null;
    const mapaInterno = new Map(interno.map((d) => [d.fecha, d.usd]));
    const serie = [];
    for (let s = desdeSeg; s <= hastaSeg; s += Consumo.SEG_DIA) {
        const fecha = Consumo.fechaUtc(s);
        serie.push({
            fecha,
            oficial: mapaOficial ? Consumo.redondear(mapaOficial.get(fecha) || 0) : null,
            interno: Consumo.redondear(mapaInterno.get(fecha) || 0),
        });
    }
    return serie;
}

/**
 * GET /admin/consumo-ia?dias=7|30|90&forzar=true
 *
 * `forzar=true` se salta la caché de 10 minutos (botón «Actualizar»).
 */
async function resumen(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return Respuesta.error(res, 'Parámetros inválidos', 400, errors.array());

    try {
        const dias = VENTANAS.includes(Number(req.query.dias)) ? Number(req.query.dias) : 30;
        const forzar = req.query.forzar === 'true';

        const ahora = new Date();
        const hoySeg = Consumo.inicioDiaUtc(ahora);
        const desdeRangoSeg = hoySeg - (dias - 1) * Consumo.SEG_DIA; // la ventana incluye hoy
        const inicioMesSeg = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1) / 1000;
        const desdePromedioSeg = hoySeg - 7 * Consumo.SEG_DIA;

        const movimientos = await listarMovimientos();
        const partida = movimientos.find((m) => m.tipo === 'SALDO');

        // Una sola consulta a OpenAI que cubra todo lo que hace falta: la ventana, el mes en
        // curso, el promedio de 7 días y el gasto desde el saldo de partida.
        const desdeSeg = Math.min(
            desdeRangoSeg,
            inicioMesSeg,
            desdePromedioSeg,
            partida ? Consumo.inicioDiaUtc(partida.fecha) : Infinity
        );

        let oficial = null;
        let avisoOficial = null;
        try {
            oficial = await Consumo.consultarCostosOficiales(desdeSeg, { forzar });
        } catch (e) {
            if (!e.code) throw e;
            avisoOficial = { code: e.code, mensaje: e.message };
        }

        const hayLedger = await hayEsquemaIntelligence();
        const interno = hayLedger
            ? await gastoInterno(desdeSeg, desdeRangoSeg)
            : { porDia: [], porNegocio: [], porModelo: [], turnos: { total: 0, con_ia: 0, sin_ia: 0, humano: 0 } };

        // El saldo se calcula con la fuente oficial; si OpenAI no contesta, con la interna, y
        // la respuesta dice cuál se usó (la interna no ve el gasto que no es del bot).
        const fuente = oficial ? 'oficial' : 'interno';
        const porDiaFuente = oficial ? oficial.por_dia : interno.porDia;

        const saldo = Consumo.calcularSaldo(movimientos, porDiaFuente);
        const promedio = Consumo.promedioDiario(porDiaFuente, 7, ahora);
        const fechaHoy = Consumo.fechaUtc(hoySeg);
        const fechaMes = Consumo.fechaUtc(inicioMesSeg);
        const fechaRango = Consumo.fechaUtc(desdeRangoSeg);

        const totalInternoRango = Consumo.sumarDesde(interno.porDia, fechaRango);
        const conversacionesConIa = interno.porNegocio.reduce((s, n) => s + n.conversaciones, 0);

        return Respuesta.success(res, 'Consumo de IA', {
            periodo: { dias, desde: fechaRango, hasta: fechaHoy },
            fuente_saldo: fuente,
            aviso_oficial: avisoOficial,
            consultado_en: oficial?.consultado_en ?? null,
            saldo: saldo && {
                ...saldo,
                promedio_diario_7d: Consumo.redondear(promedio),
                dias_restantes: Consumo.diasRestantes(saldo.saldo_estimado, promedio),
            },
            promedio_diario_7d: Consumo.redondear(promedio),
            resumen: {
                hoy: Consumo.redondear(Consumo.sumarDesde(porDiaFuente, fechaHoy)),
                mes: Consumo.redondear(Consumo.sumarDesde(porDiaFuente, fechaMes)),
                periodo_oficial: oficial
                    ? Consumo.redondear(Consumo.sumarDesde(oficial.por_dia, fechaRango))
                    : null,
                periodo_interno: Consumo.redondear(totalInternoRango),
                proyeccion_mes: Consumo.redondear(promedio * 30),
            },
            serie: serieCompleta(
                desdeRangoSeg,
                hoySeg,
                oficial && oficial.por_dia,
                interno.porDia
            ),
            por_concepto: oficial
                ? (await Consumo.consultarCostosOficiales(desdeRangoSeg)).por_concepto.map((c) => ({
                      concepto: c.concepto,
                      usd: Consumo.redondear(c.usd),
                  }))
                : [],
            por_negocio: interno.porNegocio.map((n) => ({
                ...n,
                costo_usd: Consumo.redondear(n.costo_usd),
                costo_por_conversacion: n.conversaciones
                    ? Consumo.redondear(n.costo_usd / n.conversaciones)
                    : 0,
            })),
            por_modelo: interno.porModelo.map((m) => ({
                ...m,
                costo_usd: Consumo.redondear(m.costo_usd),
            })),
            conversaciones: {
                con_ia: conversacionesConIa,
                costo_promedio: conversacionesConIa
                    ? Consumo.redondear(totalInternoRango / conversacionesConIa)
                    : 0,
            },
            turnos: interno.turnos,
            movimientos,
        });
    } catch (error) {
        return Respuesta.error(res, `Error al consultar el consumo de IA: ${error.message}`, 500);
    }
}

/**
 * POST /admin/consumo-ia/movimientos
 * Body: { tipo: 'SALDO'|'RECARGA', monto_usd, fecha?, nota? }
 *
 * `fecha` llega como la escribe un `<input type="datetime-local">` —hora de Colombia, sin
 * zona— y se guarda tal cual, que es como se guardan las fechas en esta base.
 */
async function registrarMovimiento(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return Respuesta.error(res, 'Datos inválidos', 400, errors.array());

    const { tipo, monto_usd: monto, nota } = req.body;
    const fecha = req.body.fecha || null;

    if (tipo === 'RECARGA' && Number(monto) <= 0) {
        return Respuesta.error(res, 'Una recarga tiene que ser mayor que cero', 400);
    }

    const t = await Models.sequelize.transaction();
    try {
        const [fila] = await Models.sequelize.query(
            `INSERT INTO general.gener_recarga_ia (proveedor, tipo, monto_usd, fecha, nota, id_usuario)
             VALUES (:proveedor, :tipo, :monto, COALESCE(:fecha::timestamp, now()), :nota, :idUsuario)
             RETURNING id_recarga, tipo, monto_usd::float AS monto_usd, fecha, nota,
                       (fecha > now() + interval '5 minutes') AS en_el_futuro;`,
            {
                replacements: {
                    proveedor: PROVEEDOR,
                    tipo,
                    monto: Number(monto).toFixed(2),
                    fecha,
                    nota: nota?.trim() || null,
                    idUsuario: req.usuario?.id_usuario ?? null,
                },
                type: Models.sequelize.QueryTypes.SELECT,
                transaction: t,
            }
        );

        if (fila.en_el_futuro) {
            await t.rollback();
            return Respuesta.error(res, 'La fecha no puede ser futura', 400);
        }

        await Audit.registrarEvento({
            modulo: 'consumo_ia',
            accion: tipo === 'SALDO' ? 'saldo_registrado' : 'recarga_registrada',
            idUsuario: req.usuario?.id_usuario ?? null,
            ip: req.ip,
            detalle: { id_recarga: fila.id_recarga, monto_usd: fila.monto_usd, fecha: fila.fecha },
            transaction: t,
        });

        await t.commit();
        delete fila.en_el_futuro;
        return Respuesta.success(
            res,
            tipo === 'SALDO' ? 'Saldo de partida registrado' : 'Recarga registrada',
            fila,
            201
        );
    } catch (error) {
        await t.rollback();
        return Respuesta.error(res, `Error al registrar el movimiento: ${error.message}`, 500);
    }
}

/** DELETE /admin/consumo-ia/movimientos/:id — anula (estado 'E'), nunca borra. */
async function anularMovimiento(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return Respuesta.error(res, 'Datos inválidos', 400, errors.array());

    const t = await Models.sequelize.transaction();
    try {
        const [fila] = await Models.sequelize.query(
            `UPDATE general.gener_recarga_ia SET estado = 'E'
              WHERE id_recarga = :id AND proveedor = :proveedor AND estado = 'A'
              RETURNING id_recarga, tipo, monto_usd::float AS monto_usd, fecha;`,
            {
                replacements: { id: Number(req.params.id), proveedor: PROVEEDOR },
                type: Models.sequelize.QueryTypes.SELECT,
                transaction: t,
            }
        );
        if (!fila) {
            await t.rollback();
            return Respuesta.error(res, 'Movimiento no encontrado', 404);
        }

        await Audit.registrarEvento({
            modulo: 'consumo_ia',
            accion: 'movimiento_anulado',
            idUsuario: req.usuario?.id_usuario ?? null,
            ip: req.ip,
            detalle: fila,
            transaction: t,
        });

        await t.commit();
        return Respuesta.success(res, 'Movimiento anulado', fila);
    } catch (error) {
        await t.rollback();
        return Respuesta.error(res, `Error al anular el movimiento: ${error.message}`, 500);
    }
}

module.exports = { resumen, registrarMovimiento, anularMovimiento };
