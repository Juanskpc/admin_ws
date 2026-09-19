/**
 * Conecta y desconecta el número de WhatsApp de un negocio por Embedded Signup — la Opción B del
 * panel: el cliente mantiene su propio número, su propia WABA y su propia tarjeta en Meta.
 *
 * Vive en `app_core/` y no en `intelligence/` a propósito: llama a
 * `app_core/whatsapp/embeddedSignupApi.js` (Graph API) y lo llama el controlador de
 * `app_admin_api`, que se monta sin la guarda de `fs.existsSync` que protege a `intelligence/`.
 * Ver la cabecera de `embeddedSignupApi.js` para el razonamiento completo.
 *
 * Escribe en `platform.numero_canal` con SQL crudo — esa tabla no tiene modelo Sequelize (la lee
 * `intelligence/channels/whatsapp/numeros.js` de la misma forma), así que no hay un DAO del que
 * desviarse.
 */
'use strict';

const Models = require('../models/conection');
const embeddedSignupApi = require('./embeddedSignupApi');
const { cifrar } = require('../helpers/credencialCifrada');

const CANAL = 'whatsapp';

function fallo(mensaje, { code, statusCode }) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

/**
 * Conecta el número propio de un negocio: canjea el `code`, resuelve su WABA, suscribe la app y
 * guarda la fila cifrada.
 *
 * ## De dónde sale `phoneNumberId`, y por qué no lo "descubre" este servicio
 *
 * El `code` que canjea `canjearCodigo()` solo prueba QUÉ WABA concedió el cliente
 * (`resolverWaba()` lo confirma inspeccionando el propio token, no se fía del frontend para eso).
 * El `phone_number_id` concreto, en cambio, lo entrega el SDK de Embedded Signup en el navegador
 * por un evento `message` (`WA_EMBEDDED_SIGNUP`) aparte del `code` — es el mecanismo documentado
 * de Meta, no un dato que la Graph API devuelva al canjear. Por eso el panel lo manda en el mismo
 * cuerpo de la petición. `idNegocio` NUNCA sale del cuerpo: sale de la sesión autenticada, así que
 * un `phoneNumberId` mal escrito a mano solo puede romper la conexión del propio negocio, nunca
 * escribir en la de otro.
 *
 * @param {Object} opciones
 * @param {number} opciones.idNegocio
 * @param {string} opciones.code — el code de corta vida que entregó el SDK de Embedded Signup.
 * @param {string} opciones.phoneNumberId — del evento `WA_EMBEDDED_SIGNUP` en el navegador.
 * @param {string|null} [opciones.numeroE164] — idem, si el evento lo trae.
 * @returns {Promise<{idExterno: string, numeroE164: string|null, wabaId: string}>}
 */
