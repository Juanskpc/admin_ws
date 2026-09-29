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
 *
 * ## Las dos formas de conectar (desde 2026-09-28)
 *
 *   - **Coexistencia** (`modo: 'coexistencia'`): el número YA vive en la app WhatsApp Business
 *     del celular del dueño y sigue ahí. Conserva chats y contactos; el dueño puede seguir
 *     respondiendo desde el celular. NO se llama a `/register` (sacaría el número de la app). Se
 *     piden las sincronizaciones de contactos e historial (solo se pueden pedir en las 24 h
 *     siguientes). Ver `docs/embedded-signup.md` §10.
 *   - **Número dedicado** (`modo: 'nuevo'`): un número que no está en ninguna app de WhatsApp.
 *     Se registra en la Cloud API con un PIN de verificación en dos pasos que se guarda cifrado.
 *
 * El modo que pide el panel es una pista, no la verdad: si Meta dice cómo está el número
 * (`is_on_biz_app`), manda Meta.
 */
'use strict';

const crypto = require('crypto');

const Models = require('../models/conection');
const embeddedSignupApi = require('./embeddedSignupApi');
const { cifrar, descifrar } = require('../helpers/credencialCifrada');
const Audit = require('../helpers/auditHelper');

const CANAL = 'whatsapp';
const MODULO_AUDITORIA = 'canal_whatsapp';
const MODOS = Object.freeze(['coexistencia', 'nuevo']);

function fallo(mensaje, { code, statusCode }) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

/** PIN de 6 dígitos para la verificación en dos pasos de un número dedicado. */
function generarPin() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Qué número de la WABA es el que se está conectando. **Pura** — se prueba sin base ni red.
 *
 * @param {Object} p
 * @param {Array|null} p.numeros — lo que devolvió `listarNumeros()`, o `null` si no se pudo leer.
 * @param {string|null} p.phoneNumberId — lo que mandó el navegador (puede faltar).
 * @param {string} p.modo — 'coexistencia' | 'nuevo'.
 */
function elegirNumero({ numeros, phoneNumberId, modo }) {
    // Sin lista (Meta no contestó): solo se puede seguir si el navegador trajo el id. Es el
    // comportamiento de antes de verificar — la WABA sigue probada por el token.
    if (!numeros) {
        if (!phoneNumberId) {
            throw fallo(
                'No pudimos confirmar con Meta qué número conectaste. Vuelve a intentarlo en unos minutos.',
                { code: 'CANAL_NUMERO_NO_RESUELTO', statusCode: 502 }
            );
        }
        return { id: String(phoneNumberId), numeroE164: null, platformType: null, enAppBusiness: null };
    }

    if (phoneNumberId) {
        const encontrado = numeros.find((n) => n.id === String(phoneNumberId));
        if (!encontrado) {
            throw fallo(
                'El número que devolvió Meta no pertenece a la cuenta de WhatsApp que autorizaste. ' +
                    'Vuelve a intentarlo desde el botón.',
                { code: 'CANAL_NUMERO_NO_CONCEDIDO', statusCode: 400 }
            );
        }
        return encontrado;
    }

    if (numeros.length === 0) {
        throw fallo(
            'Terminaste el proceso de Meta sin agregar un número de WhatsApp. Vuelve a intentarlo y, ' +
                'en el paso del número, elige tu número de WhatsApp Business.',
            { code: 'CANAL_SIN_NUMERO', statusCode: 422 }
        );
    }

    let candidatos = numeros;
    if (modo === 'coexistencia') {
        const enApp = numeros.filter((n) => n.enAppBusiness === true);
        if (enApp.length > 0) candidatos = enApp;
    }
    if (candidatos.length > 1) {
        throw fallo(
            'Tu cuenta de WhatsApp Business tiene varios números y no pudimos saber cuál conectaste. ' +
                'Escríbenos y lo conectamos contigo.',
            { code: 'CANAL_NUMERO_AMBIGUO', statusCode: 409 }
        );
    }
    return candidatos[0];
}

/**
 * Traduce el rechazo de `/register` a algo que el dueño pueda entender y resolver. Los códigos
 * son los que documenta Meta para este endpoint; el resto se enseña con el texto de Meta.
 */
