'use strict';
const Models = require('../models/conection');
const { getPlanesActivosPorNegocio } = require('./planHelper');

/**
 * Qué incluye el plan de un negocio.
 *
 * `planHelper` responde si un negocio tiene plan; esto responde qué trae ese plan. Los valores
 * salen de `general.gener_plan_caracteristica`, así que cambiar la oferta comercial es un UPDATE y
 * no un despliegue.
 *
 * ## Por qué los valores por defecto son permisivos
 *
 * Una característica sin fila —un plan nuevo que nadie sembró, o una base local sin la migración—
 * se lee como **incluida**. Lo contrario convierte un olvido administrativo en un botón de pedido
 * que desaparece de la carta de un cliente que paga, y ese fallo no avisa: simplemente deja de
 * llegar pedidos.
 */

const POR_DEFECTO = Object.freeze({
    carta_whatsapp: 'true',
    carta_plantillas: '*',
    carta_color_libre: 'true',
});

function esTablaInexistente(err) {
    const code = err?.parent?.code || err?.original?.code;
    return code === '42P01';
}

function aBooleano(valor) {
    return String(valor).trim().toLowerCase() === 'true';
}

/** `'*'` o una lista: `'esencial, papel'` → `['esencial', 'papel']`. */
function aLista(valor) {
    const texto = String(valor ?? '').trim();
    if (!texto || texto === '*') return '*';
    return texto.split(',').map((s) => s.trim()).filter(Boolean);
}

async function leerFilas(idPlan) {
    try {
        return await Models.sequelize.query(
            'SELECT codigo, valor FROM general.gener_plan_caracteristica WHERE id_plan = :idPlan',
            { replacements: { idPlan }, type: Models.sequelize.QueryTypes.SELECT },
        );
    } catch (err) {
        // Sin la migración la tabla no existe: se sigue con los valores por defecto en vez de
        // tumbar la carta pública, que es la página más expuesta de la plataforma.
        if (esTablaInexistente(err)) return [];
        throw err;
    }
}

/**
 * @returns {Promise<{
 *   id_plan: number|null,
 *   carta_whatsapp: boolean,
 *   carta_color_libre: boolean,
 *   carta_plantillas: '*'|string[],
 * }>}
 */
async function getCaracteristicasNegocio(idNegocio) {
    const planes = await getPlanesActivosPorNegocio([idNegocio]);
    const plan = planes.get(Number(idNegocio)) || null;

    const valores = { ...POR_DEFECTO };
    if (plan?.id_plan) {
        for (const fila of await leerFilas(plan.id_plan)) {
            valores[fila.codigo] = fila.valor;
        }
    }

    return {
        id_plan: plan?.id_plan ?? null,
        carta_whatsapp: aBooleano(valores.carta_whatsapp),
        carta_color_libre: aBooleano(valores.carta_color_libre),
        carta_plantillas: aLista(valores.carta_plantillas),
    };
}

module.exports = { getCaracteristicasNegocio, POR_DEFECTO };
