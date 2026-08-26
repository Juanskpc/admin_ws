/**
 * Canal de WhatsApp (F8-A) — la mitad que **sí** se puede verificar sin un número de Meta.
 *
 * La frontera de esta suite es deliberada y conviene tenerla presente al leerla: se prueba la
 * firma, la traducción de la entrada, el renderizado de la salida y las rutas del webhook, todo
 * contra cargas con la forma que Meta documenta. Lo que **no** se prueba aquí es que Meta acepte
 * lo que enviamos — eso necesita credenciales y es F8-C. `api.js` está aislado justo para que esa
 * frontera se vea.
 *
 * Corre **sin Postgres y sin red**: el adaptador recibe dobles del motor, del repositorio y de la
 * API. Es la misma frontera que permitió probar la FSM de F5-D sin base.
 */
'use strict';

const express = require('express');
const http = require('http');

const firma = require('../../intelligence/channels/whatsapp/firma');
const { renderizar, interpretarWebhook, textoDeMensaje, LIMITES } = require('../../intelligence/channels/whatsapp/adaptador');
const { crearRutas } = require('../../intelligence/channels/whatsapp/rutas');

const SECRETO = 'app-secret-de-prueba';
const VERIFY = 'token-de-verificacion';
const NUMERO = '1234567890';
const NEGOCIO = 7;

/** Config de mentira: la misma costura que en producción lee variables de entorno. */
const configFalsa = (extra = {}) => ({
    leer: () => ({
        appSecret: SECRETO,
        verifyToken: VERIFY,
        phoneNumberId: NUMERO,
        token: 'token-cloud-api',
        idNegocio: NEGOCIO,
        versionApi: 'v21.0',
        baseUrl: 'https://graph.example',
        ...extra,
    }),
    resolverNegocio: (phoneNumberId) => (String(phoneNumberId) === NUMERO ? NEGOCIO : null),
});

/** Una carga de Meta, con la forma real: entry[].changes[].value */
function webhook(valor, { phoneNumberId = NUMERO, field = 'messages' } = {}) {
    return {
        object: 'whatsapp_business_account',
        entry: [
            {
                id: 'waba-1',
                changes: [
                    {
                        field,
                        value: {
                            messaging_product: 'whatsapp',
                            metadata: { display_phone_number: '573001112233', phone_number_id: phoneNumberId },
                            ...valor,
                        },
                    },
                ],
            },
        ],
    };
}

const mensajeTexto = (texto, id = 'wamid.AAA') => ({
    messages: [
        {
            from: '573001234567',
            id,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: texto },
        },
    ],
});

// ── La firma ────────────────────────────────────────────────────────────────────────────

