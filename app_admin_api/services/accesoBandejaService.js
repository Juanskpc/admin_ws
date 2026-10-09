/**
 * Quién puede usar la Bandeja (la vista de WhatsApp del panel), negocio por negocio.
 *
 *  - Super admin: todos.
 *  - ADMINISTRADOR del negocio: siempre (también sin plan: es quien conecta el número).
 *  - CAJERO del negocio: solo si el plan del negocio incluye WhatsApp (feature `asistente_ia`).
 *    Pedido del dueño (2026-10-04): el cajero es quien está frente al local y quien contesta.
 *  - Cualquier otro rol (mesero, domiciliario…): no.
 *
 * Hasta hoy la Bandeja dejaba entrar a cualquier usuario vinculado al negocio; el panel la ocultaba
 * a quien no era administrador, pero el servidor no. Esto cierra las dos puertas con la misma regla.
 *
 * Lo que no cambia: la configuración del asistente y la pausa siguen siendo solo del administrador
 * (`esAdministradorDelNegocio` en el controlador).
 */
'use strict';

const Models = require('../../app_core/models/conection');
const { alcanceDeNegocios } = require('../../app_core/middleware/auth');
const { featuresDeNegocios, FEATURE } = require('../../intelligence/core/features');

/** Roles que ven la Bandeja si el plan incluye WhatsApp. El administrador no depende del plan. */
const ROLES_CON_PLAN = ['CAJERO'];

/**
 * @returns {Promise<{superAdmin: boolean, idNegocios: number[]}>} la misma forma que
 *   `alcanceDeNegocios`, para que el controlador la use en su lugar sin más cambios.
 */
async function alcanceBandeja(idUsuario) {
    const base = await alcanceDeNegocios(idUsuario);
    if (base.superAdmin || base.idNegocios.length === 0) return base;

    const roles = await Models.sequelize.query(
        `SELECT ur.id_negocio, UPPER(TRIM(r.descripcion)) AS rol
           FROM general.gener_usuario_rol ur
           JOIN general.gener_rol r ON r.id_rol = ur.id_rol AND r.estado = 'A'
          WHERE ur.id_usuario = :idUsuario AND ur.estado = 'A' AND ur.id_negocio IN (:ids);`,
        { replacements: { idUsuario, ids: base.idNegocios }, type: Models.sequelize.QueryTypes.SELECT }
    );

    const comoAdmin = new Set();
    const conPlan = new Set();
    for (const { id_negocio: id, rol } of roles) {
        if (rol.includes('ADMINISTRADOR')) comoAdmin.add(Number(id));
        else if (ROLES_CON_PLAN.includes(rol)) conPlan.add(Number(id));
    }

    const permitidos = new Set(comoAdmin);
    const pendientes = [...conPlan].filter((id) => !comoAdmin.has(id));
    if (pendientes.length > 0) {
        try {
            const features = await featuresDeNegocios(pendientes);
            for (const id of pendientes) {
                if ((features.get(id) || []).includes(FEATURE.ASISTENTE_IA)) permitidos.add(id);
            }
        } catch (error) {
            // Sin poder leer el plan, el cajero no entra: fallar cerrado, el administrador sigue.
            console.warn(`[bandeja] no se pudo leer el plan para el cajero ${idUsuario}: ${error.message}`);
        }
    }
    return { superAdmin: false, idNegocios: base.idNegocios.filter((id) => permitidos.has(id)) };
}

/** ¿Es ADMINISTRADOR de ese negocio (o super admin)? Para lo que cambia el negocio, no lo que lo opera. */
async function esAdministradorDelNegocio(idUsuario, idNegocio) {
    const base = await alcanceDeNegocios(idUsuario);
    if (base.superAdmin) return true;
    const filas = await Models.sequelize.query(
        `SELECT 1
           FROM general.gener_usuario_rol ur
           JOIN general.gener_rol r ON r.id_rol = ur.id_rol AND r.estado = 'A'
          WHERE ur.id_usuario = :idUsuario AND ur.id_negocio = :idNegocio AND ur.estado = 'A'
            AND UPPER(r.descripcion) LIKE '%ADMINISTRADOR%'
          LIMIT 1;`,
        { replacements: { idUsuario, idNegocio }, type: Models.sequelize.QueryTypes.SELECT }
    );
    return filas.length > 0;
}

module.exports = { alcanceBandeja, esAdministradorDelNegocio, ROLES_CON_PLAN };
