/**
 * El aviso de actividad: «sigo aquí» mientras el turno se alarga.
 *
 * ## Qué se está probando, y por qué no es cosmético
 *
 * Nace de una medición sobre producción, no de una intuición: el Nivel 1 resuelve un turno en
 * 58 ms de media y un turno que sube al modelo tarda 2317 ms. Ese silencio de dos segundos es
 * lo que el dueño llamó «va lento». No se arregla acelerando el modelo —el 95 % de esos
 * milisegundos son el viaje al proveedor— sino dejando de ser silencio.
 *
 * La parte delicada **no** es encenderlo. Es que encenderlo no pueda romper nada:
 *
 *   - un turno rápido no debe parpadear (`no avisa`),
 *   - una señal que revienta no puede llevarse la respuesta (`la señal falla`),
 *   - un turno que falla no puede dejar el temporizador vivo (`el turno revienta`),
 *   - un canal que no sabe mostrarla no debe enterarse (`canal sin la capacidad`).
 *
 * Los tres primeros son la forma de fallo que este proyecto ya pagó dos veces: una pieza
 * secundaria matando a la principal (ver `docs/ESTADO-Y-CONTINUACION.md` §4-0). Por eso aquí no
 * basta con ver el camino feliz: cada mecanismo se rompe a propósito.
 *
 * Requiere:  npm run migrate:intelligence-ledger
 * Correr con:  npx jest __tests__/intelligence/aviso_actividad.test.js --runInBand
 */
require('dotenv').config();
const Models = require('../../app_core/models/conection');
const motor = require('../../intelligence/engine/motor');
const gateway = require('../../intelligence/channels/gateway');
const apiWhatsapp = require('../../intelligence/channels/whatsapp/api');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };

/** Canal sintético: nada real usará este nombre, así que la limpieza es inequívoca. */
const CANAL = 'test_aviso';

/** Umbral corto: aquí no se está midiendo la paciencia de nadie. */
const UMBRAL = 60;

let idNegocio;
let contador = 0;

const consulta = (sql, replacements = {}) => sequelize.query(sql, { replacements, ...SELECT });
const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const nuevoInterlocutor = () => `aviso_${Date.now()}_${contador++}`;

/** Deja un mensaje guardado y devuelve la conversación, sin pasar por la cola ni el debounce. */
async function conversacionCon(texto = 'hola') {
    const idExterno = nuevoInterlocutor();
    await motor.recibir({
        idNegocio,
        canal: CANAL,
        idExterno,
        texto,
        idExternoMensaje: `wamid.${idExterno}`,
        despertar: false,
    });
    return unaFila(
        `SELECT * FROM intelligence.conversacion
          WHERE id_negocio = :idNegocio AND canal = :canal AND id_externo = :idExterno;`,
        { idNegocio, canal: CANAL, idExterno }
    );
}

/** Un manejador que tarda lo que se le diga y contesta algo. */
const manejadorQueTarda = (ms) => async () => {
    await dormir(ms);
    return { respuestas: ['listo'], resultado: 'resuelto' };
};

