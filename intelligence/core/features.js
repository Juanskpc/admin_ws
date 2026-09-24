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
    /** El negocio puede emitir facturación electrónica. Ningún plan actual la incluye todavía. */
    FACTURACION_ELECTRONICA: 'facturacion_electronica',
};

const NOMBRES_DE_FEATURE = Object.values(FEATURE);

/**
 * De dónde salen las features de un plan (desde 2026-09-24).
 *
 * De `general.gener_plan_caracteristica`: una fila por (plan, feature) con `codigo` = el nombre de la
 * feature y `valor` = 'true'. Cambiar lo que incluye un plan es un INSERT/UPDATE, no un despliegue,
 * y un plan nuevo se declara con datos sin que nadie toque este archivo. Es la misma tabla con la
 * que ya se controla la carta del restaurante.
 *
 * Una fila con `valor` distinto de 'true' es una decisión explícita («este plan NO la tiene») y
 * manda sobre el mapa de abajo.
 */

/**
 * Mapeo plan → features. Deliberadamente una constante.
 *
 * **Desde el 2026-08-24 el asistente vive en «Plan Avanzado».** Antes no estaba en ningún
 * plan —no se vendía— y en producción eso lo hacía inalcanzable: `FEATURES_FORZADAS` se
 * ignora ahí a propósito, así que el webhook de WhatsApp habría rechazado todo con 403.
 *
 * Se eligió Avanzado y no Básico por una razón que se puede comprobar: en producción los 11
 * negocios están en «Plan Básico» y **Avanzado tiene cero**. Ponerlo en Básico se lo habría
 * regalado a los dos clientes activos de golpe; ponerlo en Avanzado no cambia nada para
 * nadie hasta que alguien contrate ese plan a sabiendas. Que el asistente sea la feature
 * que justifica el plan caro es además la lectura comercial natural.
 *
 * El nombre es la clave del mapa y tiene que coincidir **exacto** con `gener_plan.nombre`.
 * Los planes «Gratis», «Emprendedor», «Profesional» y «Empresarial» existen en la tabla
 * pero no se listan aquí: sin entrada, `estaHabilitado` devuelve false, que es lo correcto.
 *
 * ## Desde 2026-09-24 esto es solo un RESPALDO
 *
 * La fuente son las filas de `gener_plan_caracteristica` (ver arriba). Este mapa se aplica a un
 * plan **al que le falta la fila de esa feature** —una base donde `migrate:planes-codigo` todavía
 * no corrió, o un plan que nadie sembró—: así nadie pierde el asistente durante la transición.
 * Cuando todos los entornos tengan las filas, se borra.
 */
const FEATURES_POR_PLAN = {
    'Plan Básico': [],
    'Plan Avanzado': [FEATURE.ASISTENTE_IA],
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

const esTablaInexistente = (err) => (err?.parent?.code || err?.original?.code) === '42P01';

/** ¿Qué dice esta fila de característica? Solo 'true' (sin importar mayúsculas) habilita. */
const esVerdadero = (valor) => String(valor).trim().toLowerCase() === 'true';

/**
 * Las features de UN plan: primero lo que dicen sus filas de `gener_plan_caracteristica`, y el
 * mapa por nombre solo para las features de las que el plan no tiene fila.
 *
 * @param {string} nombre — `gener_plan.nombre`, solo para el respaldo.
 * @param {Object<string,string>} [caracteristicas] — codigo → valor, tal como están en la tabla.
 */
function featuresDelPlan(nombre, caracteristicas = {}) {
    const respaldo = new Set(FEATURES_POR_PLAN[nombre] || []);
    const salida = [];
    for (const feature of NOMBRES_DE_FEATURE) {
        if (Object.prototype.hasOwnProperty.call(caracteristicas, feature)) {
            if (esVerdadero(caracteristicas[feature])) salida.push(feature);
        } else if (respaldo.has(feature)) {
            salida.push(feature);
        }
    }
    return salida;
}

/**
 * Ejecuta una consulta que lee `gener_plan_caracteristica`; si la tabla no existe en este entorno
 * la repite sin ella (todas las características vacías, o sea, solo el respaldo por nombre).
 */
async function conCaracteristicas(sqlCon, sqlSin, replacements) {
    const opciones = { replacements, type: Models.sequelize.QueryTypes.SELECT };
    try {
        return await Models.sequelize.query(sqlCon, opciones);
    } catch (err) {
        if (!esTablaInexistente(err)) throw err;
        return Models.sequelize.query(sqlSin, opciones);
    }
}

/** El subselect que trae las filas de característica de las features conocidas, como JSON. */
const CARACTERISTICAS_SQL = `COALESCE((SELECT jsonb_object_agg(c.codigo, c.valor)
                                          FROM general.gener_plan_caracteristica c
                                         WHERE c.id_plan = p.id_plan AND c.codigo IN (:codigos)),
                                       '{}'::jsonb) AS caracteristicas`;

/** El plan activo del negocio con lo necesario para resolver sus features, o `null`. */
async function planActivoDetalle(idNegocio) {
    const base = (extra) => `
        SELECT p.id_plan, p.nombre, ${extra}
          FROM general.gener_negocio_plan np
          JOIN general.gener_plan p ON p.id_plan = np.id_plan AND p.estado = 'A'
         WHERE np.id_negocio = :idNegocio
           AND np.estado = 'A'
           AND (np.fecha_fin IS NULL OR np.fecha_fin >= CURRENT_DATE)
         ORDER BY np.fecha_inicio DESC
         LIMIT 1;`;
    const [fila] = await conCaracteristicas(
        base(CARACTERISTICAS_SQL),
        base(`'{}'::jsonb AS caracteristicas`),
        { idNegocio, codigos: NOMBRES_DE_FEATURE }
    );
    return fila || null;
}

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

    const plan = await planActivoDetalle(idNegocio);
    if (!plan) return false;

    return featuresDelPlan(plan.nombre, plan.caracteristicas).includes(feature);
}