describe('firma del webhook', () => {
    const cuerpo = Buffer.from(JSON.stringify({ hola: 'mundo' }), 'utf8');

    test('acepta la firma que calcula Meta', () => {
        const valida = firma.calcular(cuerpo, SECRETO);
        expect(firma.verificar({ cuerpoCrudo: cuerpo, firma: valida, secreto: SECRETO })).toEqual({
            valida: true,
            motivo: null,
        });
    });

    test('rechaza un cuerpo alterado aunque venga la firma del original', () => {
        // El ataque real: interceptar un webhook legítimo y cambiarle el texto.
        const valida = firma.calcular(cuerpo, SECRETO);
        const alterado = Buffer.from(JSON.stringify({ hola: 'otro' }), 'utf8');

        const r = firma.verificar({ cuerpoCrudo: alterado, firma: valida, secreto: SECRETO });
        expect(r.valida).toBe(false);
        expect(r.motivo).toBe('FIRMA_NO_COINCIDE');
    });

    test('reserializar el JSON rompe la firma — el motivo de que exista la rama de parseo crudo', () => {
        // Esto es lo que pasaría si se verificara sobre `JSON.stringify(req.body)`: los mismos
        // datos, otros bytes. Con espacios de más ya no casa, y el error no menciona el parser.
        const valida = firma.calcular(cuerpo, SECRETO);
        const reserializado = Buffer.from(JSON.stringify({ hola: 'mundo' }, null, 2), 'utf8');

        expect(firma.verificar({ cuerpoCrudo: reserializado, firma: valida, secreto: SECRETO }).valida).toBe(false);
    });

    test('sin App Secret NO se acepta nada, ni siquiera una firma bien formada', () => {
        // El modo de fallo que convierte una configuración a medias en un endpoint abierto.
        const r = firma.verificar({ cuerpoCrudo: cuerpo, firma: firma.calcular(cuerpo, SECRETO), secreto: null });
        expect(r).toEqual({ valida: false, motivo: 'SIN_APP_SECRET' });
    });

    test('distingue «no hay cuerpo crudo» de «la firma es mala»', () => {
        // Son dos averías con arreglos opuestos: una es la composición del servidor, la otra un
        // secreto mal puesto. Confundirlas cuesta una tarde.
        expect(firma.verificar({ cuerpoCrudo: undefined, firma: 'sha256=abc', secreto: SECRETO }).motivo).toBe(
            'SIN_CUERPO_CRUDO'
        );
    });

    test('rechaza firma ausente, sin prefijo o de otra longitud', () => {
        expect(firma.verificar({ cuerpoCrudo: cuerpo, secreto: SECRETO }).motivo).toBe('SIN_FIRMA');
        expect(firma.verificar({ cuerpoCrudo: cuerpo, firma: 'abc', secreto: SECRETO }).motivo).toBe('FIRMA_SIN_PREFIJO');
        expect(firma.verificar({ cuerpoCrudo: cuerpo, firma: 'sha256=corta', secreto: SECRETO }).motivo).toBe(
            'FIRMA_LONGITUD'
        );
    });
});

// ── Entrada: traducir lo que manda Meta ─────────────────────────────────────────────────

