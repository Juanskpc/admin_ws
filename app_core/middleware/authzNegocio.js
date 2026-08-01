/**
 * Autorización multi-inquilino: verifica que quien pide pertenece al `id_negocio` que dice.
 *
 * ## Qué arregla
 *
 * Hasta ahora las rutas protegidas tomaban `id_negocio` del body/query/params y solo
 * exigían un JWT válido: **nadie verificaba pertenencia**. Cualquier token válido podía
 * leer y escribir sobre cualquier negocio. Los permisos vivían únicamente en el guard de
 * Angular, que es decoración: un `curl` lo ignora.
 *
 * Es una vulnerabilidad activa hoy, con o sin IA. El asistente no la crea, la amplifica:
 * una cuenta de servicio para el bot heredaría el agujero y lo expondría a entradas de
 * internet (ADR-002, ADR-010).
 *
 * ## Modos — y por qué el de por defecto NO bloquea
 *
 *   observacion (por defecto) → registra la violación en auditoría y DEJA PASAR.
 *   bloqueo                   → registra y responde 403.
 *
 * Empezar bloqueando en producción es inaceptable: rechazaría peticiones que hoy
 * funcionan, y no sabemos cuáles son. El procedimiento es desplegar en `observacion`,
 * medir una semana con datos reales, corregir lo que aparezca y solo entonces activar
 * `bloqueo`. Las violaciones se escriben en `auditoria.audit_evento` (módulo `authz`),
 * que ya tiene consulta en el panel de administración — por eso son medibles.
 *
 * ## Alcance deliberado de F2
 *
 * Verifica **pertenencia** (usuario ↔ negocio), no permisos por rol. El permiso
 * `(rol, capacidad)` necesita el catálogo de capacidades, que es F4. Los roles ya se
 * resuelven dentro del Principal y quedan disponibles ahí, para que F4 no tenga que
 * volver a tocar esta fontanería.
 */
const Respuesta = require('../helpers/respuesta');
const Audit = require('../helpers/auditHelper');
const { resolverPrincipalUsuario } = require('../authz/principal');

const MODO = (process.env.AUTHZ_MODO || 'observacion').toLowerCase();
const MODO_BLOQUEO = MODO === 'bloqueo';

/** Nombres bajo los que las verticales pasan el negocio. */
const CLAVES = ['id_negocio', 'idNegocio'];

/**
 * Saca el `id_negocio` de la petición.
 *
 * Solo mira nombres explícitos. Rutas como `/negocios/:id/paleta`, donde `:id` ES el
 * negocio pero no se llama así, quedan fuera: adivinar por posición daría falsos
 * positivos y bloquearía tráfico legítimo. Se cubren en su propia ruta si hace falta.
 */
function extraerIdNegocio(req) {
    for (const fuente of [req.params, req.query, req.body]) {
        if (!fuente) continue;
        for (const clave of CLAVES) {
            const valor = fuente[clave];
            if (valor !== undefined && valor !== null && `${valor}`.trim() !== '') {
                const n = Number(valor);
                if (Number.isInteger(n) && n > 0) return n;
            }
        }
    }
    return null;
}

async function registrarViolacion(req, principal, idNegocio) {
    // No se deja que un fallo de auditoría tumbe la petición, pero sí se ve en consola:
    // perder el registro en modo observación es perder la medición entera.
    try {
        await Audit.registrarEvento({
            modulo: 'authz',
            accion: 'negocio_ajeno',
            resultado: MODO_BLOQUEO ? 'denegado' : 'observado',
            idUsuario: principal.id_usuario,
            idNegocio,
            detalle: {
                modo: MODO,
                ruta: `${req.method} ${req.originalUrl?.split('?')[0]}`,
                negocios_del_principal: principal.idsNegocio(),
            },
        });
    } catch (error) {
        console.error('[authz] No se pudo auditar la violación:', error.message);
    }

    console.warn(
        `[authz] ${MODO_BLOQUEO ? 'BLOQUEADO' : 'OBSERVADO'} — usuario ${principal.id_usuario} ` +
            `pidió el negocio ${idNegocio} y pertenece a [${principal.idsNegocio().join(', ') || 'ninguno'}] ` +
            `· ${req.method} ${req.originalUrl?.split('?')[0]}`
    );
}

/**
 * Middleware. Debe montarse DESPUÉS de `verificarToken` y de los parsers de body.
 * Deja `req.principal` disponible para el resto de la cadena.
 */
async function exigirPertenenciaNegocio(req, res, next) {
    try {
        const idUsuario = req.usuario?.id_usuario;
        if (!idUsuario) return Respuesta.error(res, 'No autenticado', 401);

        const principal = await resolverPrincipalUsuario(idUsuario);
        req.principal = principal;

        const idNegocio = extraerIdNegocio(req);

        // Sin negocio en la petición no hay nada que verificar aquí (p. ej. /perfil).
        if (idNegocio === null) return next();

        if (principal.puedeOperarEn(idNegocio)) return next();

        await registrarViolacion(req, principal, idNegocio);

        if (MODO_BLOQUEO) {
            return Respuesta.error(res, 'No tiene acceso a este negocio', 403);
        }
        return next();
    } catch (error) {
        console.error('[authz] Error resolviendo el principal:', error.message);
        return Respuesta.error(res, 'Error al verificar el acceso al negocio', 500);
    }
}

/** Para el arranque: que el modo activo sea visible y nadie lo dé por supuesto. */
function describirModo() {
    return MODO_BLOQUEO
        ? '[authz] Modo BLOQUEO — se rechaza el acceso a negocios ajenos.'
        : '[authz] Modo OBSERVACIÓN — las violaciones se auditan pero NO se bloquean. ' +
              'Activa AUTHZ_MODO=bloqueo cuando la medición esté limpia.';
}

module.exports = { exigirPertenenciaNegocio, describirModo, MODO, MODO_BLOQUEO, extraerIdNegocio };
