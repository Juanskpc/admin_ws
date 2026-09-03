'use strict';
const { Op } = require('sequelize');
const Models = require('../models/conection');

/**
 * Verificación server-side de un subnivel de permiso (gener_nivel con
 * id_tipo_nivel = 4) para un usuario dentro de un negocio.
 *
 * El frontend ya oculta lo que el rol no puede hacer, pero eso es cosmético: las
 * acciones que mueven dinero tienen que volver a preguntar aquí.
 *
 * Precedencia, igual que en el resto del sistema: el override por negocio
 * (`gener_nivel_negocio`) manda; si no hay fila, se cae a la matriz global
 * (`gener_rol_nivel`).
 */

function normalizePermissionCode(rawCode = '') {
    return String(rawCode)
        .trim()
        .toLowerCase()
        .replace(/^\/+/, '')
        .replace(/\//g, '_');
}

function isAdminRoleName(nombreRol = '') {
    return String(nombreRol).toUpperCase().includes('ADMINISTRADOR');
}

/**
 * @param {Object}  params
 * @param {number}  params.idUsuario
 * @param {number}  params.idNegocio
 * @param {string}  params.codigo — código del subnivel, ej. 'caja_eliminar_pedido'
 * @param {boolean} [params.adminSiempre=true] — si un rol ADMINISTRADOR lo tiene
 *        por definición. Ponerlo en false para acciones que deben concederse una
 *        por una, sin que el rol de administrador las herede.
 * @returns {Promise<boolean>}
 */
async function usuarioTieneSubnivel({ idUsuario, idNegocio, codigo, adminSiempre = true }) {
    if (!idUsuario || !idNegocio || !codigo) return false;

    const rolesUsuario = await Models.GenerUsuarioRol.findAll({
        where: {
            id_usuario: idUsuario,
            estado: 'A',
            [Op.or]: [{ id_negocio: idNegocio }, { id_negocio: null }],
        },
        attributes: ['id_rol'],
        include: [{
            model: Models.GenerRol,
            as: 'rol',
            required: true,
            attributes: ['id_rol', 'descripcion'],
        }],
    });

    const roles = rolesUsuario
        .map((r) => ({
            id_rol: Number(r.id_rol),
            descripcion: String(r.rol?.descripcion || ''),
        }))
        .filter((r) => Number.isInteger(r.id_rol));

    if (!roles.length) return false;
    if (adminSiempre && roles.some((r) => isAdminRoleName(r.descripcion))) return true;

    const roleIds = [...new Set(roles.map((r) => r.id_rol))];
    const url = normalizePermissionCode(codigo);

    const nivelWhere = {
        model: Models.GenerNivel,
        as: 'nivel',
        required: true,
        where: { estado: 'A', id_tipo_nivel: 4, url },
        attributes: ['id_nivel'],
    };

    // 1. Override por negocio: si existe fila, decide (sea true o false).
    const permisoNegocio = await Models.GenerNivelNegocio.findOne({
        where: { id_negocio: idNegocio, id_rol: roleIds, estado: 'A', puede_ver: true },
        attributes: ['id_nivel_negocio'],
        include: [nivelWhere],
    });
    if (permisoNegocio) return true;

    const existeFilaNegocio = await Models.GenerNivelNegocio.findOne({
        where: { id_negocio: idNegocio, id_rol: roleIds, estado: 'A' },
        attributes: ['id_nivel_negocio'],
        include: [nivelWhere],
    });
    if (existeFilaNegocio) return false;

    // 2. Sin override, manda la matriz global del rol.
    const permisoGlobal = await Models.GenerRolNivel.findOne({
        where: { id_rol: roleIds, estado: 'A', puede_ver: true },
        attributes: ['id_rol_nivel'],
        include: [nivelWhere],
    });

    return Boolean(permisoGlobal);
}

module.exports = {
    usuarioTieneSubnivel,
    normalizePermissionCode,
    isAdminRoleName,
};
