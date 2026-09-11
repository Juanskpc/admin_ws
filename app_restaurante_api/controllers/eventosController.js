'use strict';

const Respuesta = require('../../app_core/helpers/respuesta');
const realtime = require('../../app_core/realtime');
const { resolverPrincipalUsuario } = require('../../app_core/authz/principal');
const { CANAL } = require('../services/avisoService');

/**
 * GET /restaurante/eventos?id_negocio=N
 *
 * Deja la conexión abierta y le manda a esta pantalla un aviso cada vez que alguien del mismo
 * negocio cambia algo. Lo que viaja es una señal («cambió algo de pedidos»), nunca los datos:
 * el motivo está explicado en `app_core/realtime/index.js`.
 *
 * ## Por qué aquí se comprueba la pertenencia a mano
 *
 * `exigirPertenenciaNegocio` está montado en estas rutas, pero su modo por defecto es
 * **observación**: anota la violación en auditoría y DEJA PASAR (ver el propio middleware —
 * empezar bloqueando habría rechazado tráfico legítimo que nadie ha medido todavía).
 *
 * Para una consulta normal eso es un riesgo conocido y acotado. Para esto no: aquí no se
 * responde una vez, se abre un grifo que va escupiendo los movimientos de un negocio durante
 * horas. Un `id_negocio` ajeno en la URL sería suscribirse a la operación de otro restaurante
 * en vivo. Así que esta ruta falla cerrada **siempre**, sin importar `AUTHZ_MODO`.
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
        // No se responde nada más: la respuesta queda abierta hasta que el navegador se va.
    } catch (err) {
        console.error('[Restaurante] Error abriendo el canal de eventos:', err.message);
        // Si ya se enviaron cabeceras, la conexión está en manos de `realtime`.
        if (!res.headersSent) {
            return Respuesta.error(res, 'No se pudo abrir el canal de eventos.');
        }
    }
}

module.exports = { suscribirEventos };
