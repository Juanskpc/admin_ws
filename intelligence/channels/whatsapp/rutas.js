/**
 * Las dos rutas del webhook de WhatsApp (F8-A).
 *
 * Van en su propio router, y no dentro de `intelligence/http.js`, por una razón que no es de
 * orden: **este router necesita el cuerpo crudo**, así que se monta en `app.js` *antes* del
 * `express.json()` global. Mezclarlas con las del WebChat obligaría a mover todo el router de
 * Intelligence delante del parser global, y con él el widget y el simulador, que no lo necesitan.
 *
 * ## Las dos rutas, y en qué se diferencian de todo lo demás del proyecto
 *
 * - `GET /` — el saludo de Meta al suscribir el webhook. Compara `hub.verify_token` con el nuestro
 *   y devuelve `hub.challenge` **en texto plano**. Es la única ruta del backend que no responde con
 *   el sobre de `Respuesta`: Meta espera el challenge desnudo y con `Respuesta.success` la
 *   suscripción falla sin decir por qué.
 * - `POST /` — la ingesta. Verifica la firma, contesta **200 y nada más**, y procesa. Meta corta a
 *   los 10 segundos y reintenta lo que no se conteste: una ingesta que espere al bot se convierte
 *   en mensajes duplicados. La regla de ADR-016 —«nunca la respuesta del bot»— aquí no es una
 *   elección de diseño, es el contrato del canal.
 *
 * ## Por qué se contesta 200 incluso cuando algo va mal dentro
 *
 * Salvo la firma, todo lo demás responde 200. Un 500 le dice a Meta «reintenta», y reintentar un
 * webhook que falla por una razón determinista —un tipo de mensaje que no sabemos leer— es un
 * bucle que se repite hasta que Meta desactiva el webhook. Se contesta 200, se registra el fallo, y
 * el mensaje ya está guardado: el motor lo retoma por su cuenta (`recuperar()`).
 *
 * Con una excepción: **una firma inválida es 403 y no se procesa nada**. Ahí no hay nada que
 * recuperar — no sabemos quién mandó eso.
 */
'use strict';
const express = require('express');

const configReal = require('./config');
const firma = require('./firma');
const adaptadorReal = require('./adaptador');

/**
 * @param {Object} [deps] — inyectables para los tests: se prueban las rutas sin red ni entorno.
 */
function crearRutas({ config = configReal, adaptador = adaptadorReal } = {}) {
    const router = express.Router();

    /**
     * El cuerpo crudo, y solo aquí.
     *
     * `express.json({ verify })` es la forma soportada de quedarse con los bytes: el `verify` se
     * llama con el buffer antes de parsear. La alternativa —`express.raw()` y parsear a mano—
     * obligaría a duplicar el manejo de errores de JSON mal formado.
     *
     * `type: () => true` acepta cualquier `Content-Type`: Meta manda `application/json`, pero si un
     * día manda otro y el parser lo ignora, el cuerpo llegaría vacío y la firma fallaría con un
     * motivo que no tiene nada que ver con la firma. Fallar por lo que es, no por lo que parece.
     */
    router.use(
        express.json({
            limit: '1mb',
            type: () => true,
            verify: (req, _res, buf) => {
                req.cuerpoCrudo = buf;
            },
        })
    );

    // ── Suscripción ─────────────────────────────────────────────────────────────────────
    router.get('/', (req, res) => {
        const c = config.leer();
        const modo = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (modo === 'subscribe' && c.verifyToken && token === c.verifyToken) {
            // Texto plano y sin sobre: es lo que Meta espera leer.
            return res.status(200).type('text/plain').send(String(challenge ?? ''));
        }
        // Sin detalle: quien no trae el token no necesita saber por qué falló.
        return res.sendStatus(403);
    });

    // ── Ingesta ─────────────────────────────────────────────────────────────────────────
    router.post('/', async (req, res) => {
        const c = config.leer();
        const revision = firma.verificar({
            cuerpoCrudo: req.cuerpoCrudo,
            firma: req.get(firma.CABECERA),
            secreto: c.appSecret,
        });

        if (!revision.valida) {
            // El motivo se registra aquí y no viaja en la respuesta: decirle a quien lo intenta
            // *por qué* falló su firma es ayudarle a acertar.
            console.warn(`[whatsapp] webhook rechazado: ${revision.motivo}`);
            return res.sendStatus(403);
        }

        // Se contesta ANTES de procesar. No es una optimización: son los 10 segundos de Meta.
        res.sendStatus(200);

        try {
            const resumen = await adaptador.recibirWebhook(req.body, { config });
            if (resumen.ajenos > 0) {
                console.warn(
                    `[whatsapp] ${resumen.ajenos} cambio(s) de un phone_number_id que no es ` +
                        'nuestro. Se ignoran: adivinar el negocio sería escribir en la ' +
                        'conversación de otro inquilino.'
                );
            }
        } catch (error) {
            // Ya se contestó 200, así que esto no puede propagarse al manejador de errores de
            // Express. Se registra y se queda aquí; el mensaje está guardado y el motor lo retoma.
            console.error(`[whatsapp] fallo procesando el webhook: ${error.message}`);
        }
    });

    return router;
}

module.exports = { crearRutas, router: crearRutas() };
