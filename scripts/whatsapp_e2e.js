/**
 * Recorrido completo del canal de WhatsApp contra un «Meta» de mentira, en local (F8-A).
 *
 * ## Para qué existe
 *
 * F8 no se puede terminar sin una cuenta de Meta, pero **el canal sí se puede recorrer**. Este
 * guion levanta dos servidores de un puerto efímero —uno que hace de webhook y otro que hace de
 * Graph API— y manda por ellos una conversación entera. Lo único falso es Meta: la firma, el
 * cuerpo crudo, el adaptador, el motor, la FSM, el Policy Gate, la capacidad, el Ledger, el
 * entregador y el renderizado son los de producción.
 *
 * Es el equivalente, para un webhook, de la lección que este proyecto ya pagó tres veces: un
 * entregable no está verificado hasta que alguien lo abre. Aquí no hay pantalla que abrir, así que
 * esto es lo que hay que correr.
 *
 * ```bash
 * DB_PORT=5432 DB_PASS=... LLM_HABILITADO=false node scripts/whatsapp_e2e.js
 * ```
 *
 * Con `LLM_HABILITADO=false` no gasta un token: conduce la FSM. Sin la variable, y con clave de
 * modelo en el `.env`, el mismo recorrido pasa por el Nivel 4 y se puede pedir una cancelación.
 *
 * ## Lo que este guion hizo mal al principio, y conviene no repetir
 *
 *   1. **Los `wamid` fijos.** La segunda corrida no procesaba nada: la deduplicación por id del
 *      canal hacía su trabajo —ese mensaje ya se había recibido— y parecía que el canal estaba
 *      roto. Es el mecanismo que evita procesar dos veces un reintento de Meta, visto desde el
 *      lado incómodo. Ahora llevan la marca de la corrida.
 *   2. **Dormir un rato fijo.** El turno tarda lo que tarda (debounce, lock, capacidades contra la
 *      base) y un `sleep` calibrado a ojo da un falso negativo con todo funcionando. Se sondea.
 */
'use strict';
require('dotenv').config();

const express = require('express');
const http = require('http');
const crypto = require('crypto');

const SECRETO = 'secreto-de-prueba';
const NUMERO_NEGOCIO = '111222333';
const NUMERO_CLIENTE = `5730012${String(Date.now()).slice(-5)}`;
const NEGOCIO = Number(process.env.PRUEBA_NEGOCIO || 1);
const CORRIDA = Date.now();

// Este guion es dueño de su entorno: son valores de mentira y no deben tocar el .env de nadie.
process.env.WHATSAPP_APP_SECRET = SECRETO;
process.env.WHATSAPP_VERIFY_TOKEN = 'verificame';
process.env.WHATSAPP_PHONE_NUMBER_ID = NUMERO_NEGOCIO;
process.env.WHATSAPP_TOKEN = 'token-falso';
process.env.WHATSAPP_NEGOCIO_ID = String(NEGOCIO);
process.env.FEATURES_FORZADAS = process.env.FEATURES_FORZADAS || 'asistente_ia';
process.env.NODE_ENV = 'test';
process.env.CONVERSACION_DEBOUNCE_MS = '200';
process.env.CONVERSACION_DEBOUNCE_MAX_MS = '800';

const intelligence = require('../intelligence');
const { crearRutas } = require('../intelligence/channels/whatsapp/rutas');
const gateway = require('../intelligence/channels/gateway');
const Models = require('../app_core/models/conection');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const recibidoPorMeta = [];

/** El «Meta» de mentira: acepta el POST de la Cloud API y devuelve un wamid como el de verdad. */
async function levantarGraphFalso() {
    const app = express();
    app.use(express.json());
    app.post('/:version/:numero/messages', (req, res) => {
        recibidoPorMeta.push(req.body);
        res.json({
            messaging_product: 'whatsapp',
            contacts: [{ input: req.body.to, wa_id: req.body.to }],
            messages: [{ id: `wamid.FALSO${recibidoPorMeta.length}` }],
        });
    });
    const servidor = http.createServer(app);
    await new Promise((r) => servidor.listen(0, r));
    return { servidor, url: `http://127.0.0.1:${servidor.address().port}` };
}

/** El webhook, montado como en `app.js`: la rama cruda ANTES del parser global. */
async function levantarWebhook() {
    const app = express();
    app.use('/intelligence/whatsapp/webhook', crearRutas());
    app.use(express.json());
    const servidor = http.createServer(app);
    await new Promise((r) => servidor.listen(0, r));
    return { servidor, url: `http://127.0.0.1:${servidor.address().port}/intelligence/whatsapp/webhook` };
}

function cuerpoDeMensaje(texto, n) {
    return {
        object: 'whatsapp_business_account',
        entry: [
            {
                id: 'waba-prueba',
                changes: [
                    {
                        field: 'messages',
                        value: {
                            messaging_product: 'whatsapp',
                            metadata: { display_phone_number: '573001112233', phone_number_id: NUMERO_NEGOCIO },
                            contacts: [{ profile: { name: 'Nico' }, wa_id: NUMERO_CLIENTE }],
                            messages: [
                                {
                                    from: NUMERO_CLIENTE,
                                    id: `wamid.PRUEBA_${CORRIDA}_${n}`,
                                    timestamp: String(Math.floor(Date.now() / 1000)),
                                    type: 'text',
                                    text: { body: texto },
                                },
                            ],
                        },
                    },
                ],
            },
        ],
    };
}