describe('interpretar el webhook', () => {
    const config = configFalsa();

    test('un mensaje de texto se convierte en Mensaje Canónico', () => {
        const { mensajes } = interpretarWebhook(webhook(mensajeTexto('hola')), { config });

        expect(mensajes).toHaveLength(1);
        expect(mensajes[0]).toMatchObject({
            canal: 'whatsapp',
            idNegocio: NEGOCIO,
            idExterno: '573001234567',
            texto: 'hola',
            idExternoMensaje: 'wamid.AAA',
        });
        expect(mensajes[0].enviadoEn).toBeInstanceOf(Date);
    });

    test('un webhook de OTRO número no se procesa ni se adivina a quién es', () => {
        // Si esto se atribuyera al negocio por defecto, se escribiría en la conversación de otro
        // inquilino: exactamente la fuga que cerró F2.
        const r = interpretarWebhook(webhook(mensajeTexto('hola'), { phoneNumberId: '999' }), { config });

        expect(r.mensajes).toHaveLength(0);
        expect(r.ajenos).toBe(1);
    });

    test('el toque de un botón llega como el id de la opción, igual que un chip del WebChat', () => {
        // Es lo que hace que el núcleo no sepa qué es un botón: la FSM compara contra la lista
        // que ofreció, así que recibe «1» tanto del widget como de WhatsApp.
        const boton = {
            messages: [
                {
                    from: '573001234567',
                    id: 'wamid.B',
                    timestamp: '1700000000',
                    type: 'interactive',
                    interactive: { type: 'button_reply', button_reply: { id: '1', title: 'Corte de cabello' } },
                },
            ],
        };
        expect(interpretarWebhook(webhook(boton), { config }).mensajes[0].texto).toBe('1');
    });

    test('una fila de lista también, y una respuesta de plantilla usa su payload', () => {
        expect(
            textoDeMensaje({
                type: 'interactive',
                interactive: { type: 'list_reply', list_reply: { id: '10:00', title: '10:00' } },
            })
        ).toBe('10:00');
        expect(textoDeMensaje({ type: 'button', button: { payload: 'si', text: 'Sí' } })).toBe('si');
    });

    test('una foto entra marcada por su tipo y sin inventar contenido', () => {
        // No se le ponen palabras en la boca al cliente: no escribió nada. Con el marcador el bot
        // repregunta, que es honesto. Leer un comprobante de pago es F8-B.
        const imagen = {
            messages: [{ from: '573001234567', id: 'wamid.C', timestamp: '1700000000', type: 'image', image: { id: 'x' } }],
        };
        const { mensajes } = interpretarWebhook(webhook(imagen), { config });

        expect(mensajes[0].texto).toBe('[image]');
        expect(mensajes[0].crudo).toEqual({ tipo: 'image', soportado: false });
    });

    test('un eco del negocio NO es un mensaje del cliente', () => {
        // La trampa que §6.13 dejó anotada para F8: con la coexistencia, lo que el dueño escribe
        // desde su móvil llega por webhook. Tratarlo como entrada del cliente le metería al motor
        // las palabras del negocio como si fueran de quien pregunta.
        const eco = {
            message_echoes: [
                { from: '573001112233', to: '573001234567', id: 'wamid.E', timestamp: '1700000000', type: 'text' },
            ],
        };
        const r = interpretarWebhook(webhook(eco, { field: 'smb_message_echoes' }), { config });

        expect(r.mensajes).toHaveLength(0);
        expect(r.ecos).toEqual([{ idNegocio: NEGOCIO, idExterno: '573001234567', wamid: 'wamid.E', tipo: 'text' }]);
    });

    test('el corte de los ~14 días llega como aviso de cuenta y se puede ver', () => {
        // Confirmado en la documentación de Meta: PRIMARY_INACTIVITY ≈ 14 días sin abrir la app.
        // Enterarse por el webhook es la diferencia con enterarse porque un cliente se queja.
        const aviso = {
            event: 'PARTNER_REMOVED',
            phone_number: '573001112233',
            disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
        };
        const r = interpretarWebhook(webhook(aviso, { field: 'account_update' }), { config });

        expect(r.avisos).toEqual([
            {
                idNegocio: NEGOCIO,
                evento: 'PARTNER_REMOVED',
                motivo: 'PRIMARY_INACTIVITY',
                iniciadoPor: 'SYSTEM',
                numero: '573001112233',
            },
        ]);
    });

    test('un acuse de entrega fallida se distingue del resto', () => {
        const estados = {
            statuses: [
                { id: 'wamid.X', status: 'failed', recipient_id: '573001234567', errors: [{ code: 131026 }] },
                { id: 'wamid.Y', status: 'read', recipient_id: '573001234567' },
            ],
        };
        const r = interpretarWebhook(webhook(estados, { field: 'messages' }), { config });

        expect(r.estados.map((e) => e.estado)).toEqual(['failed', 'read']);
        expect(r.estados[0].error).toEqual({ code: 131026 });
    });

    test('un webhook vacío no revienta', () => {
        expect(interpretarWebhook({}, { config }).mensajes).toHaveLength(0);
        expect(interpretarWebhook(null, { config }).mensajes).toHaveLength(0);
    });
});

// ── Salida: renderizar al formato del canal ─────────────────────────────────────────────