function mensajeRegistroFallido(error) {
    const codigo = error?.detalle?.code;
    if (codigo === 133005) {
        return (
            'Tu número tiene una verificación en dos pasos (PIN) puesta desde antes. Quítala en ' +
            'WhatsApp Manager (Configuración del número → Verificación en dos pasos) y vuelve a conectar.'
        );
    }
    if (codigo === 133006 || codigo === 133010) {
        return (
            'Meta todavía no terminó de verificar tu número. Espera unos minutos y vuelve a conectar; ' +
            'si sigue igual, escríbenos.'
        );
    }
    if (codigo === 133016) {
        return 'Meta bloqueó temporalmente los intentos de registro de este número. Intenta de nuevo en unas horas.';
    }
    const detalle = error?.detalle?.error_user_msg || error?.detalle?.message;
    return (
        'Meta no dejó activar tu número para enviar mensajes' +
        (detalle ? `: ${detalle}` : '.') +
        ' Vuelve a intentarlo o escríbenos.'
    );
}

async function auditar(accion, { idNegocio, idUsuario = null, resultado = 'ok', detalle }) {
    await Audit.registrarEvento({
        modulo: MODULO_AUDITORIA,
        accion,
        resultado,
        idUsuario,
        idNegocio,
        detalle,
    });
}

/**
 * Conecta el número propio de un negocio: canjea el `code`, prueba la WABA con el token, elige y
 * verifica el número, suscribe la app, lo registra si es dedicado, guarda la fila cifrada y, si es
 * coexistencia, pide la sincronización de contactos e historial.
 *
 * `idNegocio` NUNCA sale del cuerpo: sale de la sesión autenticada, así que un `phoneNumberId`
 * mal escrito a mano solo puede romper la conexión del propio negocio — y además ya no pasa la
 * verificación contra la lista de números de la WABA.
 *
 * @param {Object} opciones
 * @param {number} opciones.idNegocio
 * @param {number|null} [opciones.idUsuario] — quién pulsó el botón, para la auditoría.
 * @param {string} opciones.code — el code de corta vida que entregó el SDK (caduca en 30 s).
 * @param {string|null} [opciones.phoneNumberId] — del evento del SDK. Opcional: en coexistencia
 *        puede no venir, y entonces se descubre con `listarNumeros()`.
 * @param {string|null} [opciones.numeroE164] — respaldo cosmético.
 * @param {string|null} [opciones.businessId] — del evento del SDK; no es dato de seguridad.
 * @param {'coexistencia'|'nuevo'} [opciones.modo]
 * @returns {Promise<{idExterno: string, numeroE164: string|null, wabaId: string,
 *           coexistencia: boolean, sincronizacion: {contactos: boolean, historial: boolean}|null}>}
 */
