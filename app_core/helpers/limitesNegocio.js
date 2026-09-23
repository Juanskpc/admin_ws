/**
 * limitesNegocio — cuánto puede usar un negocio: lo que trae su plan más sus complementos.
 *
 * Es la respuesta única a «¿cuántos usuarios / cajas puede tener este negocio?» para cualquier
 * proyecto (restaurante, reserva, la consola). Hoy **nadie la hace cumplir** todavía: se deja
 * lista para que las validaciones de cada vertical pregunten aquí y no reimplementen la suma.
 *
 *   usuarios = gener_plan.usuarios_incluidos + Σ cantidades de complementos que amplían 'usuarios'
 *   cajas    = gener_plan.cajas_incluidas    + Σ cantidades de complementos que amplían 'cajas'
 *
 * El plan que cuenta es el **vigente** (`gener_negocio_plan` activo y sin vencer) — un negocio
 * con el plan vencido no tiene límites porque no tiene acceso. `incluidos = null` en el plan
 * significa «sin límite» y se propaga como `total = null`.
 *
 * Ver migrations/migrate_cobranza_complementos.js.
 */
'use strict';
const Models = require('../models/conection');

const sequelize = Models.sequelize;

/**
 * @returns {Promise<null | {
 *   id_plan: number, plan: string,
 *   usuarios: { incluidos: number|null, adicionales: number, total: number|null },
 *   cajas:    { incluidos: number|null, adicionales: number, total: number|null },
 * }>} null si el negocio no tiene plan vigente.
 */
async function getLimitesNegocio(idNegocio, { transaction } = {}) {
    const [plan] = await sequelize.query(
        `SELECT p.id_plan, p.nombre, p.usuarios_incluidos, p.cajas_incluidas
           FROM general.gener_negocio_plan np
           JOIN general.gener_plan p ON p.id_plan = np.id_plan
          WHERE np.id_negocio = :idNegocio
            AND np.estado = 'A'
            AND (np.fecha_fin IS NULL OR np.fecha_fin >= now())
          ORDER BY np.fecha_fin DESC NULLS FIRST
          LIMIT 1;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT, transaction }
    );
    if (!plan) return null;

    const complementos = await sequelize.query(
        `SELECT c.amplia, SUM(sc.cantidad)::int AS cantidad
           FROM cobranza.cob_suscripcion_complemento sc
           JOIN cobranza.cob_complemento c ON c.id_complemento = sc.id_complemento
          WHERE sc.id_negocio = :idNegocio AND sc.estado = 'A' AND c.amplia IS NOT NULL
          GROUP BY c.amplia;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT, transaction }
    );
    const adicional = (amplia) => complementos.find((c) => c.amplia === amplia)?.cantidad ?? 0;

    const limite = (incluidos, amplia) => {
        const adicionales = adicional(amplia);
        return {
            incluidos: incluidos ?? null,
            adicionales,
            total: incluidos == null ? null : incluidos + adicionales,
        };
    };

    return {
        id_plan: plan.id_plan,
        plan: plan.nombre,
        usuarios: limite(plan.usuarios_incluidos, 'usuarios'),
        cajas: limite(plan.cajas_incluidas, 'cajas'),
    };
}

module.exports = { getLimitesNegocio };