describe('renderizar la respuesta', () => {
    test('sin opciones, un texto plano y sin previsualizar enlaces', () => {
        const p = renderizar({ texto: 'Un corte cuesta $35.000.' });
        expect(p).toEqual({ type: 'text', text: { preview_url: false, body: 'Un corte cuesta $35.000.' } });
    });

    test('hasta tres opciones, botones nativos', () => {
        const p = renderizar({
            texto: '¿Confirmo la cita?',
            opciones: [
                { id: 'si', etiqueta: 'Sí, confirmar' },
                { id: 'no', etiqueta: 'Ver otras horas' },
            ],
        });
        expect(p.interactive.type).toBe('button');
        expect(p.interactive.action.buttons.map((b) => b.reply.id)).toEqual(['si', 'no']);
    });

    test('un título de botón se recorta a 20 caracteres, o Meta rechaza el mensaje entero', () => {
        // Un servicio con nombre largo dejaría al cliente sin respuesta: el fallo no sería el
        // botón, sería el silencio.
        const p = renderizar({
            texto: 'Elige',
            opciones: [{ id: '1', etiqueta: 'Corte de cabello con lavado y peinado' }],
        });
        const titulo = p.interactive.action.buttons[0].reply.title;
        expect(titulo.length).toBeLessThanOrEqual(LIMITES.tituloBoton);
    });

    test('de cuatro a diez opciones, una lista', () => {
        const opciones = Array.from({ length: 8 }, (_, i) => ({ id: String(i), etiqueta: `Opción ${i}` }));
        const p = renderizar({ texto: '¿Qué servicio?', opciones });

        expect(p.interactive.type).toBe('list');
        expect(p.interactive.action.sections[0].rows).toHaveLength(8);
    });

    test('más de diez, se degrada a texto enumerado y no se pierde la elección', () => {
        // La degradación con gracia de ADR-017: el canal no puede pintar 12 opciones, pero el
        // cliente sigue pudiendo elegir escribiendo, y la FSM lo resuelve igual.
        const opciones = Array.from({ length: 12 }, (_, i) => ({ id: String(i), etiqueta: `Opción ${i}` }));
        const p = renderizar({ texto: 'Elige una', opciones });

        expect(p.type).toBe('text');
        expect(p.text.body).toContain('Opción 11');
    });

    test('con detalle va a lista aunque quepan en botones, y el precio sobrevive', () => {
        // El problema real que trajo `detalle` al Mensaje Canónico: un botón recorta el título a 20
        // caracteres y «Corte de cabello (30 min) — $35.000» llegaba como «Corte de cabello (3…».
        // El precio es justo lo que el cliente quería saber.
        const p = renderizar({
            texto: '¿Qué servicio?',
            opciones: [
                { id: '1', etiqueta: 'Corte de cabello', detalle: '30 min — $35.000' },
                { id: '2', etiqueta: 'Tinte', detalle: '90 min — $120.000' },
            ],
        });

        expect(p.interactive.type).toBe('list');
        expect(p.interactive.action.sections[0].rows[0]).toEqual({
            id: '1',
            title: 'Corte de cabello',
            description: '30 min — $35.000',
        });
    });

    test('sin detalle, dos opciones siguen siendo botones', () => {
        // La lista no sustituye al botón: solo gana cuando hay un dato que el botón no puede
        // llevar. «¿Confirmo la cita?» con sí/no sigue siendo un toque.
        const p = renderizar({
            texto: '¿Confirmo la cita?',
            opciones: [
                { id: 'si', etiqueta: 'Sí, confirmar' },
                { id: 'no', etiqueta: 'No' },
            ],
        });
        expect(p.interactive.type).toBe('button');
    });

    test('degradado a texto, el detalle tampoco se pierde', () => {
        const opciones = Array.from({ length: 12 }, (_, i) => ({
            id: String(i),
            etiqueta: `Servicio ${i}`,
            detalle: `${i}0 min`,
        }));
        expect(renderizar({ texto: 'Elige', opciones }).text.body).toContain('Servicio 11 — 110 min');
    });

    test('un texto vacío no manda un mensaje vacío', () => {
        expect(renderizar({ texto: '   ' }).text.body).toBe('…');
    });
});

// ── Las rutas del webhook ───────────────────────────────────────────────────────────────

