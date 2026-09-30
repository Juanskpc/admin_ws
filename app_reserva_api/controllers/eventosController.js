'use strict';

const Respuesta = require('../../app_core/helpers/respuesta');
const realtime = require('../../app_core/realtime');
const { resolverPrincipalUsuario } = require('../../app_core/authz/principal');
const { CANAL } = require('../services/avisoService');

/**
 * GET /reserva/eventos?id_negocio=N
 *
 * Deja la conexión abierta y avisa a la pantalla cada vez que cambia la agenda del negocio
 * (una cita del asistente de WhatsApp, del portal o de un compañero). Viaja una señal, nunca
 * los datos: ver `app_core/realtime/index.js`.
 *
 * La pertenencia al negocio se comprueba aquí y falla cerrada SIEMPRE, sin importar
 * `AUTHZ_MODO`: esto no responde una vez, abre un grifo con la operación de un negocio durante
 * horas (mismo criterio que `app_restaurante_api/controllers/eventosController.js`).
 */
async function suscribirEventos(req, res) {
    const idNegocio = Number(req.query.id_negocio);
    if (!Number.isInteger(idNegocio) || idNegocio <= 0) {
        return Respuesta.error(res, 'id_negocio es obligatorio.', 400);
    }

    try {
        const principal = await resolverPrincipalUsuario(req.usuario.id_usuario);
        if (!principal || !principal.puedeOperarEn(idNegocio)) {
            return Respuesta.error(res, 'No tienes acceso a este negocio.', 403);
        }

        realtime.suscribir(req, res, { canal: CANAL, idNegocio });
        // La respuesta queda abierta hasta que el navegador se va.
    } catch (err) {
        console.error('[Reserva] Error abriendo el canal de eventos:', err.message);
        if (!res.headersSent) {
            return Respuesta.error(res, 'No se pudo abrir el canal de eventos.');
        }
    }
}

module.exports = { suscribirEventos };
