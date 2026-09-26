'use strict';
/**
 * Corta una ruta si el negocio no tiene encendida la función del perfil que la sostiene
 * (estancias, recursos, mascotas, ficha). Ver `app_reserva_api/perfiles`.
 *
 * Va **después** de los validadores y de `exigirVista`/`exigirAccion`: primero se decide quién
 * es y qué puede hacer, después si el negocio usa esto. El `id_negocio` se toma del cuerpo o de
 * la consulta, como en el resto de middlewares del módulo.
 */
const Perfiles = require('../perfiles');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * @param {string|string[]} funcion  Una función, o varias de las que basta con una: la ficha la
 *        usan tanto `ficha` como `consentimiento` (el consentimiento se guarda en ella) y
 *        `mascotas` (las vacunas).
 */
function exigirFuncion(funcion) {
    const funciones = Array.isArray(funcion) ? funcion : [funcion];
    return async function comprobar(req, res, next) {
        try {
            const idNegocio = Number(req.body?.id_negocio ?? req.query?.id_negocio ?? req.params?.id_negocio);
            if (!Number.isInteger(idNegocio) || idNegocio <= 0) {
                return Respuesta.error(res, 'id_negocio requerido', 400);
            }
            const perfil = await Perfiles.perfilDeNegocio(idNegocio);
            if (funciones.some((f) => perfil.funciones.includes(f))) return next();
            const etiqueta = Perfiles.FUNCIONES[funciones[0]]?.etiqueta || funciones[0];
            return Respuesta.error(
                res,
                `«${etiqueta}» no está activa en este negocio. Actívala en Configuración → Funciones.`,
                403,
                [{ code: 'FUNCION_INACTIVA' }],
            );
        } catch (err) {
            if (err.statusCode) {
                return Respuesta.error(res, err.message, err.statusCode, err.code ? [{ code: err.code }] : null);
            }
            console.error(`[Reserva/Funcion] ${funciones.join('|')}:`, err.message);
            return Respuesta.error(res, 'Error al verificar la función del negocio.');
        }
    };
}

module.exports = { exigirFuncion };