describe('las rutas del webhook', () => {
    let servidor;
    let base;
    let recibidos;

    beforeAll(async () => {
        recibidos = [];
        const adaptadorFalso = {
            async recibirWebhook(cuerpo) {
                recibidos.push(cuerpo);
                return { recibidos: 1, ecos: 0, avisos: 0, estados: 0, ajenos: 0, acuses: [] };
            },
        };

        const app = express();
        // Igual que en `app.js`: la rama cruda ANTES de cualquier parser global. Aquí se monta
        // además un `express.json()` global después, para que el test recorra el mismo orden.
        app.use('/webhook', crearRutas({ config: configFalsa(), adaptador: adaptadorFalso }));
        app.use(express.json());

        servidor = http.createServer(app);
        await new Promise((r) => servidor.listen(0, r));
        base = `http://127.0.0.1:${servidor.address().port}/webhook`;
    });

    afterAll(async () => {
        await new Promise((r) => servidor.close(r));
    });

    const postear = (cuerpo, { conFirma = true, secreto = SECRETO } = {}) => {
        const crudo = JSON.stringify(cuerpo);
        return fetch(base, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(conFirma ? { 'X-Hub-Signature-256': firma.calcular(crudo, secreto) } : {}),
            },
            body: crudo,
        });
    };

    test('el saludo de suscripción devuelve el challenge en texto plano', async () => {
        // Sin el sobre de `Respuesta`: Meta espera el challenge desnudo y con el sobre la
        // suscripción falla sin decir por qué.
        const r = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
        expect(r.status).toBe(200);
        expect(await r.text()).toBe('12345');
    });

    test('con el token equivocado, 403 y sin detalle', async () => {
        const r = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=12345`);
        expect(r.status).toBe(403);
    });

    test('un POST firmado se acepta con 200 y se procesa', async () => {
        const cuerpo = webhook(mensajeTexto('hola'));
        const r = await postear(cuerpo);

        expect(r.status).toBe(200);
        // El adaptador se llama con el cuerpo ya parseado.
        expect(recibidos.at(-1)).toEqual(cuerpo);
    });

    test('un POST sin firma es 403 y NO se procesa', async () => {
        const antes = recibidos.length;
        const r = await postear(webhook(mensajeTexto('soy un impostor')), { conFirma: false });

        expect(r.status).toBe(403);
        expect(recibidos).toHaveLength(antes);
    });

    test('un POST firmado con otro secreto tampoco entra', async () => {
        const antes = recibidos.length;
        const r = await postear(webhook(mensajeTexto('tampoco')), { secreto: 'otro-secreto' });

        expect(r.status).toBe(403);
        expect(recibidos).toHaveLength(antes);
    });

    test('la respuesta NO trae la respuesta del bot: son los 10 segundos de Meta', async () => {
        // ADR-016 lo pedía por disciplina; aquí es el contrato del canal. Si esta ruta esperara al
        // bot, Meta cortaría y reintentaría, y el cliente recibiría respuestas duplicadas.
        const r = await postear(webhook(mensajeTexto('¿cuánto cuesta un corte?')));
        expect(await r.text()).toBe('OK');
    });
});

// ── Un webhook es un lote, y un fallo no puede llevárselo entero ─────────────────────────

describe('quién habla, y qué pasa cuando no se sabe', () => {
    // ## El fallo (2026-08-26, en producción)
    //
    // Una persona escribió «Buenas tardes» al número del negocio y **no recibió nada**. En el
    // log, una sola línea: «fallo procesando el webhook: El mensaje canónico necesita saber
    // quién habla». El mensaje llegó sin `from`, el núcleo lo rechazó —con razón— y la excepción
    // se llevó por delante el resto del webhook. Ya se había contestado 200 a Meta, así que no
    // hubo reintento: ese mensaje se perdió del todo.
    //
    // Dos cosas estaban mal, y la segunda es la grave:
    //   1. Se leía solo `from`, cuando Meta manda el mismo número en `contacts[].wa_id`.
    //   2. Un elemento malo abortaba el lote entero.
    const adaptador = require('../../intelligence/channels/whatsapp/adaptador');

    const config = {
        resolverNegocio: (phoneNumberId) => (phoneNumberId === 'PN-1' ? 12 : null),
        leer: () => ({}),
    };

    /** Un cambio de webhook, con lo que se le quiera poner dentro. */
    const webhook = (valor) => ({
        entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PN-1' }, ...valor } }] }],
    });

    const unMensaje = (extra = {}) => ({
        id: 'wamid.AAA',
        type: 'text',
        text: { body: 'Buenas tardes' },
        timestamp: String(Math.floor(Date.now() / 1000)),
        ...extra,
    });

    it('lo normal: el remitente sale de `from`', () => {
        const leido = adaptador.interpretarWebhook(
            webhook({ messages: [unMensaje({ from: '573150528532' })] }),
            { config }
        );
        expect(leido.mensajes[0].idExterno).toBe('573150528532');
        expect(leido.sinRemitente).toHaveLength(0);
    });

    it('sin `from`, el remitente sale de `contacts[].wa_id` — es el mismo número', () => {
        // No se adivina nada: Meta manda `contacts[]` en el mismo cambio y su `wa_id` es
        // literalmente el número de quien escribe. Es el mismo dato por otra puerta.
        const leido = adaptador.interpretarWebhook(
            webhook({
                contacts: [{ wa_id: '573150528532', profile: { name: 'Alguien' } }],
                messages: [unMensaje()],
            }),
            { config }
        );

        expect(leido.mensajes).toHaveLength(1);
        expect(leido.mensajes[0].idExterno).toBe('573150528532');
        expect(leido.mensajes[0].texto).toBe('Buenas tardes');
    });

    it('sin `from` NI contacto, se aparta con su forma — y NO tumba el webhook', () => {
        const leido = adaptador.interpretarWebhook(
            webhook({ messages: [unMensaje(), unMensaje({ from: '573114682492', id: 'wamid.BBB' })] }),
            { config }
        );

        // El bueno sigue vivo: es lo que antes se perdía.
        expect(leido.mensajes).toHaveLength(1);
        expect(leido.mensajes[0].idExterno).toBe('573114682492');

        // Y del malo queda la FORMA, para poder arreglarlo. Nunca el contenido: esto va a un log.
        expect(leido.sinRemitente).toHaveLength(1);
        expect(leido.sinRemitente[0].tipo).toBe('text');
        expect(leido.sinRemitente[0].claves).toContain('text');
        expect(JSON.stringify(leido.sinRemitente[0])).not.toContain('Buenas tardes');
    });

    it('un mensaje que revienta al procesarse no se lleva a los demás', async () => {
        // Es la mitad que de verdad importa. Meta ya recibió su 200: lo que se pierda aquí no se
        // reintenta nunca, así que un `throw` en el primero de tres era perder tres.
        const motor = require('../../intelligence/engine/motor');
        const original = motor.recibir;
        const vistos = [];
        motor.recibir = async (mensaje) => {
            vistos.push(mensaje.idExternoMensaje);
            if (mensaje.idExternoMensaje === 'wamid.MALO') throw new Error('base caída');
            return { id_mensaje: mensaje.idExternoMensaje };
        };

        try {
            const resumen = await adaptador.recibirWebhook(
                webhook({
                    messages: [
                        unMensaje({ from: '571', id: 'wamid.MALO' }),
                        unMensaje({ from: '572', id: 'wamid.BUENO' }),
                    ],
                }),
                { config }
            );

            expect(vistos).toEqual(['wamid.MALO', 'wamid.BUENO']);
            expect(resumen.acuses).toHaveLength(1);
            expect(resumen.fallos).toHaveLength(1);
            expect(resumen.fallos[0].detalle).toBe('wamid.MALO');
        } finally {
            motor.recibir = original;
        }
    });
});

// ── La identidad nueva de WhatsApp: el BSUID ────────────────────────────────────────────

describe('quien escribe sin enseñar su número (BSUID)', () => {
    // ## El fallo, y por qué no era una rareza (2026-08-26, en producción)
    //
    // Una persona escribió «Buenas tardes» dos veces y no recibió nada. El log dijo que el
    // mensaje venía sin `from` — y con `from_user_id`.
    //
    // Es el cambio de identidad de WhatsApp. Desde marzo de 2026 Meta manda un **Business-Scoped
    // User ID** (`CO.1112947687726965`: indicativo, punto, dígitos) en `messages[].from_user_id`
    // y `contacts[].user_id`; desde junio, con los nombres de usuario, **quien escribe puede no
    // tener teléfono en el webhook**. No es un caso de borde: es el estado normal de un cliente
    // nuevo que llega por su nombre de usuario.
    //
    // Y tiene dos mitades. Leerlo, y saber contestarle: a un BSUID se le escribe con `recipient`,
    // no con `to` — y si van los dos, Meta le da precedencia a `to`, así que equivocarse ahí no
    // es «casi correcto», es un mensaje que nadie recibe.
    const adaptador = require('../../intelligence/channels/whatsapp/adaptador');
    const api = require('../../intelligence/channels/whatsapp/api');

    const BSUID = 'CO.1112947687726965';

    const config = {
        resolverNegocio: (id) => (id === 'PN-1' ? 12 : null),
        leer: () => ({ token: 't', phoneNumberId: 'PN-1', baseUrl: 'https://x', versionApi: 'v21.0' }),
    };

    const webhookBsuid = {
        entry: [
            {
                changes: [
                    {
                        value: {
                            messaging_product: 'whatsapp',
                            metadata: { phone_number_id: 'PN-1' },
                            // Tal como llegó de verdad: contacto SIN `wa_id`.
                            contacts: [{ user_id: BSUID, profile: { name: 'Alguien' } }],
                            messages: [
                                {
                                    from_user_id: BSUID,
                                    id: 'wamid.HBgTQ08uMTExMjk0NzY4NzcyNjk2NRUU',
                                    type: 'text',
                                    text: { body: 'Buenas tardes' },
                                    timestamp: String(Math.floor(Date.now() / 1000)),
                                },
                            ],
                        },
                    },
                ],
            },
        ],
    };

    it('se lee el mensaje: la identidad es el BSUID', () => {
        const leido = adaptador.interpretarWebhook(webhookBsuid, { config });

        expect(leido.sinRemitente).toHaveLength(0);
        expect(leido.mensajes).toHaveLength(1);
        expect(leido.mensajes[0].idExterno).toBe(BSUID);
        expect(leido.mensajes[0].texto).toBe('Buenas tardes');
    });

    it('si viene el teléfono, MANDA el teléfono aunque también venga el BSUID', async () => {
        // El orden no es cosmético. El teléfono es lo que identifica a la persona en el resto de
        // la plataforma y lo que prueba la pertenencia de un pedido; y es la clave de las
        // conversaciones que ya existen. Con el BSUID delante, un cliente conocido estrenaría
        // conversación y perdería su historia.
        const cuerpo = JSON.parse(JSON.stringify(webhookBsuid));
        cuerpo.entry[0].changes[0].value.messages[0].from = '573150528532';
        cuerpo.entry[0].changes[0].value.contacts[0].wa_id = '573150528532';

        const leido = adaptador.interpretarWebhook(cuerpo, { config });
        expect(leido.mensajes[0].idExterno).toBe('573150528532');
    });

    it('a un BSUID se le contesta con `recipient`, NUNCA con `to`', async () => {
        let enviado = null;
        await api.enviarMensaje({
            para: BSUID,
            payload: { type: 'text', text: { body: 'hola' } },
            config,
            fetchImpl: async (_url, opciones) => {
                enviado = JSON.parse(opciones.body);
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ messages: [{ id: 'wamid.X' }] }),
                };
            },
        });

        expect(enviado.recipient).toBe(BSUID);
        // Si van los dos, Meta le da precedencia a `to` y el mensaje no llega a nadie.
        expect(enviado.to).toBeUndefined();
    });

    it('a un teléfono se le sigue contestando con `to`', async () => {
        let enviado = null;
        await api.enviarMensaje({
            para: '573150528532',
            payload: { type: 'text', text: { body: 'hola' } },
            config,
            fetchImpl: async (_url, opciones) => {
                enviado = JSON.parse(opciones.body);
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ messages: [{ id: 'wamid.X' }] }),
                };
            },
        });

        expect(enviado.to).toBe('573150528532');
        expect(enviado.recipient).toBeUndefined();
    });

    it('un BSUID NO se confunde con un teléfono probado', () => {
        // Importa para la autorización: `CO.111…` no es un número, así que quien llega así no
        // tiene teléfono verificado y las comprobaciones de pertenencia fallan CERRADAS. Es lo
        // correcto — lo que no puede pasar es que un id opaco se cuele como si fuera su móvil.
        const identidad = require('../../intelligence/engine/identidad');
        expect(api.esBsuid(BSUID)).toBe(true);
        expect(api.esBsuid('573150528532')).toBe(false);
        expect(
            identidad._normalizarTelefono
                ? identidad._normalizarTelefono(BSUID)
                : null
        ).toBeNull();
    });
});