async function conectar({
    idNegocio,
    idUsuario = null,
    code,
    phoneNumberId = null,
    numeroE164 = null,
    businessId = null,
    modo = 'nuevo',
    api = embeddedSignupApi,
}) {
    if (!idNegocio || !code) {
        throw fallo('Faltan idNegocio o code.', { code: 'CANAL_DATOS_INCOMPLETOS', statusCode: 400 });
    }
    if (!MODOS.includes(modo)) {
        throw fallo(`Modo de conexión desconocido: ${modo}.`, {
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
    const { wabaId } = await api.resolverWaba({ accessToken });

    // La lista de números de la WABA, leída con el token del cliente: verifica el id que mandó
    // el navegador, lo descubre si no vino, y dice si el número vive en la app Business.
    let lista = null;
    try {
        lista = typeof api.listarNumeros === 'function' ? await api.listarNumeros({ wabaId, accessToken }) : null;
    } catch (error) {
        console.error(`[canal-whatsapp] no se pudo listar los números de la WABA ${wabaId}:`, error.message);
    }
    const numero = elegirNumero({ numeros: lista, phoneNumberId, modo });
    const idExterno = String(numero.id);

    // Meta es la verdad cuando lo dice; si no lo dice, vale lo que eligió el dueño en el panel.
    const coexistencia =
        typeof numero.enAppBusiness === 'boolean' ? numero.enAppBusiness : modo === 'coexistencia';

    // El mismo número activo en OTRO negocio: el ON CONFLICT de abajo se lo quitaría en silencio.
    // Se para aquí, antes de suscribir o registrar nada en Meta.
    const filasPrevias = await Models.sequelize.query(
        `SELECT id_negocio, estado, pin_cifrado FROM platform.numero_canal
          WHERE canal = :canal AND id_externo = :idExterno LIMIT 1;`,
        { replacements: { canal: CANAL, idExterno }, type: Models.sequelize.QueryTypes.SELECT }
    );
    const previa = filasPrevias[0] || null;
    if (previa && previa.estado === 'A' && Number(previa.id_negocio) !== Number(idNegocio)) {
        throw fallo('Este número de WhatsApp ya está conectado a otro negocio de EscalApp.', {
            code: 'CANAL_NUMERO_EN_OTRO_NEGOCIO',
            statusCode: 409,
        });
    }

    await api.suscribirApp({ wabaId, accessToken });

    // Número dedicado sin registrar → se registra. Si ya se conectó antes con nosotros, se reusa su
    // PIN: registrar con otro distinto fallaría (133005) porque el primero sigue puesto.
    let pinCifrado = null;
    if (!coexistencia) {
        let pin = null;
        if (previa?.pin_cifrado) {
            try {
                pin = descifrar(previa.pin_cifrado);
            } catch (error) {
                console.error(`[canal-whatsapp] PIN guardado ilegible para ${idExterno}:`, error.message);
            }
        }
        pin = pin || generarPin();
        pinCifrado = cifrar(pin);

        if (numero.platformType !== 'CLOUD_API') {
            try {
                await api.registrarNumero({ phoneNumberId: idExterno, accessToken, pin });
            } catch (error) {
                await auditar('conexion_fallida', {
                    idNegocio,
                    idUsuario,
                    resultado: 'error',
                    detalle: { paso: 'register', id_externo: idExterno, waba_id: wabaId, error: error.detalle ?? error.message },
                });
                throw fallo(mensajeRegistroFallido(error), { code: 'META_REGISTRO_FALLIDO', statusCode: 502 });
            }
        }
    }

    let numeroResuelto = numero.numeroE164 || numeroE164;
    if (!numeroResuelto) {
        // Cosmético: si falla, se sigue sin número legible en vez de tumbar la conexión.
        try {
            const resultado = await api.resolverNumero({ phoneNumberId: idExterno, accessToken });
            if (resultado.numeroE164) numeroResuelto = resultado.numeroE164;
        } catch (error) {
            // No se re-lanza a propósito.
        }
    }

    const tokenCifrado = cifrar(accessToken);

    const t = await Models.sequelize.transaction();
    try {
        await Models.sequelize.query(
            `INSERT INTO platform.numero_canal
                 (canal, id_externo, id_negocio, numero_e164, estado, origen, token_cifrado, waba_id,
                  business_id, coexistencia, pin_cifrado)
             VALUES (:canal, :idExterno, :idNegocio, :numeroE164, 'A', 'embedded_signup', :tokenCifrado,
                     :wabaId, :businessId, :coexistencia, :pinCifrado)
             ON CONFLICT (canal, id_externo) DO UPDATE SET
                 id_negocio = EXCLUDED.id_negocio,
                 numero_e164 = EXCLUDED.numero_e164,
                 estado = 'A',
                 origen = 'embedded_signup',
                 token_cifrado = EXCLUDED.token_cifrado,
                 waba_id = EXCLUDED.waba_id,
                 business_id = EXCLUDED.business_id,
                 coexistencia = EXCLUDED.coexistencia,
                 pin_cifrado = EXCLUDED.pin_cifrado;`,
            {
                replacements: {
                    canal: CANAL,
                    idExterno,
                    idNegocio,
                    numeroE164: numeroResuelto,
                    tokenCifrado,
                    wabaId,
                    businessId,
                    coexistencia,
                    pinCifrado,
                },
                transaction: t,
            }
        );
        await t.commit();
    } catch (error) {
        await t.rollback();
        // El único parcial (uq_numero_canal_negocio_activo) es el respaldo si dos peticiones
        // llegaron a la vez entre el SELECT de arriba y este INSERT.
        if (error.name === 'SequelizeUniqueConstraintError') {
            throw fallo('Este negocio ya tiene un número de WhatsApp conectado.', {
                code: 'CANAL_YA_CONECTADO',
                statusCode: 409,
            });
        }
        throw error;
    }

    // Coexistencia: contactos e historial. Solo se pueden pedir en las 24 h siguientes y una vez
    // por tipo, así que se piden ya. Que fallen NO deshace la conexión: el número funciona igual y
    // los chats siguen en el celular del dueño; lo que se pierde es la copia que nos llegaría.
    let sincronizacion = null;
    if (coexistencia && typeof api.solicitarSincronizacion === 'function') {
        sincronizacion = { contactos: false, historial: false };
        for (const [tipo, clave] of [
            ['smb_app_state_sync', 'contactos'],
            ['history', 'historial'],
        ]) {
            try {
                await api.solicitarSincronizacion({ phoneNumberId: idExterno, accessToken, tipo });
                sincronizacion[clave] = true;
            } catch (error) {
                console.error(
                    `[canal-whatsapp] no se pudo pedir la sincronización "${tipo}" del negocio ${idNegocio}:`,
                    error.message
                );
            }
        }
    }

    // La caché de `numeros.js` tiene un TTL de 60s y se acepta tal cual: no se invalida desde aquí
    // para no cruzar hacia `intelligence/` desde `app_core`.

    await auditar('conectado', {
        idNegocio,
        idUsuario,
        detalle: {
            id_externo: idExterno,
            numero: numeroResuelto,
            waba_id: wabaId,
            business_id: businessId,
            coexistencia,
            modo_pedido: modo,
            sincronizacion,
        },
    });

    return { idExterno, numeroE164: numeroResuelto, wabaId, coexistencia, sincronizacion };
}

/**
 * Marca inactiva la conexión de un negocio y borra el token guardado. Dos llamadores:
 *   - `intelligence/channels/whatsapp/adaptador.js`, cuando Meta avisa que el cliente desconectó
 *     su número desde su lado (`account_update`, evento `PARTNER_REMOVED`) — ahí el token ya está
 *     revocado y no se llama a Meta.
 *   - `canalWhatsappController.js`, cuando el propio negocio pide desconectarse desde el panel
 *     (botón "Desconectar"). Ahí sí se quita la suscripción de la app a su WABA (`desuscribir`),
 *     con el token todavía válido, para que Meta deje de mandarnos sus mensajes.
 *
 * Solo toca filas `origen = 'embedded_signup'`, nunca las de alta manual.
 *
 * El PIN (`pin_cifrado`) se conserva a propósito: si el mismo número se vuelve a conectar, hay que
 * registrarlo con el mismo PIN que quedó puesto en Meta.
 *
 * @returns {Promise<{desconectado: boolean}>} `false` si no había ninguna fila activa que tocar.
 */
async function desconectar({
    idNegocio,
    idUsuario = null,
    motivo = null,
    desuscribir = false,
    api = embeddedSignupApi,
}) {
    if (!idNegocio) {
        throw fallo('Falta idNegocio.', { code: 'CANAL_DATOS_INCOMPLETOS', statusCode: 400 });
    }

    if (desuscribir) {
        const filas = await Models.sequelize.query(
            `SELECT waba_id, token_cifrado FROM platform.numero_canal
              WHERE canal = :canal AND id_negocio = :idNegocio AND estado = 'A'
                AND origen = 'embedded_signup' LIMIT 1;`,
            { replacements: { canal: CANAL, idNegocio }, type: Models.sequelize.QueryTypes.SELECT }
        );
        const fila = filas[0];
        if (fila?.waba_id && fila?.token_cifrado) {
            // Best-effort: si Meta falla, la desconexión local sigue. Los webhooks que sigan
            // llegando se descartan como ajenos (la fila queda inactiva).
            try {
                await api.desuscribirApp({ wabaId: fila.waba_id, accessToken: descifrar(fila.token_cifrado) });
            } catch (error) {
                console.error(
                    `[canal-whatsapp] no se pudo desuscribir la app de la WABA ${fila.waba_id}:`,
                    error.message
                );
            }
        }
    }

    const [, metadata] = await Models.sequelize.query(
        `UPDATE platform.numero_canal
            SET estado = 'I', token_cifrado = NULL
          WHERE canal = :canal AND id_negocio = :idNegocio AND estado = 'A'
            AND origen = 'embedded_signup';`,
        { replacements: { canal: CANAL, idNegocio } }
    );
    const desconectado = (metadata?.rowCount ?? 0) > 0;

    if (desconectado) {
        await auditar('desconectado', { idNegocio, idUsuario, detalle: { motivo, desuscribir } });
    }
    return { desconectado };
}

/**
 * Qué hay conectado hoy para un negocio — usado por el endpoint de estado del panel.
 */
async function obtenerEstado({ idNegocio }) {
    const filas = await Models.sequelize.query(
        `SELECT id_externo, numero_e164, origen, estado, coexistencia
           FROM platform.numero_canal
          WHERE canal = :canal AND id_negocio = :idNegocio AND estado = 'A'
          LIMIT 1;`,
        { replacements: { canal: CANAL, idNegocio }, type: Models.sequelize.QueryTypes.SELECT }
    );
    if (filas.length === 0) {
        return { conectado: false, origen: null, numeroE164: null, estado: null, coexistencia: false };
    }
    const fila = filas[0];
    return {
        conectado: true,
        origen: fila.origen,
        numeroE164: fila.numero_e164,
        estado: fila.estado,
        coexistencia: fila.coexistencia === true,
    };
}

module.exports = { conectar, desconectar, obtenerEstado, elegirNumero, MODOS };
