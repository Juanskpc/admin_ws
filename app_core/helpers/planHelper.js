'use strict';
const Models = require('../models/conection');
const { Op } = Models.Sequelize;

/**
 * planHelper — Estado del plan de un negocio.
 *
 * Un plan vencido NO cierra el sistema de inmediato: hay un **periodo de gracia**
 * de {@link DIAS_GRACIA_PLAN} días contados desde `fecha_fin`. Durante esa ventana
 * el negocio sigue trabajando con normalidad y las apps le muestran un aviso
 * («tienes N días para pagar»). Pasada la gracia, el acceso se bloquea como antes.
 *
 * El motivo es comercial: cortarle la operación a un restaurante el mismo día del
 * vencimiento es perder al cliente por un pago que casi siempre llega con un día
 * de retraso. El aviso anticipado le da margen para actualizar su pago.
 *
 * Estados posibles (`estado`):
 *   ACTIVO   — plan vigente (`fecha_inicio <= hoy <= fecha_fin`, o sin `fecha_fin`).
 *   GRACIA   — venció, pero aún está dentro de los días de gracia. Sigue operando.
 *   VENCIDO  — venció y se agotó la gracia. Acceso bloqueado.
 *   SIN_PLAN — el negocio nunca tuvo un plan activo.
 *
 * `activo` es lo único que miran los guardias de acceso: vale `true` en ACTIVO y
 * en GRACIA.
 */

/** Días que el negocio puede seguir operando después de que venza su plan. */
const DIAS_GRACIA_PLAN = 5;

const MS_DIA = 86400000;

/** El instante en que se acaba la gracia de un plan (`null` si no tiene fecha de fin). */
function calcularLimiteGracia(fechaFin) {
    if (!fechaFin) return null;
    return new Date(new Date(fechaFin).getTime() + DIAS_GRACIA_PLAN * MS_DIA);
}

/** Estado de «no hay plan», para negocios sin ninguna fila activa. */
function estadoSinPlan() {
    return {
        estado: 'SIN_PLAN',
        activo: false,
        en_gracia: false,
        dias_gracia_restantes: null,
        fecha_fin: null,
        fecha_limite_gracia: null,
    };
}

/**
 * Traduce una fila de `gener_negocio_plan` al estado que entienden las apps.
 * @param {{fecha_inicio: Date|string|null, fecha_fin: Date|string|null}} row
 * @param {Date} ahora
 */
function evaluarPlan(row, ahora = new Date()) {
    if (!row) return estadoSinPlan();

    const inicio = row.fecha_inicio ? new Date(row.fecha_inicio) : null;
    const fin = row.fecha_fin ? new Date(row.fecha_fin) : null;

    // Un plan que todavía no empieza no habilita nada.
    if (inicio && inicio > ahora) return estadoSinPlan();

    if (!fin || fin >= ahora) {
        return {
            estado: 'ACTIVO',
            activo: true,
            en_gracia: false,
            dias_gracia_restantes: null,
            fecha_fin: row.fecha_fin ?? null,
            fecha_limite_gracia: null,
        };
    }

    const limite = calcularLimiteGracia(fin);
    const enGracia = limite > ahora;

    return {
        estado: enGracia ? 'GRACIA' : 'VENCIDO',
        activo: enGracia,
        en_gracia: enGracia,
        // Se redondea hacia arriba: al día siguiente del vencimiento quedan 4 días,
        // y el último día de gracia muestra 1 (nunca 0 mientras todavía se pueda usar).
        dias_gracia_restantes: enGracia
            ? Math.max(1, Math.ceil((limite - ahora) / MS_DIA))
            : 0,
        fecha_fin: row.fecha_fin ?? null,
        fecha_limite_gracia: limite,
    };
}

/**
 * Fila de plan que manda para cada negocio: entre todas las activas ya iniciadas,
 * la que llega más lejos en el tiempo (`fecha_fin` mayor, o sin fecha de fin).
 *
 * Ordenar por `fecha_inicio` no basta: un negocio que renueva antes de tiempo tiene
 * dos filas vigentes y la más reciente puede terminar antes que la anterior.
 */
async function getFilasPlanVigentes(idNegocios, ahora) {
    const rows = await Models.GenerNegocioPlan.findAll({
        where: {
            id_negocio: { [Op.in]: idNegocios },
            estado: 'A',
            fecha_inicio: { [Op.lte]: ahora },
        },
        attributes: ['id_negocio', 'fecha_inicio', 'fecha_fin'],
        order: [
            [Models.Sequelize.literal('fecha_fin IS NULL'), 'DESC'],
            ['fecha_fin', 'DESC'],
            ['fecha_inicio', 'DESC'],
        ],
    });

    const map = new Map();
    for (const row of rows) {
        if (!map.has(row.id_negocio)) map.set(row.id_negocio, row);
    }
    return map;
}

