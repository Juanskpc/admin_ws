/**
 * Datos fiscales de un negocio (FE-1).
 *
 * Ver `docs/facturacion-electronica.md` §4 (los interruptores) y §5 (el mapa de campos).
 *
 * ## Por qué la ruta usa `:id_negocio` y no `:id` como las demás
 *
 * El middleware `exigirPertenenciaNegocio` solo reconoce el negocio cuando el parámetro se
 * **llama** `id_negocio` o `idNegocio` — su propio comentario dice que adivinar por posición
 * daría falsos positivos. Rutas como `/negocios/:id/paleta` quedan fuera de esa comprobación a
 * propósito. Aquí no nos vale: por estos endpoints pasan el NIT, la razón social y la dirección
 * fiscal del inquilino, así que la ruta se nombra para que el middleware **sí** la cubra.
 *
 * Y como ese middleware arranca en modo observación (audita pero no bloquea, ADR-002/F2), cada
 * handler comprueba además la pertenencia **a mano** con `puedeOperarEn()`. Dos cinturones para
 * el mismo pantalón, porque el día que se filtre el NIT de un inquilino a otro no hay vuelta
 * atrás.
 */
'use strict';

const { validationResult } = require('express-validator');

const Respuesta = require('../../app_core/helpers/respuesta');
const datosFiscales = require('../../app_core/facturacion/datosFiscales');
const { resolverPrincipalUsuario } = require('../../app_core/authz/principal');

/**
 * Comprueba que quien pide puede operar sobre ese negocio.
 * @returns {Promise<boolean>} true si puede seguir; si no, ya respondió con 403.
 */
async function autorizar(req, res, idNegocio) {
    const principal = await resolverPrincipalUsuario(req.usuario?.id_usuario);
    if (!principal || !principal.puedeOperarEn(idNegocio)) {
        // Mismo mensaje tanto si el negocio no existe como si no es suyo: distinguirlos le
        // diría a un curioso qué ids existen.
        Respuesta.error(res, 'No tienes acceso a este negocio', 403);
        return false;
    }
    return true;
}

function validar(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        return false;
    }
    return true;
}

/**
 * GET /admin/negocios/:id_negocio/datos-fiscales
 *
 * Devuelve la ficha y, sobre todo, `estado`: si puede emitir y **qué le falta**. El formulario
 * se dibuja a partir de eso, no de una lista de campos quemada en el frontend.
 */
async function getDatosFiscales(req, res) {
    try {
        if (!validar(req, res)) return;
        const idNegocio = Number(req.params.id_negocio);
        if (!(await autorizar(req, res, idNegocio))) return;

        const ficha = await datosFiscales.obtener(idNegocio);
        if (!ficha) return Respuesta.error(res, 'El negocio no tiene ficha fiscal', 404);

        const estado = await datosFiscales.puedeEmitir(idNegocio);
        return Respuesta.success(res, 'Datos fiscales obtenidos', { ficha, estado });
    } catch (error) {
        console.error('Error en getDatosFiscales:', error);
        return Respuesta.error(
            res,
            error.message || 'Error al obtener los datos fiscales',
            error.statusCode || 500
        );
    }
}

/**
 * PUT /admin/negocios/:id_negocio/datos-fiscales
 *
 * Guarda los datos. Acepta un subconjunto: la ficha se puede llenar en varias tandas.
 */
async function putDatosFiscales(req, res) {
    try {
        if (!validar(req, res)) return;
        const idNegocio = Number(req.params.id_negocio);
        if (!(await autorizar(req, res, idNegocio))) return;

        const ficha = await datosFiscales.actualizar(idNegocio, req.body);
        const estado = await datosFiscales.puedeEmitir(idNegocio);
        return Respuesta.success(res, 'Datos fiscales actualizados', { ficha, estado });
    } catch (error) {
        // Los errores de dominio traen `.statusCode` y un mensaje que se le puede enseñar a una
        // persona («debería ser 4»), así que se reenvían tal cual en vez de taparlos con un 500.
        if (!error.statusCode) console.error('Error en putDatosFiscales:', error);
        return Respuesta.error(
            res,
            error.message || 'Error al actualizar los datos fiscales',
            error.statusCode || 500
        );
    }
}

/**
 * PUT /admin/negocios/:id_negocio/datos-fiscales/declaracion
 *
 * Lo que el cliente DECLARA: si está registrado, si está obligado a facturar y qué quiere
 * emitir. Queda con su firma —quién y cuándo—, porque nosotros no verificamos nada ante la
 * Cámara de Comercio ni ante la DIAN y esa declaración es lo único que responde por él.
 */
async function putDeclaracion(req, res) {
    try {
        if (!validar(req, res)) return;
        const idNegocio = Number(req.params.id_negocio);
        if (!(await autorizar(req, res, idNegocio))) return;

        const resultado = await datosFiscales.declarar(idNegocio, req.body, {
            idUsuario: req.usuario?.id_usuario,
        });
        return Respuesta.success(res, 'Declaración registrada', resultado);
    } catch (error) {
        if (!error.statusCode) console.error('Error en putDeclaracion:', error);
        return Respuesta.error(
            res,
            error.message || 'Error al registrar la declaración',
            error.statusCode || 500
        );
    }
}

/**
 * GET /admin/facturacion/catalogos
 *
 * Departamentos e impuestos, para poblar los desplegables del formulario. No lleva negocio:
 * son catálogos, iguales para todos.
 */
async function getCatalogos(req, res) {
    try {
        const catalogos = await datosFiscales.catalogos();
        return Respuesta.success(res, 'Catálogos obtenidos', catalogos);
    } catch (error) {
        console.error('Error en getCatalogos:', error);
        return Respuesta.error(res, 'Error al obtener los catálogos');
    }
}

module.exports = { getDatosFiscales, putDatosFiscales, putDeclaracion, getCatalogos };
