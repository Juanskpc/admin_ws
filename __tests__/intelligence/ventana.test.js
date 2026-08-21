/**
 * La ventana de 24 h y lo que el entregador aprendió con ella (F8-B).
 *
 * Estas pruebas corren contra la base de verdad porque las tres cosas que comprueban viven en
 * SQL o dependen del reloj de Postgres: de qué instante se cuenta la ventana, que un fallo no
 * reintentable no se reintente, y que el backoff efectivamente **aparte** el mensaje del
 * siguiente lote. Con dobles se probaría la aritmética, que no es donde estaba el riesgo.
 *
 * Lo que hay que poder afirmar al terminar:
 *
 *   1. Con la ventana abierta, un texto libre sale.
 *   2. Con la ventana cerrada, un texto libre **no sale**, y no se reintenta.
 *   3. Con la ventana cerrada, una plantilla sí sale. Ésta es la razón de ser de las plantillas.
 *   4. El `wamid` que devuelve Meta queda guardado, o el acuse de mañana no se puede atar a nada.
 *   5. Un 429 espera antes de reintentar en vez de quemar los cinco intentos en cinco segundos.
 */
'use strict';

require('dotenv').config();
const Models = require('../../app_core/models/conection');
const adaptador = require('../../intelligence/channels/whatsapp/adaptador');
const ventana = require('../../intelligence/channels/whatsapp/ventana');
const gateway = require('../../intelligence/channels/gateway');
const repositorio = require('../../intelligence/engine/repositorio');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };
const consulta = (sql, replacements = {}) => sequelize.query(sql, { replacements, ...SELECT });
const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;

const CANAL = 'whatsapp';
let idNegocio;
let contador = 0;
const creadas = [];

/** Un doble de la Cloud API que apunta lo que se le mandó y contesta como Meta. */
function apiFalsa({ fallo = null } = {}) {
    const enviados = [];
    return {
        enviados,
        async enviarMensaje({ para, payload }) {
            if (fallo) throw fallo;
            enviados.push({ para, payload });
            return { wamid: `wamid.PRUEBA_${enviados.length}` };
        },
    };
}

async function nuevaConversacion({ conEntranteHace = null } = {}) {
    const idExterno = `57300000${String(contador++).padStart(4, '0')}`;
    const t = await sequelize.transaction();
    let conversacion;
    try {
        conversacion = await repositorio.asegurarConversacion(
            { idNegocio, canal: CANAL, idExterno },
            { transaction: t }
        );
        await t.commit();
    } catch (error) {
        await t.rollback();
        throw error;
    }
    creadas.push(conversacion.id_conversacion);

    if (conEntranteHace !== null) {
        // Se escribe a mano y no por el motor: hace falta controlar **el instante**, que es
        // justo lo que esta suite mide.
        await sequelize.query(
            `
            INSERT INTO intelligence.mensaje
                (id_conversacion, id_negocio, direccion, canal, contenido, enviado_en, creado_en)
            VALUES (:id, :idNegocio, 'entrante', :canal, 'hola',
                    now() - (:horas || ' hours')::interval,
                    now() - (:horas || ' hours')::interval);
            `,
            { replacements: { id: conversacion.id_conversacion, idNegocio, canal: CANAL, horas: String(conEntranteHace) }, logging: false }
        );
    }
    return conversacion;
}

