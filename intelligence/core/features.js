/**
 * Costura de entitlements (ADR-021).
 *
 * ## La regla
 *
 * Nadie consulta el plan. Todo el mundo pregunta `estaHabilitado(id_negocio, feature)`.
 * El error clásico de SaaS es sembrar `if (plan === 'avanzado')` por el código: el día que
 * marketing mueve una feature de plan, o renombra uno, hay que tocar veinte sitios y la
 * lógica de negocio queda atada al catálogo comercial.
 *
 * ## Por qué el mapeo es una constante y no una tabla
 *
 * ADR-021 lo autoriza expresamente ("el mapeo plan → conjunto-de-features más simple
 * posible, incluso una tabla estática al inicio") y freeze.md §D.6 lo remata: features es
 * una **costura**, no un dominio pesado. Lo que importa es que todos pregunten por
 * `estaHabilitado`, no que exista un CRUD de features.
 *
 * Cuando ventas pida overrides, trials por-feature o add-ons, se modela detrás de esta
 * misma función y ningún consumidor se entera. Ése es justamente el punto de la costura.
 *
 * ## Distinción que la gente confunde (ADR-021)
 *
 *   Feature      → interruptor COMERCIAL  (¿el plan incluye el recepcionista IA?)
 *   Capacidad    → permiso de DOMINIO     (¿puede ejecutar `reservar_turno`?)
 *   Business Policy → límite ECONÓMICO    (¿hasta qué descuento?)
 *
 * Son tres capas distintas y el Policy Gate las consulta en ese orden. Feature ≠ Capacidad.
 */
'use strict';
const Models = require('../../app_core/models/conection');

/** Features conocidas. Se nombran en español salvo las siglas ya establecidas. */
const FEATURE = {
    /** El asistente conversacional existe para este negocio. Lo exige toda capacidad. */
    ASISTENTE_IA: 'asistente_ia',
};

/**
 * Mapeo plan → features. Deliberadamente una constante.
 *
 * Hoy ningún plan comercial incluye el asistente: todavía no se vende. En local se abre
 * con `FEATURES_FORZADAS` (ver abajo), que es lo que permite ejercitar F4 sin inventarse
 * un plan que no existe.
 */
const FEATURES_POR_PLAN = {
    'Plan Básico': [],
    'Plan Avanzado': [],
};

/**
 * Escotilla de desarrollo: `FEATURES_FORZADAS=asistente_ia` enciende features sin tocar el
 * catálogo comercial.
 *
 * Está acotada a entornos no productivos **a propósito**. Una variable de entorno que
 * pudiera regalar features de pago en producción no es una escotilla de desarrollo: es un
 * agujero de facturación esperando a que alguien copie un `.env`.
 */
const FORZADAS = new Set(
    process.env.NODE_ENV === 'production'
        ? []
        : String(process.env.FEATURES_FORZADAS || '')
              .split(',')
              .map((f) => f.trim())
              .filter(Boolean)
);

/** Devuelve el nombre del plan activo del negocio, o `null` si no tiene ninguno. */
async function planActivo(idNegocio) {
    const [fila] = await Models.sequelize.query(
        `
        SELECT p.nombre
          FROM general.gener_negocio_plan np
          JOIN general.gener_plan p ON p.id_plan = np.id_plan AND p.estado = 'A'
         WHERE np.id_negocio = :idNegocio
           AND np.estado = 'A'
           AND (np.fecha_fin IS NULL OR np.fecha_fin >= CURRENT_DATE)
         ORDER BY np.fecha_inicio DESC
         LIMIT 1;
        `,
        { replacements: { idNegocio }, type: Models.sequelize.QueryTypes.SELECT }
    );
    return fila ? fila.nombre : null;
}

/**
 * ¿Tiene este negocio derecho a esta feature?
 *
 * Es la única pregunta que el resto del sistema puede hacer sobre lo comercial.
 */
async function estaHabilitado(idNegocio, feature) {
    if (FORZADAS.has(feature)) return true;

    const plan = await planActivo(idNegocio);
    if (!plan) return false;

    return (FEATURES_POR_PLAN[plan] || []).includes(feature);
}

/** Para diagnóstico y para la CLI: por qué la respuesta fue la que fue. */
async function explicar(idNegocio, feature) {
    if (FORZADAS.has(feature)) {
        return { habilitado: true, motivo: `forzada por FEATURES_FORZADAS (${process.env.NODE_ENV || 'sin NODE_ENV'})` };
    }
    const plan = await planActivo(idNegocio);
    if (!plan) return { habilitado: false, motivo: 'el negocio no tiene plan activo' };

    const incluida = (FEATURES_POR_PLAN[plan] || []).includes(feature);
    return {
        habilitado: incluida,
        motivo: incluida ? `incluida en "${plan}"` : `"${plan}" no incluye "${feature}"`,
    };
}

module.exports = { estaHabilitado, explicar, planActivo, FEATURE, FEATURES_POR_PLAN };
