'use strict';
const Models = require('../../app_core/models/conection');
const DashboardService = require('../services/dashboardService');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * Comprueba en el servidor que el usuario tenga concedida una acción concreta.
 *
 * ## Por qué no basta con ocultar el botón
 *
 * `negocio_app` resuelve los permisos por acción escondiendo el control en la interfaz, y para
 * un usuario normal es suficiente. Pero la API está abierta a cualquiera que tenga un token: sin
 * esta comprobación, quitarle «cancelar cita» a la recepcionista solo le quita el botón, no la
 * capacidad. Y como cancelar libera un hueco de agenda y puede tocar dinero ya cobrado, la
 * diferencia entre las dos cosas es real.
 *
 * Se aplica solo a las operaciones que cambian dinero o cierran algo. Un listado no necesita
 * pasar por aquí: cada consulta extra al catálogo de permisos es latencia en cada petición.
 *
 * ## Qué hace cuando no encuentra el permiso
 *
 * Rechaza. La alternativa —dejar pasar si el catálogo está vacío— convierte un despliegue a
 * medias en un agujero silencioso. Si la migración de acciones no se ha ejecutado, nadie tiene
 * ninguna, y eso se nota de inmediato en vez de descubrirse tarde.
 *
 * El **super administrador** entra siempre: es quien tiene que poder desatascar un negocio cuyo
 * dueño se ha quedado sin permisos.
 */
function exigirAccion(codigo) {
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
            if (globales.some(r => /SUPER/i.test(r.rol?.descripcion || ''))) return next();

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

            const permisos = await DashboardService.getPermisosSubnivelNegocio({
                idNegocio,
                idTipoNegocio: negocio.id_tipo_negocio,
                rolesNegocio: roles.map(r => ({ id_rol: r.rol?.id_rol ?? r.id_rol })),
            });

            const concedida = permisos.some(p => p.codigo === codigo && p.puede_ver);
            if (!concedida) {
                return Respuesta.error(
                    res,
                    'Tu rol no tiene permiso para esta acción. Pídeselo al administrador del negocio.',
                    403,
                );
            }
            return next();
        } catch (err) {
            console.error(`[Reserva/Accion] ${codigo}:`, err.message);
            return Respuesta.error(res, 'Error al verificar el permiso.');
        }
    };
}

module.exports = { exigirAccion };
