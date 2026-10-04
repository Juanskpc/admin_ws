/**
 * Alcance de las rutas de administración de usuarios, roles y planes.
 *
 * ## Qué arregla
 *
 * `app_admin_api/routes/index.js` monta todo tras `verificarToken`, y las rutas de
 * `/usuarios/admin/*` y `/roles/admin/*` se quedaron **sin ninguna comprobación de
 * autorización**: ni `requireSuperAdmin`, ni alcance por negocio, ni en la ruta ni en el
 * controlador. Con el token de un mesero de un restaurante se podía listar a los 62 usuarios
 * de la plataforma, editar o suspender al super administrador y darse a sí mismo cualquier
 * permiso. Auditado el 2026-10-04.
 *
 * ## Por qué NO es `requireSuperAdmin`
 *
 * Era la reacción natural y habría roto producción. `negocio_app` —la app del inquilino—
 * usa esas mismas rutas para su vista «Personal»: `GET/POST/PUT/DELETE /usuarios/admin`,
 * `PATCH /usuarios/admin/:id/estado` y `PUT /roles/admin/:id/permisos`. Un dueño de
 * restaurante tiene que poder crear a sus meseros. Lo que no puede es ver ni tocar a los de
 * otro negocio.
 *
 * Así que la regla es **alcance**, no rango: el super administrador sigue viendo todo
 * (opera la plataforma, ADR-010), y cualquier otro queda acotado a los negocios de los que
 * es miembro.
 *
 * ## De dónde sale el alcance
 *
 * De `req.principal`, que `exigirPertenenciaNegocio` ya deja puesto en **todas** las rutas
 * protegidas del router de admin. No se vuelve a consultar la base: el principal resuelve la
 * membresía en `gener_negocio_usuario` y el rol de super administrador una sola vez por
 * petición.
 *
 * ⚠️ Esto es independiente de `AUTHZ_MODO`. Ese middleware sigue en modo observación y solo
 * mira peticiones que traen un `id_negocio` explícito; aquí se bloquea siempre, porque el
 * negocio de un usuario objetivo no viaja en la petición: se deduce de sus roles.
 *
 * ## Fallar cerrado
 *
 * Sin `req.principal` no se adivina: se niega. Es la única postura segura si alguien monta
 * estas rutas en otro router y se olvida del middleware.
 */
'use strict';

const Respuesta = require('../helpers/respuesta');

/** Nombre del rol transversal. Mismo literal que `authz/principal.js`. */
const SUPER_ADMIN_ROL = 'SUPER ADMINISTRADOR';

/**
 * El alcance de quien hace la petición.
 *
 * @returns {{superAdmin: boolean, ids: number[], idUsuario: number|null}}
 */
function alcanceDe(req) {
    const principal = req.principal;
    if (!principal) return { superAdmin: false, ids: [], idUsuario: null };

    return {
        superAdmin: Boolean(principal.es_super_admin),
        ids: principal.idsNegocio().map(Number),
        idUsuario: principal.id_usuario ?? null,
    };
}

/**
 * Los negocios a los que está asignado un usuario, según sus roles activos.
 *
 * Un rol con `id_negocio` nulo es global (el del super administrador) y no cuenta como
 * pertenencia a ningún negocio concreto: por eso se filtra.
 */
function negociosDeUsuario(usuario) {
    return [...new Set(
        (usuario?.roles || [])
            .map((rol) => rol?.id_negocio)
            .filter((id) => id !== null && id !== undefined)
            .map(Number)
    )];
}

/** ¿Alguno de los roles de este usuario es el de super administrador? */
function usuarioEsSuperAdmin(usuario) {
    return (usuario?.roles || []).some(
        (rol) => String(rol?.descripcion || '').trim().toUpperCase() === SUPER_ADMIN_ROL
    );
}

