/**
 * Router de webhooks de cobranza. Se monta en `app.js` **antes** del rate limiter y **antes**
 * del `express.json()` global, y ninguna de las dos cosas es una preferencia de estilo:
 *
 * - **Antes del parser JSON**, porque las dos pasarelas firman el **cuerpo crudo**. dLocal hace
 *   HMAC-SHA256 sobre los bytes exactos; `express.json()` los lee, los parsea y los tira, y
 *   reserializar el objeto produce otros bytes —otro orden de claves, otro escapado— así que la
 *   firma no casa y el error no menciona nada de esto. Es el mismo motivo por el que el webhook
 *   de WhatsApp ya vive fuera del parser global.
 *
 * - **Antes del rate limiter**, porque el límite global (200/15 min en producción) es para
 *   humanos con navegador. Una pasarela reintentando una ráfaga de eventos lo agota, se lleva un
 *   429, reintenta más… y los pagos quedan sin confirmar por un límite que existía para otra cosa.
 *   Aquí va un límite propio, generoso, que sigue frenando un flood.
 *
 * La ruta es pública a propósito: quien llama es dLocal o Wompi, no un usuario con token. Lo que
 * autentica el mensaje es la firma.
 */
'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');

const WebhookService = require('../services/cobranzaWebhookService');
const { codigosDisponibles } = require('../../app_core/cobranza');

const router = express.Router();

// Holgado: mil eventos cada cinco minutos es mucho más de lo que dos pasarelas van a mandar,
// y sigue cortando un flood.
const limitador = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * `express.raw` deja los bytes tal cual en `req.body`; se copian a `req.rawBody` porque es donde
 * los buscan los adaptadores (y donde ya los busca el resto del proyecto).
 */
const cuerpoCrudo = express.raw({ type: '*/*', limit: '1mb' });

router.post('/:pasarela', limitador, cuerpoCrudo, async (req, res) => {
    const pasarela = String(req.params.pasarela || '').toLowerCase();

    if (!codigosDisponibles().includes(pasarela)) {
        // 404 y no 400: para quien sondea, esta ruta simplemente no existe.
        return res.status(404).json({ success: false, message: 'No encontrado' });
    }

    req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    try {
        const resultado = await WebhookService.recibir(pasarela, req);

        if (resultado.estado === 'firma_invalida') {
            return res.status(401).json({ success: false, message: 'Firma inválida' });
        }

        // Duplicado o aceptado, la respuesta es la misma y es inmediata: la pasarela solo
        // necesita saber que llegó. Lo que haya que hacer se hace después de contestar.
        res.status(200).json({ success: true });

        if (resultado.estado === 'aceptado') {
            setImmediate(() => {
                WebhookService.procesarEnSegundoPlano(
                    pasarela,
                    resultado.evento,
                    resultado.verificado
                );
            });
        }
        return undefined;
    } catch (err) {
        console.error(`[Cobranza/webhook:${pasarela}] fallo al recibir:`, err.message);
        // 500 hace que la pasarela reintente, que es justo lo que queremos si fuimos nosotros
        // los que fallamos.
        return res.status(500).json({ success: false, message: 'Error al recibir el evento' });
    }
});

module.exports = router;