/**
 * Estado del plan de varios negocios.
 * @param {number[]} idNegocios
 * @returns {Promise<Map<number, object>>} id_negocio → estado (ver evaluarPlan)
 */
async function getEstadosPlanPorNegocio(idNegocios) {
    const ids = [...new Set((idNegocios || []).map(Number).filter(Boolean))];
    const estados = new Map();
    if (ids.length === 0) return estados;

    const ahora = new Date();
    const filas = await getFilasPlanVigentes(ids, ahora);

    for (const id of ids) {
        estados.set(id, evaluarPlan(filas.get(id) || null, ahora));
    }
    return estados;
}

/**
 * Estado del plan de un negocio. Es lo que deben usar los controladores para
 * poblar la sesión: trae `activo` (¿puede entrar?) y el detalle de la gracia.
 *
 * @param {number} idNegocio
 * @returns {Promise<object>} ver evaluarPlan
 */
async function getEstadoPlan(idNegocio) {
    if (!idNegocio) return estadoSinPlan();
    const estados = await getEstadosPlanPorNegocio([idNegocio]);
    return estados.get(Number(idNegocio)) || estadoSinPlan();
}

/**
 * ¿El negocio puede operar? Incluye los días de gracia posteriores al vencimiento.
 *
 * @param {number} idNegocio
 * @returns {Promise<boolean>}
 */
async function tienePlanActivo(idNegocio) {
    if (!idNegocio) return false;
    const estado = await getEstadoPlan(idNegocio);
    return estado.activo;
}

/**
 * Para una lista de IDs de negocio, devuelve un Set con los que pueden operar
 * (plan vigente o dentro de la gracia).
 *
 * @param {number[]} idNegocios
 * @returns {Promise<Set<number>>}
 */
async function getIdsConPlanActivo(idNegocios) {
    const estados = await getEstadosPlanPorNegocio(idNegocios);
    const ids = new Set();
    for (const [id, estado] of estados) {
        if (estado.activo) ids.add(id);
    }
    return ids;
}

/**
 * Para una lista de IDs de negocio, devuelve un Map id_negocio → info del plan
 * más reciente y activo de ese negocio (o sin entrada si no tiene plan).
 *
 * La forma del plan coincide con la usada por getMisNegociosPlanInfo:
 *   { id_plan, nombre, precio, moneda, fecha_inicio, fecha_fin, vigente, dias_restantes,
 *     estado, en_gracia, dias_gracia_restantes }
 *
 * `vigente` sigue significando «dentro de fechas»: un plan en gracia es `vigente:false`
 * con `en_gracia:true`.
 *
 * @param {number[]} idNegocios
 * @returns {Promise<Map<number, object>>}
 */
async function getPlanesActivosPorNegocio(idNegocios) {
    const ids = [...new Set((idNegocios || []).map(Number).filter(Boolean))];
    if (ids.length === 0) return new Map();

    const now = new Date();
    const rows = await Models.GenerNegocioPlan.findAll({
        where: {
            id_negocio: { [Op.in]: ids },
            estado: 'A',
        },
        include: [{ model: Models.GenerPlan }],
        order: [['fecha_inicio', 'DESC']],
    });

    const map = new Map();
    for (const row of rows) {
        // Como vienen ordenados por fecha_inicio DESC, el primero por negocio es el vigente.
        if (map.has(row.id_negocio)) continue;

        const p = row.GenerPlan;
        const inicio = row.fecha_inicio ? new Date(row.fecha_inicio) : null;
        const fin = row.fecha_fin ? new Date(row.fecha_fin) : null;
        const vigente = (!inicio || inicio <= now) && (!fin || fin >= now);
        const diasRestantes = fin ? Math.ceil((fin - now) / 86400000) : null;
        const estadoPlan = evaluarPlan(row, now);

        map.set(row.id_negocio, {
            id_plan: p?.id_plan ?? null,
            nombre: p?.nombre ?? 'Sin nombre',
            precio: p ? parseFloat(p.precio) : 0,
            moneda: p?.moneda ?? 'COP',
            fecha_inicio: row.fecha_inicio,
            fecha_fin: row.fecha_fin,
            vigente,
            dias_restantes: diasRestantes,
            estado: estadoPlan.estado,
            en_gracia: estadoPlan.en_gracia,
            dias_gracia_restantes: estadoPlan.dias_gracia_restantes,
        });
    }

    return map;
}

module.exports = {
    DIAS_GRACIA_PLAN,
    evaluarPlan,
    getEstadoPlan,
    getEstadosPlanPorNegocio,
    tienePlanActivo,
    getIdsConPlanActivo,
    getPlanesActivosPorNegocio,
};