/**
 * ¿Puede quien pide operar sobre este usuario objetivo?
 *
 * Comparte al menos un negocio con él. Dos reglas más, ambas de escalada de privilegios:
 *
 *   - **Un usuario siempre puede sobre sí mismo.** Hace falta porque alguien sin negocios
 *     asignados —un super admin recién creado, por ejemplo— editaría su propio perfil de otro
 *     modo, y la ruta de perfil es la misma.
 *   - **Nadie que no sea super administrador puede tocar a uno que sí lo es**, ni aunque
 *     compartan negocio. Si no, el dueño de un restaurante donde el super admin tenga una
 *     cuenta de soporte podría suspenderla.
 */
function puedeSobreUsuario(req, usuario) {
    const alcance = alcanceDe(req);
    if (alcance.superAdmin) return true;

    if (alcance.idUsuario && Number(usuario?.id_usuario) === Number(alcance.idUsuario)) return true;

    if (usuarioEsSuperAdmin(usuario)) return false;

    const negocios = negociosDeUsuario(usuario);
    return negocios.some((id) => alcance.ids.includes(id));
}

/**
 * ¿Puede operar sobre este negocio?
 *
 * `null`/`undefined` significa «sin negocio», es decir el ámbito global, y ahí solo entra el
 * super administrador.
 */
function puedeSobreNegocio(req, idNegocio) {
    const alcance = alcanceDe(req);
    if (alcance.superAdmin) return true;
    if (idNegocio === null || idNegocio === undefined || idNegocio === '') return false;

    return alcance.ids.includes(Number(idNegocio));
}

/**
 * Corta la petición si no se puede operar sobre ese negocio.
 *
 * Responde **403** y no 404: el `id_negocio` lo eligió quien pide, así que no se le revela
 * nada que no supiera ya. Devuelve `true` si cortó, para el patrón `if (negado) return;`.
 */
function negarSiNegocioFuera(req, res, idNegocio) {
    if (puedeSobreNegocio(req, idNegocio)) return false;

    Respuesta.error(res, 'No tiene acceso a este negocio', 403);
    return true;
}

/**
 * Corta la petición si no se puede operar sobre ese usuario.
 *
 * Responde **404 «Usuario no encontrado»**, el mismo cuerpo que cuando de verdad no existe.
 * Un 403 aquí confirmaría que el id existe y a quién pertenece, que es justo lo que se quiere
 * evitar: convierte la ruta en un enumerador de la plantilla de los demás inquilinos.
 */
function negarSiUsuarioFuera(req, res, usuario) {
    if (puedeSobreUsuario(req, usuario)) return false;

    Respuesta.error(res, 'Usuario no encontrado', 404);
    return true;
}

/**
 * Corta la petición si quien pide intenta conceder el rol de super administrador sin serlo.
 *
 * Es la escalada más directa que dejaban abiertas estas rutas: `POST /usuarios/admin` con el
 * `id_rol` del rol transversal, o un `PUT` que se lo asigne a su propia cuenta.
 *
 * @param {Array<{id_rol:number, descripcion:string}>} rolesActivos catálogo completo de roles.
 */
function negarSiEscalaARolSuperAdmin(req, res, idRol, rolesActivos) {
    if (alcanceDe(req).superAdmin) return false;

    const rol = (rolesActivos || []).find((r) => Number(r.id_rol) === Number(idRol));
    const esSuper = String(rol?.descripcion || '').trim().toUpperCase() === SUPER_ADMIN_ROL;
    if (!esSuper) return false;

    Respuesta.error(res, 'No puede asignar el rol de super administrador.', 403);
    return true;
}

module.exports = {
    SUPER_ADMIN_ROL,
    alcanceDe,
    negociosDeUsuario,
    usuarioEsSuperAdmin,
    puedeSobreUsuario,
    puedeSobreNegocio,
    negarSiNegocioFuera,
    negarSiUsuarioFuera,
    negarSiEscalaARolSuperAdmin,
};