/**
 * Las features de VARIOS negocios en una sola consulta.
 *
 * Es `estaHabilitado` en lote, no otra regla: mismo plan activo (mismos filtros que `planActivo`),
 * mismas filas de característica con el mapa por nombre de respaldo, misma escotilla `FORZADAS`
 * (que en producción está vacía). Sigue siendo UNA sola consulta, sea cual sea el número de negocios.
 * Existe para las pantallas que pintan una lista de negocios y necesitan saber qué tiene cada uno
 * — «Mis negocios», el botón «Ver planes» de WhatsApp —: preguntar de uno en uno serían N consultas.
 *
 * Quien la use sigue sin conocer el nombre de ningún plan: recibe nombres de FEATURE.
 *
 * @param {number[]} idNegocios
 * @returns {Promise<Map<number, string[]>>} todos los ids pedidos, con `[]` si no tienen nada
 */
async function featuresDeNegocios(idNegocios) {
    const ids = [...new Set((idNegocios || []).map(Number).filter(Number.isInteger))];
    const resultado = new Map(ids.map((id) => [id, [...FORZADAS]]));
    if (ids.length === 0) return resultado;

    const base = (extra) => `
        SELECT DISTINCT ON (np.id_negocio) np.id_negocio, p.nombre, ${extra}
          FROM general.gener_negocio_plan np
          JOIN general.gener_plan p ON p.id_plan = np.id_plan AND p.estado = 'A'
         WHERE np.id_negocio IN (:ids)
           AND np.estado = 'A'
           AND (np.fecha_fin IS NULL OR np.fecha_fin >= CURRENT_DATE)
         ORDER BY np.id_negocio, np.fecha_inicio DESC;`;
    const filas = await conCaracteristicas(
        base(CARACTERISTICAS_SQL),
        base(`'{}'::jsonb AS caracteristicas`),
        { ids, codigos: NOMBRES_DE_FEATURE }
    );

    for (const { id_negocio: id, nombre, caracteristicas } of filas) {
        const propias = new Set(resultado.get(Number(id)));
        for (const f of featuresDelPlan(nombre, caracteristicas || {})) propias.add(f);
        resultado.set(Number(id), [...propias]);
    }
    return resultado;
}

/** Para diagnóstico y para la CLI: por qué la respuesta fue la que fue. */
async function explicar(idNegocio, feature) {
    if (FORZADAS.has(feature)) {
        return { habilitado: true, motivo: `forzada por FEATURES_FORZADAS (${process.env.NODE_ENV || 'sin NODE_ENV'})` };
    }
    const plan = await planActivoDetalle(idNegocio);
    if (!plan) return { habilitado: false, motivo: 'el negocio no tiene plan activo' };

    const incluida = featuresDelPlan(plan.nombre, plan.caracteristicas).includes(feature);
    const hayFila = Object.prototype.hasOwnProperty.call(plan.caracteristicas || {}, feature);
    const origen = hayFila ? 'por su fila en gener_plan_caracteristica' : 'por el mapa de respaldo por nombre';
    return {
        habilitado: incluida,
        motivo: incluida
            ? `incluida en "${plan.nombre}" (${origen})`
            : `"${plan.nombre}" no incluye "${feature}" (${origen})`,
    };
}

module.exports = {
    estaHabilitado,
    featuresDeNegocios,
    featuresDelPlan,
    explicar,
    planActivo,
    FEATURE,
    FEATURES_POR_PLAN,
};