beforeAll(async () => {
    const negocio = await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 1;`
    );
    if (!negocio) throw new Error('No hay ningún negocio activo. Corre scripts/seed_dev_local.js.');
    idNegocio = negocio.id_negocio;
});

beforeEach(() => {
    motor._reiniciar();
    gateway.limpiar();
    motor.CONFIG.avisoActividadMs = UMBRAL;
});

afterEach(() => {
    motor.detener();
    gateway.limpiar();
});

afterAll(async () => {
    const ids = (
        await consulta(`SELECT id_conversacion FROM intelligence.conversacion WHERE canal = :canal;`, {
            canal: CANAL,
        })
    ).map((f) => f.id_conversacion);

    if (ids.length > 0) {
        await sequelize.query(
            `DELETE FROM intelligence.paso WHERE id_turno IN
                (SELECT id_turno FROM intelligence.turno WHERE id_conversacion IN (:ids));`,
            { replacements: { ids }, logging: false }
        );
        for (const tabla of ['mensaje', 'turno']) {
            await sequelize.query(
                `DELETE FROM intelligence.${tabla} WHERE id_conversacion IN (:ids);`,
                { replacements: { ids }, logging: false }
            );
        }
    }
    await sequelize.query(`DELETE FROM intelligence.ingesta_recibida WHERE canal = :canal;`, {
        replacements: { canal: CANAL },
        logging: false,
    });
    await sequelize.query(`DELETE FROM intelligence.conversacion WHERE canal = :canal;`, {
        replacements: { canal: CANAL },
        logging: false,
    });
    await sequelize.close();
});

// ── El motor ────────────────────────────────────────────────────────────────────────────────

describe('el motor avisa cuando un turno se alarga', () => {
    test('un turno lento enciende el aviso, y el Ledger lo registra', async () => {
        const avisos = [];
        motor.registrarSenalDeActividad(async (sobre) => {
            avisos.push(sobre);
            return true;
        });
        motor.registrarManejador(manejadorQueTarda(UMBRAL * 4));

        const conversacion = await conversacionCon();
        const resultado = await motor.procesarConversacion(conversacion.id_conversacion);

        expect(avisos).toHaveLength(1);
        // Lo que el canal necesita para poder mostrar algo. Sin el mensaje al que colgarlo,
        // WhatsApp no acepta un indicador «suelto».
        expect(avisos[0]).toMatchObject({
            canal: CANAL,
            idConversacion: conversacion.id_conversacion,
            idExterno: conversacion.id_externo,
            idNegocio,
        });
        expect(avisos[0].idExternoMensaje).toBe(`wamid.${conversacion.id_externo}`);

        // ADR-022: si no queda rastro, no ocurrió.
        const pasos = await consulta(
            `SELECT tipo, decision, motivo FROM intelligence.paso
              WHERE id_turno = :id AND decision = 'actividad_senalada';`,
            { id: resultado.id_turno }
        );
        expect(pasos).toHaveLength(1);
        expect(pasos[0].motivo).toMatchObject({ a_los_ms: UMBRAL, canal: CANAL });

        // Y la respuesta de verdad sigue saliendo.
        expect(resultado.respuestas.map((r) => r.texto)).toEqual(['listo']);
        expect(resultado.resultado).toBe('resuelto');
    });

    test('un turno rápido NO avisa: un indicador que parpadea se ve peor que ninguno', async () => {
        const avisos = [];
        motor.registrarSenalDeActividad(async (sobre) => {
            avisos.push(sobre);
            return true;
        });
        motor.registrarManejador(manejadorQueTarda(0));

        const conversacion = await conversacionCon();
        const resultado = await motor.procesarConversacion(conversacion.id_conversacion);

        expect(avisos).toHaveLength(0);

        const pasos = await consulta(
            `SELECT 1 FROM intelligence.paso
              WHERE id_turno = :id AND decision = 'actividad_senalada';`,
            { id: resultado.id_turno }
        );
        expect(pasos).toHaveLength(0);
    });

    test('sin señal registrada el motor funciona igual que hasta hoy', async () => {
        motor.registrarManejador(manejadorQueTarda(UMBRAL * 4));

        const conversacion = await conversacionCon();
        const resultado = await motor.procesarConversacion(conversacion.id_conversacion);

        expect(resultado.resultado).toBe('resuelto');
        expect(resultado.respuestas.map((r) => r.texto)).toEqual(['listo']);
    });

    test('avisoActividadMs = 0 lo apaga entero', async () => {
        motor.CONFIG.avisoActividadMs = 0;
        const avisos = [];
        motor.registrarSenalDeActividad(async () => {
            avisos.push(1);
            return true;
        });
        motor.registrarManejador(manejadorQueTarda(UMBRAL * 4));

        const conversacion = await conversacionCon();
        await motor.procesarConversacion(conversacion.id_conversacion);

        expect(avisos).toHaveLength(0);
    });
});

describe('romperlo a propósito: el aviso no puede llevarse el turno', () => {
    test('la señal falla y el cliente recibe su respuesta igual', async () => {
        motor.registrarSenalDeActividad(async () => {
            throw new Error('el canal se cayó justo ahora');
        });
        motor.registrarManejador(manejadorQueTarda(UMBRAL * 4));

        const conversacion = await conversacionCon();
        const resultado = await motor.procesarConversacion(conversacion.id_conversacion);

        expect(resultado.resultado).toBe('resuelto');
        expect(resultado.respuestas.map((r) => r.texto)).toEqual(['listo']);

        // No se encendió, así que tampoco se registra: la marca dice lo que pasó de verdad.
        const pasos = await consulta(
            `SELECT 1 FROM intelligence.paso
              WHERE id_turno = :id AND decision = 'actividad_senalada';`,
            { id: resultado.id_turno }
        );
        expect(pasos).toHaveLength(0);
    });

    test('el canal dice que no mostró nada: no se inventa el rastro', async () => {
        motor.registrarSenalDeActividad(async () => false);
        motor.registrarManejador(manejadorQueTarda(UMBRAL * 4));

        const conversacion = await conversacionCon();
        const resultado = await motor.procesarConversacion(conversacion.id_conversacion);

        const pasos = await consulta(
            `SELECT 1 FROM intelligence.paso
              WHERE id_turno = :id AND decision = 'actividad_senalada';`,
            { id: resultado.id_turno }
        );
        expect(pasos).toHaveLength(0);
        expect(resultado.resultado).toBe('resuelto');
    });

    test('el turno revienta y el temporizador no queda vivo detrás', async () => {
        const avisos = [];
        motor.registrarSenalDeActividad(async () => {
            avisos.push(1);
            return true;
        });
        motor.registrarManejador(async () => {
            throw new Error('el manejador se rompió antes del umbral');
        });

        const conversacion = await conversacionCon();
        const resultado = await motor.procesarConversacion(conversacion.id_conversacion);

        expect(resultado.resultado).toBe('error');

        // Si el `finally` no cancelara, esto lo cazaría: el turno acabó en 0 ms y el umbral
        // vence después.
        await dormir(UMBRAL * 3);
        expect(avisos).toHaveLength(0);
    });
});

// ── El gateway ──────────────────────────────────────────────────────────────────────────────

describe('el gateway degrada con gracia (ADR-017)', () => {
    test('un canal que no declara mostrarActividad no se entera', async () => {
        gateway.registrar({ nombre: 'canal_mudo', entregar: async () => ({}) });

        await expect(gateway.senalarActividad({ canal: 'canal_mudo' })).resolves.toBe(false);
    });

    test('un canal desconocido no revienta', async () => {
        await expect(gateway.senalarActividad({ canal: 'no_existe' })).resolves.toBe(false);
    });

    test('un canal que sí sabe recibe el sobre entero', async () => {
        const recibido = [];
        gateway.registrar({
            nombre: 'canal_locuaz',
            entregar: async () => ({}),
            mostrarActividad: async (sobre) => {
                recibido.push(sobre);
                return true;
            },
        });

        const ok = await gateway.senalarActividad({
            canal: 'canal_locuaz',
            idConversacion: 'c1',
            idExterno: '573152812484',
            idExternoMensaje: 'wamid.ABC',
            idNegocio: 12,
        });

        expect(ok).toBe(true);
        expect(recibido[0]).toEqual({
            idConversacion: 'c1',
            idExterno: '573152812484',
            idExternoMensaje: 'wamid.ABC',
            idNegocio: 12,
        });
    });

    test('un adaptador que lanza se traga aquí, no aguas arriba', async () => {
        gateway.registrar({
            nombre: 'canal_roto',
            entregar: async () => ({}),
            mostrarActividad: async () => {
                throw new Error('boom');
            },
        });

        await expect(gateway.senalarActividad({ canal: 'canal_roto' })).resolves.toBe(false);
    });
});

// ── El canal de WhatsApp ────────────────────────────────────────────────────────────────────

describe('el indicador de escritura de WhatsApp', () => {
    const config = {
        leer: () => ({
            token: 'T',
            phoneNumberId: '111',
            versionApi: 'v21.0',
            baseUrl: 'https://graph.test',
        }),
    };

    test('manda el cuerpo exacto que pide la Cloud API', async () => {
        const llamadas = [];
        const fetchImpl = async (url, opciones) => {
            llamadas.push({ url, cuerpo: JSON.parse(opciones.body) });
            return { ok: true, status: 200, text: async () => '{}' };
        };

        const ok = await apiWhatsapp.enviarIndicadorEscritura({
            wamid: 'wamid.ABC',
            fetchImpl,
            config,
        });

        expect(ok).toBe(true);
        expect(llamadas[0].url).toBe('https://graph.test/v21.0/111/messages');
        // El indicador viaja DENTRO del acuse de lectura: no hay endpoint de «solo escribiendo».
        expect(llamadas[0].cuerpo).toEqual({
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: 'wamid.ABC',
            typing_indicator: { type: 'text' },
        });
    });

    test('sin wamid no llama a nadie: Meta no acepta un indicador suelto', async () => {
        let llamado = false;
        const fetchImpl = async () => {
            llamado = true;
            return { ok: true, status: 200, text: async () => '{}' };
        };

        await expect(
            apiWhatsapp.enviarIndicadorEscritura({ wamid: null, fetchImpl, config })
        ).resolves.toBe(false);
        expect(llamado).toBe(false);
    });

    test('un rechazo de Meta devuelve false y NO lanza', async () => {
        const fetchImpl = async () => ({ ok: false, status: 400, text: async () => '{}' });

        await expect(
            apiWhatsapp.enviarIndicadorEscritura({ wamid: 'wamid.ABC', fetchImpl, config })
        ).resolves.toBe(false);
    });

    test('la red caída devuelve false y NO lanza', async () => {
        const fetchImpl = async () => {
            throw new Error('ECONNRESET');
        };

        await expect(
            apiWhatsapp.enviarIndicadorEscritura({ wamid: 'wamid.ABC', fetchImpl, config })
        ).resolves.toBe(false);
    });

    test('sin canal configurado no se intenta siquiera', async () => {
        let llamado = false;
        const fetchImpl = async () => {
            llamado = true;
            return { ok: true, status: 200, text: async () => '{}' };
        };

        await expect(
            apiWhatsapp.enviarIndicadorEscritura({
                wamid: 'wamid.ABC',
                fetchImpl,
                config: { leer: () => ({ token: null, phoneNumberId: null }) },
            })
        ).resolves.toBe(false);
        expect(llamado).toBe(false);
    });
});
