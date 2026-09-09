'use strict';
const Models = require('../../app_core/models/conection');
const DashboardService = require('../services/dashboardService');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * Comprueba en el servidor que el usuario tenga concedida una **vista** del vertical.
 *
 * Hermano de `exigirAccion`, con la misma forma y la misma regla de fallo cerrado; lo que
 * cambia es la tabla que consulta: aquí `gener_nivel` de tipo 1 (las vistas del menú) en vez
 * de los subniveles de tipo 4 (las acciones dentro de una vista).
 *
 * ## Por qué una vista necesita esto y un listado normal no
 *
 * `exigirAccion` documenta que un listado no pasa por aquí, porque cada comprobación es
 * latencia en cada petición. La cartera de clientes es la excepción: no es el estado del
 * negocio, son **datos personales de terceros** —nombre y teléfono de cada persona que ha
 * pasado por el salón—. Esconder el elemento del menú deja la ruta abierta a cualquiera con
 * un token del negocio, y eso aquí no es un botón de más: es la lista de contactos completa.
 *
 * Como en `exigirAccion`, el super administrador entra siempre.
 */
function exigirVista(url) {
    return async function comprobar(req, res, next) {
        try {
            const idUsuario = req.usuario?.id_usuario;
            if (!idUsuario) return Respuesta.error(res, 'No autenticado', 401);

            const idNegocio = Number(req.body?.id_negocio ?? req.query?.id_negocio);
            if (!Number.isInteger(idNegocio) || idNegocio <= 0) {
                return Respuesta.error(res, 'id_negocio requerido', 400);
            }

            const globales = await Models.GenerUsuarioRol.findAll({
                where: { id_usuario: idUsuario, id_negocio: null, estado: 'A' },
                include: [{ model: Models.GenerRol, as: 'rol', attributes: ['descripcion'] }],
            });
            if (globales.some((r) => /SUPER/i.test(r.rol?.descripcion || ''))) return next();

            const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
                attributes: ['id_negocio', 'id_tipo_negocio'],
            });
            if (!negocio) return Respuesta.error(res, 'Negocio no encontrado', 404);

            const roles = await Models.GenerUsuarioRol.findAll({
                where: { id_usuario: idUsuario, id_negocio: idNegocio, estado: 'A' },
                include: [{ model: Models.GenerRol, as: 'rol', attributes: ['id_rol', 'descripcion'] }],
            });
            if (roles.length === 0) {
                return Respuesta.error(res, 'No tienes acceso a este negocio.', 403);
            }

            const vistas = await DashboardService.getPermisosVistaNegocio({
                idNegocio,
                idTipoNegocio: negocio.id_tipo_negocio,
                rolesNegocio: roles.map((r) => ({ id_rol: r.rol?.id_rol ?? r.id_rol })),
            });

            const vista = vistas.find((v) => v.url === url);
            if (!vista?.puede_ver) {
                return Respuesta.error(
                    res,
                    'Tu rol no tiene acceso a esta vista. Pídeselo al administrador del negocio.',
                    403,
                );
            }

            // Las banderas de acción viajan al controlador para que no tenga que repetir la
            // consulta cuando lo que decide es editar y no solo ver.
            req.permisoVista = vista;
            return next();
        } catch (err) {
            console.error(`[Reserva/Vista] ${url}:`, err.message);
            return Respuesta.error(res, 'Error al verificar el permiso.');
        }
    };
}

module.exports = { exigirVista };
