'use strict';
const Respuesta = require('../../app_core/helpers/respuesta');
const Models = require('../../app_core/models/conection');

/**
 * Variación porcentual hoy vs ayer (1 decimal). null si ayer = 0
 * (evita divisiones por cero y tendencias engañosas).
 */
function tendencia(hoy, ayer) {
    if (!ayer || ayer === 0) return null;
    return Math.round(((hoy - ayer) / ayer) * 1000) / 10;
}

/**
 * Resumen de métricas cross-vertical de la plataforma (Super Admin).
 * GET /admin/metricas/resumen
 *
 * Suma transacciones e ingresos del día (y de ayer) sumando las ventas
 * pagadas de cada vertical:
 *   restaurante.pedid_orden (estado_pago='pagado')
 *   parqueadero.parq_factura (estado='C')
 *   gym.gym_pago (estado='PAGADO') · gym.gym_venta (estado='PAGADA')
 *   tienda.tienda_venta (estado='COMPLETADA')
 *
 * Las fechas se truncan en zona America/Bogota (TZ de la sesión Postgres).
 */
async function getResumen(req, res) {
    try {
        const [[dia]] = await Models.sequelize.query(`
            WITH tx AS (
                SELECT id_negocio, total AS monto, COALESCE(fecha_cierre, fecha_creacion)::date AS dia
                  FROM restaurante.pedid_orden WHERE estado_pago = 'pagado'
                UNION ALL
                SELECT id_negocio, valor_total, COALESCE(fecha_cierre, fecha_creacion)::date
                  FROM parqueadero.parq_factura WHERE estado = 'C'
                UNION ALL
                SELECT id_negocio, monto, fecha_pago::date FROM gym.gym_pago WHERE estado = 'PAGADO'
                UNION ALL
                SELECT id_negocio, total, fecha_venta::date FROM gym.gym_venta WHERE estado = 'PAGADA'
                UNION ALL
                SELECT id_negocio, total, fecha_venta::date FROM tienda.tienda_venta WHERE estado = 'COMPLETADA'
            )
            SELECT
                COUNT(*) FILTER (WHERE dia = CURRENT_DATE)                              AS tx_hoy,
                COUNT(*) FILTER (WHERE dia = CURRENT_DATE - 1)                          AS tx_ayer,
                COALESCE(SUM(monto) FILTER (WHERE dia = CURRENT_DATE), 0)               AS ing_hoy,
                COALESCE(SUM(monto) FILTER (WHERE dia = CURRENT_DATE - 1), 0)           AS ing_ayer,
                COUNT(DISTINCT id_negocio) FILTER (WHERE dia = CURRENT_DATE)            AS neg_hoy,
                COUNT(DISTINCT id_negocio) FILTER (WHERE dia = CURRENT_DATE - 1)        AS neg_ayer
            FROM tx
            WHERE dia IN (CURRENT_DATE, CURRENT_DATE - 1);
        `);

        const [[conv]] = await Models.sequelize.query(`
            SELECT
                (SELECT COUNT(*) FROM general.gener_negocio WHERE estado = 'A') AS total_negocios,
                (SELECT COUNT(DISTINCT np.id_negocio)
                   FROM general.gener_negocio_plan np
                   JOIN general.gener_negocio n ON n.id_negocio = np.id_negocio AND n.estado = 'A'
                  WHERE np.estado = 'A' AND np.fecha_inicio <= NOW()
                    AND (np.fecha_fin IS NULL OR np.fecha_fin >= NOW())) AS negocios_pagados;
        `);

        const txHoy = Number(dia.tx_hoy);
        const txAyer = Number(dia.tx_ayer);
        const ingHoy = Number(dia.ing_hoy);
        const ingAyer = Number(dia.ing_ayer);
        const negHoy = Number(dia.neg_hoy);
        const negAyer = Number(dia.neg_ayer);

        const total = Number(conv.total_negocios);
        const pagados = Number(conv.negocios_pagados);
        const tasa = total > 0 ? Math.round((pagados / total) * 1000) / 10 : 0;

        return Respuesta.success(res, 'Métricas obtenidas', {
            negocios_activos: { valor: negHoy, ayer: negAyer, tendencia: tendencia(negHoy, negAyer) },
            ingresos:         { valor: ingHoy, ayer: ingAyer, tendencia: tendencia(ingHoy, ingAyer) },
            transacciones:    { valor: txHoy, ayer: txAyer, tendencia: tendencia(txHoy, txAyer) },
            conversion:       { valor: tasa, pagados, total, tendencia: null },
        });
    } catch (error) {
        console.error('Error en getResumen (métricas):', error);
        return Respuesta.error(res, 'Error al obtener las métricas');
    }
}

module.exports = { getResumen };
