/**
 * Conexión del canal de WhatsApp de un negocio por Embedded Signup (F8-D, Opción B del panel).
 *
 * Mismo patrón que `datosFiscalesController.js`: ruta nombrada `:id_negocio` para que
 * `exigirPertenenciaNegocio` la cubra, y `autorizar()` como segundo cinturón mientras ese
 * middleware siga en modo observación (ADR-002/F2).
 */
'use strict';

const { validationResult } = require('express-validator');

const Respuesta = require('../../app_core/helpers/respuesta');
const canalEmbeddedSignup = require('../../app_core/whatsapp/canalEmbeddedSignup');
const { resolverPrincipalUsuario } = require('../../app_core/authz/principal');

async function autorizar(req, res, idNegocio) {
    const principal = await resolverPrincipalUsuario(req.usuario?.id_usuario);
    if (!principal || !principal.puedeOperarEn(idNegocio)) {
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
 * GET /admin/negocios/:id_negocio/canal-whatsapp
 *
 * Qué hay conectado hoy: nada, gestionado por EscalApp (alta manual), o propio (Embedded
 * Signup). El panel decide qué pantalla mostrar a partir de esto, no de una suposición.
 */
async function getEstado(req, res) {
    try {
        if (!validar(req, res)) return;
        const idNegocio = Number(req.params.id_negocio);
        if (!(await autorizar(req, res, idNegocio))) return;

        const estado = await canalEmbeddedSignup.obtenerEstado({ idNegocio });
        return Respuesta.success(res, 'Estado del canal de WhatsApp obtenido', estado);
    } catch (error) {
        console.error('Error en getEstado (canal-whatsapp):', error);
        return Respuesta.error(
            res,
            error.message || 'Error al obtener el estado del canal',
            error.statusCode || 500
        );
    }
}

/**
 * POST /admin/negocios/:id_negocio/canal-whatsapp/embedded-signup/canjear
 *
 * El `code` de Embedded Signup caduca en 30 segundos: se recibe y se canjea en la misma
 * petición, nunca se encola. Si Meta lo rechaza, el frontend debe pedir uno nuevo desde el
 * botón — no reintentar con el mismo.
 */
async function postCanjear(req, res) {
    try {
        if (!validar(req, res)) return;
        const idNegocio = Number(req.params.id_negocio);
        if (!(await autorizar(req, res, idNegocio))) return;

        const { code, phoneNumberId, numeroE164 } = req.body;
        const resultado = await canalEmbeddedSignup.conectar({
            idNegocio,
            code,
            phoneNumberId,
            numeroE164: numeroE164 || null,
        });
        return Respuesta.success(res, 'WhatsApp conectado', resultado);
    } catch (error) {
        // Errores de dominio (CANAL_YA_CONECTADO, META_CANJE_FALLIDO, ...) traen `.statusCode` y
        // un mensaje enseñable — se reenvían tal cual, sin volver a envolverlos.
        if (!error.statusCode) console.error('Error en postCanjear (canal-whatsapp):', error);
        return Respuesta.error(
            res,
            error.message || 'Error al conectar el canal de WhatsApp',
            error.statusCode || 500
        );
    }
}

module.exports = { getEstado, postCanjear };
