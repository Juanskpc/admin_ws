/**
 * La única superficie HTTP de Intelligence (F5-C).
 *
 * Hasta hoy Intelligence no se exponía por ningún puerto: sus clientes eran dos CLI y los
 * tests. Este archivo es el primer punto en que entra tráfico de fuera, y por eso conviene
 * dejar por escrito qué **no** cambia:
 *
 * ## El test del apagón sigue en pie (ADR-005)
 *
 * La flecha de dependencia sigue apuntando Intelligence → Vertical. Ninguna vertical importa
 * esto, ninguna lo llama, y `app.js` lo monta **detrás de dos guardas**: que el directorio
 * exista y que `INTELLIGENCE_HTTP_ENABLED=true`. Borrar `intelligence/` deja el backend
 * arrancando igual; apagar la variable lo deja como estaba antes de F5-C.
 *
 * ## Esto no está autenticado, y hay que saberlo
 *
 * Un widget de WebChat lo usa un cliente final anónimo: no hay JWT que pedir, y el
 * `Principal` de tipo `contacto` sigue reservado sin implementar (ADR-010, P13). Lo que hay
 * en su lugar:
 *
 *   1. **Apagado por defecto.** Sin `INTELLIGENCE_HTTP_ENABLED=true` no existe ni la ruta.
 *   2. **La feature comercial.** Solo se acepta tráfico de un negocio que tenga
 *      `asistente_ia`; sin ella, 403. No autentica a la persona, pero impide escribir en un
 *      negocio que ni siquiera contrató el asistente.
 *   3. El limitador global de `app.js`, que ya cubre estas rutas.
 *
 * Lo que **falta** para que esto sea público de verdad —una clave pública por negocio, orígenes
 * permitidos, un límite por sesión— es trabajo del día en que el WebChat sea producto (F8),
 * y está anotado como decisión abierta. Mientras tanto, no encender esto en producción.
 */
'use strict';
const express = require('express');
const { body, query, validationResult } = require('express-validator');

const Respuesta = require('../app_core/helpers/respuesta');
const features = require('./core/features');
const adaptador = require('./channels/webchat/adaptador');
const simulador = require('./channels/webchat/simuladorFallos');

const router = express.Router();

function revisarValidacion(req, res) {
    const errores = validationResult(req);
    if (errores.isEmpty()) return true;
    Respuesta.error(res, 'Datos inválidos', 400, errores.array());
    return false;
}

/**
 * Capa comercial (ADR-021). Es lo único que separa a un negocio de otro en esta superficie,
 * así que va en todas las rutas y no solo en la de escritura.
 */
async function exigirFeature(req, res, next) {
    const idNegocio = Number(req.body?.id_negocio ?? req.query?.id_negocio);
    if (!Number.isInteger(idNegocio) || idNegocio <= 0) {
        return Respuesta.error(res, 'Falta id_negocio', 400);
    }
    try {
        if (!(await features.estaHabilitado(idNegocio, features.FEATURE.ASISTENTE_IA))) {
            const { motivo } = await features.explicar(idNegocio, features.FEATURE.ASISTENTE_IA);
            return Respuesta.error(res, `El asistente no está habilitado: ${motivo}`, 403);
        }
        req.idNegocio = idNegocio;
        next();
    } catch (error) {
        next(error);
    }
}

// ── Ingesta ─────────────────────────────────────────────────────────────────────────────

/**
 * `202 Accepted`, y **nunca** la respuesta del bot.
 *
 * Es la regla central de ADR-016. Si esta ruta devolviera lo que el asistente contesta, el
 * canal dejaría de tener entregas asíncronas, retrasos, duplicados y reintentos — y los
 * criterios de aceptación del motor se volverían infalsificables. El widget se entera de la
 * respuesta preguntando por ella, igual que se enterará WhatsApp.
 */
router.post(
    '/webchat/mensajes',
    [
        body('id_negocio').isInt({ min: 1 }),
        body('id_sesion').isString().trim().isLength({ min: 1, max: 200 }),
        body('texto').isString().trim().isLength({ min: 1, max: 4000 }),
        body('id_mensaje').optional().isString().isLength({ max: 200 }),
        body('enviado_en').optional().isISO8601(),
    ],
    exigirFeature,
    async (req, res, next) => {
        if (!revisarValidacion(req, res)) return;
        try {
            const acuses = await adaptador.recibirDelWidget({
                idNegocio: req.idNegocio,
                idSesion: req.body.id_sesion,
                texto: req.body.texto,
                idMensajeCliente: req.body.id_mensaje || null,
                enviadoEn: req.body.enviado_en ? new Date(req.body.enviado_en) : new Date(),
            });

            // `recibidos` puede ser 0 (el simulador retuvo el mensaje para reordenarlo) o 2
            // (lo duplicó). Se devuelve tal cual: mentir aquí escondería el fallo inyectado.
            return Respuesta.success(
                res,
                'Mensaje recibido',
                {
                    recibidos: acuses.length,
                    duplicados: acuses.filter((a) => a.duplicado).length,
                    id_conversacion: acuses[0]?.id_conversacion ?? null,
                },
                202
            );
        } catch (error) {
            next(error);
        }
    }
);