async function mandar(url, cuerpo) {
    const crudo = JSON.stringify(cuerpo);
    const firma = `sha256=${crypto.createHmac('sha256', SECRETO).update(crudo).digest('hex')}`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma },
        body: crudo,
    });
    return r.status;
}

/** Sondea el entregador hasta que salga algo. Devuelve lo que «Meta» recibió. */
async function esperarRespuesta({ intentos = 30, cada = 400 } = {}) {
    const antes = recibidoPorMeta.length;
    for (let i = 0; i < intentos; i += 1) {
        await gateway.entregarUnaVez();
        if (recibidoPorMeta.length > antes) return recibidoPorMeta.at(-1);
        await dormir(cada);
    }
    return null;
}

async function estadoConversacion() {
    const [fila] = await Models.sequelize.query(
        `SELECT estado FROM intelligence.conversacion WHERE canal = 'whatsapp' AND id_externo = :n;`,
        { replacements: { n: NUMERO_CLIENTE }, type: Models.sequelize.QueryTypes.SELECT, logging: false }
    );
    return fila?.estado ?? '(sin conversación)';
}

function pintar(enviado) {
    if (!enviado) return '   ← nada salió. Algo está roto.';
    if (enviado.type === 'text') return `   ← texto: ${enviado.text.body}`;
    const i = enviado.interactive;
    const filas =
        i.type === 'button'
            ? i.action.buttons.map((b) => b.reply.title)
            : i.action.sections[0].rows.map((r) => (r.description ? `${r.title} — ${r.description}` : r.title));
    return `   ← ${i.type}: ${i.body.text}\n      ${filas.join('  |  ')}`;
}

(async () => {
    const graph = await levantarGraphFalso();
    process.env.WHATSAPP_API_URL = graph.url;

    const webhook = await levantarWebhook();

    intelligence.arrancar();
    const escalera = intelligence.montarEscalera();
    await intelligence.arrancarMotor(escalera.manejador, { recuperar: false });
    intelligence.arrancarCanales({ iniciarEntrega: false });

    console.log(`\nNivel 4: ${escalera.nivel4 || 'ninguno (solo FSM)'} · cliente ${NUMERO_CLIENTE}`);

    let n = 0;
    for (const texto of ['hola', '1']) {
        n += 1;
        const estado = await mandar(webhook.url, cuerpoDeMensaje(texto, n));
        const enviado = await esperarRespuesta();
        console.log(`\n→ cliente: "${texto}"   (webhook HTTP ${estado})`);
        console.log(pintar(enviado));
    }

    // Firma inválida: no entra nada.
    const malo = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' },
        body: JSON.stringify(cuerpoDeMensaje('impostor', 98)),
    });
    console.log(`\n→ webhook con firma inválida → HTTP ${malo.status} (esperado 403)`);

    // Un webhook de otro número: se ignora, no se atribuye a nadie.
    const ajeno = cuerpoDeMensaje('soy de otro negocio', 97);
    ajeno.entry[0].changes[0].value.metadata.phone_number_id = '999999';
    await mandar(webhook.url, ajeno);
    await dormir(400);
    console.log('→ webhook de otro phone_number_id → 200 y descartado (el aviso sale arriba)');

    // El corte de los ~14 días, tal como lo manda Meta.
    await mandar(webhook.url, {
        object: 'whatsapp_business_account',
        entry: [
            {
                id: 'waba-prueba',
                changes: [
                    {
                        field: 'account_update',
                        value: {
                            metadata: { phone_number_id: NUMERO_NEGOCIO },
                            event: 'PARTNER_REMOVED',
                            phone_number: '573001112233',
                            disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
                        },
                    },
                ],
            },
        ],
    });
    await dormir(600);

    // La baja: silencio y bloqueo.
    const antes = recibidoPorMeta.length;
    await mandar(webhook.url, cuerpoDeMensaje('STOP', 50));
    for (let i = 0; i < 20 && (await estadoConversacion()) !== 'bloqueada'; i += 1) {
        await gateway.entregarUnaVez();
        await dormir(400);
    }
    console.log('\n→ cliente: "STOP"');
    console.log(`   estado de la conversación: ${await estadoConversacion()} (esperado bloqueada)`);
    console.log(`   mensajes que Meta recibió después: ${recibidoPorMeta.length - antes} (esperado 0)`);

    // Y si vuelve a escribir, sigue bloqueada y nadie le contesta.
    await mandar(webhook.url, cuerpoDeMensaje('hola?', 51));
    await dormir(1500);
    await gateway.entregarUnaVez();
    console.log(
        `   vuelve a escribir → estado ${await estadoConversacion()}, ` +
            `mensajes recibidos por Meta: ${recibidoPorMeta.length - antes} (esperado 0)`
    );

    await new Promise((r) => graph.servidor.close(r));
    await new Promise((r) => webhook.servidor.close(r));
    process.exit(0);
})();
