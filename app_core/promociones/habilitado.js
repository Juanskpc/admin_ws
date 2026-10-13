/**
 * La lista blanca de las promociones masivas: ¿a este negocio se le encendió la función?
 *
 * ## Por qué hace falta algo además de los permisos
 *
 * La matriz de permisos (`gener_nivel` / `gener_rol_nivel` / `gener_nivel_negocio`) contesta a
 * **quién dentro del negocio** puede entrar a una pantalla. Es la pregunta correcta para Caja o
 * Inventario, y la equivocada para esta: aquí lo que se decide es **a qué negocios se les ofrece
 * la función**, y esa decisión es de EscalApp, no del dueño. Si viviera solo en la matriz, el
 * dueño de cualquier restaurante podría encendérsela a sí mismo desde «Roles y permisos» —y
 * `usuarioAdminDao` además la siembra sola con el valor de la plantilla del rol la primera vez que
 * alguien abre esa pantalla—. Para una función que manda publicidad por el número del negocio y
 * gasta dinero en Meta, «se encendió sola» no es un resultado aceptable.
 *
 * Así que la matriz sigue decidiendo qué rol la ve, y este interruptor decide si el negocio la
 * tiene. Son dos preguntas distintas y las dos se contestan: el permiso esconde el menú, y esto
 * cierra la API. Esconder un botón no cierra una API.
 *
 * ## Falla CERRADO, siempre
 *
 * Si la columna no existe todavía (backend desplegado antes de la migración) o la consulta falla,
 * la respuesta es `false`. Al revés —abrir por no poder comprobar— se manda publicidad a nombre de
 * un negocio que nunca la pidió, y eso no se puede deshacer. Un negocio que debería tenerla y se
 * queda sin ella es una molestia de un minuto; el caso contrario es una denuncia.
 *
 * ## Cómo se enciende
 *
 * Una fila, a mano, con el negocio ya acordado:
 *
 * ```sql
 * UPDATE general.gener_negocio SET permite_promociones = true WHERE id_negocio = 12;
 * ```
 *
 * No hay pantalla para esto a propósito: mientras sea un piloto, encenderlo es una decisión
 * comercial con nombre y apellido, no un interruptor que se pulsa sin pensar. Queda en la
 * auditoría (`trg_audit` de `gener_negocio`) con quién lo hizo.
 */
'use strict';

const Models = require('../models/conection');

const sequelize = Models.sequelize;

/** El código que ve el frontend, y el que el doc usa para explicar el 403. */
const CODE_NO_HABILITADO = 'PROMOS_NO_HABILITADO';

const MENSAJE_NO_HABILITADO =
    'Las promociones masivas todavía no están habilitadas para este negocio.';

/**
 * ¿El negocio tiene la función encendida?
 *
 * @param {number} idNegocio
 * @returns {Promise<boolean>}
 */
async function estaHabilitado(idNegocio) {
    const id = Number(idNegocio);
    if (!Number.isInteger(id) || id <= 0) return false;

    try {
        const filas = await sequelize.query(
            `SELECT permite_promociones FROM general.gener_negocio
              WHERE id_negocio = :id LIMIT 1;`,
            { replacements: { id }, type: sequelize.QueryTypes.SELECT },
        );
        return filas?.[0]?.permite_promociones === true;
    } catch (error) {
        // Columna que falta o base caída: cerrado, y dicho en el log para que no se busque en el
        // frontend una pantalla que el backend está apagando a propósito.
        console.error('[promociones] no se pudo leer permite_promociones:', error.message);
        return false;
    }
}

/** El error tipado, para los services que necesiten lanzarlo en vez de contestar un 403. */
function errorNoHabilitado() {
    const e = new Error(MENSAJE_NO_HABILITADO);
    e.code = CODE_NO_HABILITADO;
    e.statusCode = 403;
    return e;
}

module.exports = {
    CODE_NO_HABILITADO,
    MENSAJE_NO_HABILITADO,
    estaHabilitado,
    errorNoHabilitado,
};