async function conectar({ idNegocio, code, phoneNumberId, numeroE164 = null, api = embeddedSignupApi }) {
    if (!idNegocio || !code || !phoneNumberId) {
        throw fallo('Faltan idNegocio, code o phoneNumberId.', {
            code: 'CANAL_DATOS_INCOMPLETOS',
            statusCode: 400,
        });
    }

    // Se comprueba ANTES de gastar las llamadas a Meta: un negocio ya conectado no necesita
    // canjear nada de nuevo, y el índice único parcial (uq_numero_canal_negocio_activo) solo
    // protegería el INSERT, no ahorraría la llamada.
    const yaConectado = await Models.sequelize.query(
        `SELECT 1 FROM platform.numero_canal
          WHERE canal = :canal AND id_negocio = :idNegocio AND estado = 'A' LIMIT 1;`,
        { replacements: { canal: CANAL, idNegocio }, type: Models.sequelize.QueryTypes.SELECT }
    );
    if (yaConectado.length > 0) {
        throw fallo('Este negocio ya tiene un número de WhatsApp conectado.', {
            code: 'CANAL_YA_CONECTADO',
            statusCode: 409,
        });
    }

    const { accessToken } = await api.canjearCodigo({ code });
    const { wabaId, businessId } = await api.resolverWaba({ accessToken });
    await api.suscribirApp({ wabaId, accessToken });

    const idExterno = String(phoneNumberId);
    const tokenCifrado = cifrar(accessToken);

    const t = await Models.sequelize.transaction();
    try {
        await Models.sequelize.query(
            `INSERT INTO platform.numero_canal
                 (canal, id_externo, id_negocio, numero_e164, estado, origen, token_cifrado, waba_id, business_id)
             VALUES (:canal, :idExterno, :idNegocio, :numeroE164, 'A', 'embedded_signup', :tokenCifrado, :wabaId, :businessId)
             ON CONFLICT (canal, id_externo) DO UPDATE SET
                 id_negocio = EXCLUDED.id_negocio,
                 numero_e164 = EXCLUDED.numero_e164,
                 estado = 'A',
                 origen = 'embedded_signup',
                 token_cifrado = EXCLUDED.token_cifrado,
                 waba_id = EXCLUDED.waba_id,
                 business_id = EXCLUDED.business_id;`,
            {
                replacements: {
                    canal: CANAL,
                    idExterno,
                    idNegocio,
                    numeroE164,
                    tokenCifrado,
                    wabaId,
                    businessId,
                },
                transaction: t,
            }
        );
        await t.commit();
    } catch (error) {
        await t.rollback();
        // El único parcial (uq_numero_canal_negocio_activo) es el respaldo si dos peticiones
        // llegaron a la vez entre el SELECT de arriba y este INSERT — poco probable, pero la
        // comprobación previa no lo descarta del todo.
        if (error.name === 'SequelizeUniqueConstraintError') {
            throw fallo('Este negocio ya tiene un número de WhatsApp conectado.', {
                code: 'CANAL_YA_CONECTADO',
                statusCode: 409,
            });
        }
        throw error;
    }

    // La caché de `numeros.js` tiene un TTL de 60s y se acepta tal cual (ver la Capa 4 del plan):
    // no se invalida desde aquí para no cruzar hacia `intelligence/` desde `app_core`.

    return { idExterno, numeroE164, wabaId };
}

/**
 * Marca inactiva la conexión de un negocio y borra el token guardado — usado por
 * `intelligence/channels/whatsapp/adaptador.js` cuando Meta avisa que el cliente desconectó su
 * número desde su lado (`account_update`, evento `PARTNER_REMOVED`), solo para filas
 * `origen = 'embedded_signup'`.
 */
async function desconectar({ idNegocio, motivo = null }) {
    if (!idNegocio) {
        throw fallo('Falta idNegocio.', { code: 'CANAL_DATOS_INCOMPLETOS', statusCode: 400 });
    }
    await Models.sequelize.query(
        `UPDATE platform.numero_canal
            SET estado = 'I', token_cifrado = NULL
          WHERE canal = :canal AND id_negocio = :idNegocio AND estado = 'A'
            AND origen = 'embedded_signup';`,
        { replacements: { canal: CANAL, idNegocio } }
    );
}

/**
 * Qué hay conectado hoy para un negocio — usado por el endpoint de estado del panel.
 */
async function obtenerEstado({ idNegocio }) {
    const filas = await Models.sequelize.query(
        `SELECT id_externo, numero_e164, origen, estado
           FROM platform.numero_canal
          WHERE canal = :canal AND id_negocio = :idNegocio AND estado = 'A'
          LIMIT 1;`,
        { replacements: { canal: CANAL, idNegocio }, type: Models.sequelize.QueryTypes.SELECT }
    );
    if (filas.length === 0) {
        return { conectado: false, origen: null, numeroE164: null, estado: null };
    }
    const fila = filas[0];
    return {
        conectado: true,
        origen: fila.origen,
        numeroE164: fila.numero_e164,
        estado: fila.estado,
    };
}

module.exports = { conectar, desconectar, obtenerEstado };