// ── Entrega ─────────────────────────────────────────────────────────────────────────────

/**
 * Sondeo del buzón. Con cursor (`desde`) y no vaciando, para que repetir la pregunta tras una
 * respuesta HTTP perdida devuelva lo mismo en vez de haberse comido los mensajes.
 */
router.get(
    '/webchat/mensajes',
    [
        query('id_negocio').isInt({ min: 1 }),
        query('id_sesion').isString().trim().isLength({ min: 1, max: 200 }),
        query('desde').optional().isInt({ min: 0 }),
    ],
    exigirFeature,
    async (req, res, next) => {
        if (!revisarValidacion(req, res)) return;
        try {
            const { mensajes, cursor } = adaptador.leerDesde(
                req.idNegocio,
                req.query.id_sesion,
                Number(req.query.desde || 0)
            );
            return Respuesta.success(res, 'OK', { mensajes, cursor });
        } catch (error) {
            next(error);
        }
    }
);

// ── Simulador de fallos ─────────────────────────────────────────────────────────────────

router.put(
    '/webchat/simulador',
    [
        body('id_negocio').isInt({ min: 1 }),
        body('id_sesion').isString().trim().isLength({ min: 1, max: 200 }),
        body('duplicar').optional().isBoolean(),
        body('reordenar').optional().isBoolean(),
        body('retraso_salida_ms').optional().isInt({ min: 0, max: simulador.RETRASO_MAXIMO_MS }),
        body('fallar_salida').optional().isInt({ min: 0, max: 20 }),
    ],
    exigirFeature,
    async (req, res, next) => {
        if (!revisarValidacion(req, res)) return;
        try {
            const previo = simulador.leer(req.idNegocio, req.body.id_sesion);
            const config = simulador.configurar(req.idNegocio, req.body.id_sesion, {
                ...(req.body.duplicar !== undefined ? { duplicar: req.body.duplicar } : {}),
                ...(req.body.reordenar !== undefined ? { reordenar: req.body.reordenar } : {}),
                ...(req.body.retraso_salida_ms !== undefined
                    ? { retrasoSalidaMs: req.body.retraso_salida_ms }
                    : {}),
                ...(req.body.fallar_salida !== undefined
                    ? { fallarSalida: req.body.fallar_salida }
                    : {}),
            });

            // Apagar el reordenamiento con un mensaje retenido lo dejaría ahí para siempre, y
            // el usuario vería que «se perdió un mensaje» por culpa de la herramienta.
            let soltado = null;
            if (previo.reordenar && !config.reordenar) {
                const retenido = simulador.soltarRetenido(req.idNegocio, req.body.id_sesion);
                if (retenido) {
                    await adaptador.recibirDelWidget({
                        idNegocio: retenido.idNegocio,
                        idSesion: retenido.idExterno,
                        texto: retenido.texto,
                        idMensajeCliente: retenido.idExternoMensaje,
                        enviadoEn: retenido.enviadoEn,
                    });
                    soltado = retenido.texto;
                }
            }

            return Respuesta.success(res, 'Simulador configurado', { config, soltado });
        } catch (error) {
            next(error);
        }
    }
);

router.get(
    '/webchat/simulador',
    [query('id_negocio').isInt({ min: 1 }), query('id_sesion').isString().trim().notEmpty()],
    exigirFeature,
    (req, res) => {
        if (!revisarValidacion(req, res)) return;
        return Respuesta.success(res, 'OK', simulador.leer(req.idNegocio, req.query.id_sesion));
    }
);

// ── El widget ───────────────────────────────────────────────────────────────────────────
// Una página estática sin build ni dependencias. Es el banco de pruebas del simulador y la
// primera cosa de toda la Ola B que se puede *mirar*.
router.use('/webchat', express.static(require('path').join(__dirname, 'channels', 'webchat', 'publico')));

module.exports = router;