async function encolarSaliente(idConversacion, { contenido = 'respuesta', plantilla = null } = {}) {
    const t = await sequelize.transaction();
    try {
        const fila = await repositorio.insertarMensajeSaliente(
            { idConversacion, idNegocio, idTurno: null, canal: CANAL, contenido, plantilla },
            { transaction: t }
        );
        await t.commit();
        return fila;
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

const filaMensaje = (id) =>
    unaFila(
        `SELECT estado_entrega, intentos_entrega, id_externo, proximo_intento_en
           FROM intelligence.mensaje WHERE id_mensaje = :id;`,
        { id }
    );

beforeAll(async () => {
    const negocio = await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 1;`
    );
    if (!negocio) throw new Error('No hay negocio activo. Corre scripts/seed_dev_local.js.');
    idNegocio = negocio.id_negocio;
});

afterAll(async () => {
    if (creadas.length) {
        await sequelize.query(`DELETE FROM intelligence.mensaje WHERE id_conversacion IN (:ids);`, {
            replacements: { ids: creadas },
            logging: false,
        });
        await sequelize.query(`DELETE FROM intelligence.conversacion WHERE id_conversacion IN (:ids);`, {
            replacements: { ids: creadas },
            logging: false,
        });
    }
    await sequelize.close();
});

// ── La ventana ──────────────────────────────────────────────────────────────────────────

describe('cuándo está abierta', () => {
    test('sin ningún mensaje entrante, está cerrada', async () => {
        const c = await nuevaConversacion();
        const estado = await ventana.estado(c.id_conversacion);
        expect(estado.abierta).toBe(false);
        expect(estado.ultimoEntranteEn).toBeNull();
    });

    test('con un entrante de hace una hora, está abierta', async () => {
        const c = await nuevaConversacion({ conEntranteHace: 1 });
        const estado = await ventana.estado(c.id_conversacion);
        expect(estado.abierta).toBe(true);
        expect(estado.expiraEn.getTime()).toBeGreaterThan(Date.now());
    });

    test('con un entrante de hace 25 horas, está cerrada', async () => {
        const c = await nuevaConversacion({ conEntranteHace: 25 });
        const estado = await ventana.estado(c.id_conversacion);
        expect(estado.abierta).toBe(false);
        // El dato se lee igual: cerrada no es lo mismo que «no sé».
        expect(estado.ultimoEntranteEn).not.toBeNull();
    });

    test('se cuenta desde el instante de Meta, no desde el nuestro', async () => {
        // Un entrante que Meta selló hace 30 h y que a nosotros nos llegó hace 1 h — un webhook
        // reintentado, una cola atascada. Con `creado_en` la ventana parecería abierta; con el
        // sello de Meta está cerrada, que es como la ve quien decide: Meta.
        const c = await nuevaConversacion();
        await sequelize.query(
            `
            INSERT INTO intelligence.mensaje
                (id_conversacion, id_negocio, direccion, canal, contenido, enviado_en, creado_en)
            VALUES (:id, :idNegocio, 'entrante', :canal, 'hola',
                    now() - interval '30 hours', now() - interval '1 hour');
            `,
            { replacements: { id: c.id_conversacion, idNegocio, canal: CANAL }, logging: false }
        );
        const estado = await ventana.estado(c.id_conversacion);
        expect(estado.abierta).toBe(false);
    });
});

// ── Qué deja salir el adaptador ─────────────────────────────────────────────────────────

describe('entregar según la ventana', () => {
    test('texto libre con la ventana abierta: sale, y devuelve el wamid', async () => {
        const c = await nuevaConversacion({ conEntranteHace: 2 });
        const api = apiFalsa();
        const acuse = await adaptador.entregar({
            idConversacion: c.id_conversacion,
            idExterno: c.id_externo,
            mensaje: { texto: 'listo', opciones: [] },
            api,
            config: { leer: () => ({}) },
        });
        expect(api.enviados).toHaveLength(1);
        expect(api.enviados[0].payload.type).toBe('text');
        expect(acuse.idExternoCanal).toBe('wamid.PRUEBA_1');
    });

    test('texto libre con la ventana cerrada: no sale, y NO se reintenta', async () => {
        const c = await nuevaConversacion({ conEntranteHace: 26 });
        const api = apiFalsa();
        await expect(
            adaptador.entregar({
                idConversacion: c.id_conversacion,
                idExterno: c.id_externo,
                mensaje: { texto: 'listo', opciones: [] },
                api,
                config: { leer: () => ({}) },
            })
        ).rejects.toMatchObject({ code: 'WHATSAPP_FUERA_DE_VENTANA', reintentable: false });
        // Y lo que más importa: ni siquiera se gastó la llamada.
        expect(api.enviados).toHaveLength(0);
    });

    test('una plantilla con la ventana cerrada: sale. Es para lo que existen', async () => {
        const c = await nuevaConversacion({ conEntranteHace: 48 });
        const api = apiFalsa();
        await adaptador.entregar({
            idConversacion: c.id_conversacion,
            idExterno: c.id_externo,
            mensaje: {
                texto: 'Hola Ana, te recordamos tu cita…',
                plantilla: {
                    nombre: 'recordatorio_cita',
                    idioma: 'es',
                    parametros: { cliente: 'Ana', negocio: 'Barbería', servicio: 'Corte', cuando: 'mañana' },
                },
            },
            api,
            config: { leer: () => ({}) },
        });
        expect(api.enviados[0].payload.type).toBe('template');
        expect(api.enviados[0].payload.template.name).toBe('recordatorio_cita');
    });

    test('los parámetros van en el orden del catálogo, no en el del objeto', () => {
        // Mandarlos en otro orden no da error: da un mensaje que dice otra cosa.
        const payload = adaptador.renderizarPlantilla({
            nombre: 'recordatorio_cita',
            idioma: 'es',
            parametros: { cuando: 'mañana', servicio: 'Corte', negocio: 'Barbería', cliente: 'Ana' },
        });
        expect(payload.template.components[0].parameters.map((p) => p.text)).toEqual([
            'Ana',
            'Barbería',
            'Corte',
            'mañana',
        ]);
    });

    test('una plantilla que no está en el catálogo no se reintenta', () => {
        expect(() =>
            adaptador.renderizarPlantilla({ nombre: 'no_existe', idioma: 'es', parametros: {} })
        ).toThrow(expect.objectContaining({ reintentable: false }));
    });
});

// ── Lo que el entregador hace con todo eso ──────────────────────────────────────────────

// ── Los acuses ──────────────────────────────────────────────────────────────────────────

describe('un acuse de Meta se ata a nuestra fila', () => {
    test('status failed marca el saliente como fallido', async () => {
        // Meta acepta el envío con un 200 y avisa DESPUÉS de que no llegó. Sin correlacionar,
        // ese mensaje se ve en el Ledger igual que uno que sí llegó.
        const c = await nuevaConversacion({ conEntranteHace: 1 });
        const fila = await encolarSaliente(c.id_conversacion);
        gateway.limpiar();
        gateway.registrar({
            nombre: CANAL,
            entregar: async () => ({ idExternoCanal: 'wamid.ACUSE' }),
        });
        await gateway.entregarUnaVez();
        gateway.limpiar();
        expect((await filaMensaje(fila.id_mensaje)).estado_entrega).toBe('entregado');

        await adaptador.recibirWebhook(
            {
                object: 'whatsapp_business_account',
                entry: [
                    {
                        changes: [
                            {
                                field: 'messages',
                                value: {
                                    metadata: { phone_number_id: 'NUM' },
                                    statuses: [
                                        {
                                            id: 'wamid.ACUSE',
                                            status: 'failed',
                                            recipient_id: c.id_externo,
                                            errors: [{ code: 131026, title: 'Message undeliverable' }],
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            },
            { config: { resolverNegocio: () => idNegocio } }
        );

        const despues = await unaFila(
            `SELECT estado_entrega, crudo FROM intelligence.mensaje WHERE id_mensaje = :id;`,
            { id: fila.id_mensaje }
        );
        expect(despues.estado_entrega).toBe('fallido');
        expect(despues.crudo.acuse.error.code).toBe(131026);
    });
});

describe('el entregador', () => {
    afterEach(() => {
        gateway.limpiar();
    });

    test('guarda el wamid en id_externo del saliente', async () => {
        const c = await nuevaConversacion({ conEntranteHace: 1 });
        const fila = await encolarSaliente(c.id_conversacion);
        gateway.registrar({
            nombre: CANAL,
            entregar: async () => ({ idExternoCanal: 'wamid.DEVUELTO' }),
        });

        await gateway.entregarUnaVez();

        const guardado = await filaMensaje(fila.id_mensaje);
        expect(guardado.estado_entrega).toBe('entregado');
        expect(guardado.id_externo).toBe('wamid.DEVUELTO');
    });

    test('un fallo no reintentable va al dead letter en el PRIMER intento', async () => {
        const c = await nuevaConversacion({ conEntranteHace: 1 });
        const fila = await encolarSaliente(c.id_conversacion);
        gateway.registrar({
            nombre: CANAL,
            entregar: async () => {
                const e = new Error('el número no está en WhatsApp');
                e.reintentable = false;
                throw e;
            },
        });

        await gateway.entregarUnaVez();

        const guardado = await filaMensaje(fila.id_mensaje);
        expect(guardado.estado_entrega).toBe('fallido');
        expect(guardado.intentos_entrega).toBe(1);
    });

    test('un fallo reintentable espera, y no se vuelve a reclamar mientras espera', async () => {
        const c = await nuevaConversacion({ conEntranteHace: 1 });
        const fila = await encolarSaliente(c.id_conversacion);
        let intentos = 0;
        gateway.registrar({
            nombre: CANAL,
            entregar: async () => {
                intentos++;
                const e = new Error('429 Too Many Requests');
                e.reintentable = true;
                throw e;
            },
        });

        await gateway.entregarUnaVez();
        const primero = await filaMensaje(fila.id_mensaje);
        expect(primero.estado_entrega).toBe('pendiente');
        expect(new Date(primero.proximo_intento_en).getTime()).toBeGreaterThan(Date.now());

        // La segunda pasada, inmediata, NO debe volver a intentarlo. Sin el backoff, aquí es
        // donde se quemaban los cinco intentos en cinco segundos.
        await gateway.entregarUnaVez();
        expect(intentos).toBe(1);
    });
});
