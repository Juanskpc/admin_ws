/**
 * F8-C — varios números, cada uno atendiendo a su negocio.
 *
 * ## Lo que de verdad hay que poder afirmar
 *
 * El canal tenía **un** número global, y eso significaba dos cosas a la vez:
 *
 *   1. Un webhook solo se atribuía bien si venía de ese número.
 *   2. **Todo lo que salía, salía por ese número.** Aunque la conversación fuera de otro negocio.
 *
 * La segunda es la peligrosa, y no es hipotética: el 2026-08-28 un recordatorio de la peluquería
 * salió por el número del restaurante, la persona contestó «No puedo ir» y le respondió el
 * asistente del restaurante ofreciéndole domicilio. El plan de F8-C llama al punto 6 «el cambio
 * que más fácil se olvida y el que peor falla». Estas pruebas existen sobre todo por él.
 *
 * La otra mitad es una propiedad de aislamiento que ya cerró F2 y que no puede aflojarse al meter
 * la tabla: **un número que no es nuestro no se enruta a nadie.** Adivinar el negocio sería
 * escribir en la conversación de otro inquilino.
 *
 * ⚠️ Contra la base LOCAL (DB_PORT=5432).
 */
'use strict';
require('dotenv').config();

const Models = require('../../app_core/models/conection');
const numeros = require('../../intelligence/channels/whatsapp/numeros');
const config = require('../../intelligence/channels/whatsapp/config');
const api = require('../../intelligence/channels/whatsapp/api');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };

const CORRIDA = String(Date.now()).slice(-7);
const NUM_A = `pnid_A_${CORRIDA}`;
const NUM_B = `pnid_B_${CORRIDA}`;

let negocioA;
let negocioB;
const entornoPrevio = {};

beforeAll(async () => {
    const negocios = await sequelize.query(
        `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 2;`,
        SELECT
    );
    if (negocios.length < 2) throw new Error('Hacen falta 2 negocios activos.');
    negocioA = negocios[0].id_negocio;
    negocioB = negocios[1].id_negocio;

    // El entorno se guarda y se limpia: si esta máquina tiene un número en el `.env`, el
    // respaldo se activaría y estas pruebas medirían otra cosa.
    for (const k of ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_NEGOCIO_ID', 'WHATSAPP_TOKEN']) {
        entornoPrevio[k] = process.env[k];
    }

    await sequelize.query(
        `
        INSERT INTO platform.numero_canal (canal, id_externo, id_negocio, numero_e164)
        VALUES ('whatsapp', :na, :ga, '+573000000001'),
               ('whatsapp', :nb, :gb, '+573000000002')
        ON CONFLICT (canal, id_externo) DO NOTHING;
        `,
        { replacements: { na: NUM_A, ga: negocioA, nb: NUM_B, gb: negocioB }, logging: false }
    );
});

afterAll(async () => {
    await sequelize.query(
        `DELETE FROM platform.numero_canal WHERE id_externo IN (:a, :b);`,
        { replacements: { a: NUM_A, b: NUM_B }, logging: false }
    );
    for (const [k, v] of Object.entries(entornoPrevio)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await sequelize.close();
});

beforeEach(async () => {
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_NEGOCIO_ID;
    numeros._reiniciar();
    await numeros.asegurarCargado({ forzar: true });
});

describe('de número a negocio (punto 5)', () => {
    test('cada número lleva a SU negocio', () => {
        expect(numeros.negocioDe(NUM_A)).toBe(negocioA);
        expect(numeros.negocioDe(NUM_B)).toBe(negocioB);
    });

    test('un número que no es nuestro no lleva a ninguno', () => {
        // La propiedad de F2: no se adivina, no hay negocio por defecto. Aflojar esto es
        // escribir en la conversación de otro inquilino.
        expect(numeros.negocioDe('pnid_de_otro')).toBeNull();
        expect(numeros.negocioDe(null)).toBeNull();
        expect(numeros.negocioDe('')).toBeNull();
    });

    test('`config.resolverNegocio` contesta lo mismo: sigue habiendo un solo traductor', () => {
        expect(config.resolverNegocio(NUM_B)).toBe(negocioB);
        expect(config.resolverNegocio('pnid_de_otro')).toBeNull();
    });
});

describe('de negocio a número (punto 6) — el que peor falla', () => {
    test('cada negocio contesta desde SU número', () => {
        expect(numeros.numeroDe(negocioA)).toBe(NUM_A);
        expect(numeros.numeroDe(negocioB)).toBe(NUM_B);
    });

    test('enviar usa el número del negocio dueño, no el primero que haya', async () => {
        // Ésta es la prueba del incidente del 2026-08-28.
        process.env.WHATSAPP_TOKEN = 'token_de_prueba';
        const urls = [];
        const fetchFalso = async (url) => {
            urls.push(url);
            // `api.js` lee el cuerpo con `.text()` y luego lo parsea: un doble con `.json()`
            // pasaría por esta prueba y no por el código real.
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ messages: [{ id: 'wamid.X' }] }),
            };
        };

        await api.enviarMensaje({
            para: '573001112233',
            payload: { type: 'text', text: { body: 'hola' } },
            idNegocio: negocioB,
            fetchImpl: fetchFalso,
        });

        expect(urls[0]).toContain(`/${NUM_B}/messages`);
        expect(urls[0]).not.toContain(NUM_A);
    });

    test('un negocio sin número no envía «por el que haya»: falla y no reintenta', async () => {
        process.env.WHATSAPP_TOKEN = 'token_de_prueba';
        const sinNumero = 999999;

        await expect(
            api.enviarMensaje({
                para: '573001112233',
                payload: { type: 'text', text: { body: 'hola' } },
                idNegocio: sinNumero,
                fetchImpl: async () => {
                    throw new Error('no debería llegar a la red');
                },
            })
        ).rejects.toMatchObject({ code: 'WHATSAPP_NEGOCIO_SIN_NUMERO', reintentable: false });
    });
});

describe('el respaldo por variables de entorno', () => {
    test('con la tabla vacía se usa el `.env`, así que un despliegue sin migrar sigue vivo', async () => {
        process.env.WHATSAPP_PHONE_NUMBER_ID = 'pnid_del_entorno';
        process.env.WHATSAPP_NEGOCIO_ID = String(negocioA);

        // Se simula «tabla vacía» leyendo con un canal que no existe: lo que se comprueba es la
        // rama de respaldo, sin borrar filas que otra prueba pueda estar usando.
        numeros._reiniciar();
        const original = sequelize.query.bind(sequelize);
        sequelize.query = async (sql, opts) =>
            String(sql).includes('platform.numero_canal') && String(sql).includes('SELECT')
                ? []
                : original(sql, opts);
        try {
            await numeros.asegurarCargado({ forzar: true });
            expect(numeros.negocioDe('pnid_del_entorno')).toBe(negocioA);
            expect(numeros.listar().origen).toBe('variables de entorno');
        } finally {
            sequelize.query = original;
        }
    });

    test('cuando hay filas, mandan las filas', async () => {
        process.env.WHATSAPP_PHONE_NUMBER_ID = 'pnid_del_entorno';
        process.env.WHATSAPP_NEGOCIO_ID = String(negocioA);
        numeros._reiniciar();
        await numeros.asegurarCargado({ forzar: true });

        expect(numeros.listar().origen).toBe('platform.numero_canal');
        expect(numeros.negocioDe('pnid_del_entorno')).toBeNull();
    });
});

describe('estado() (punto 7)', () => {
    test('ya no dice «un solo número»: lista los que hay y de dónde salen', () => {
        process.env.WHATSAPP_APP_SECRET = 'x';
        process.env.WHATSAPP_VERIFY_TOKEN = 'x';
        process.env.WHATSAPP_TOKEN = 'x';

        const e = config.estado();
        expect(e.habilitado).toBe(true);
        expect(e.resumen).toContain('platform.numero_canal');
        expect(e.resumen).toContain(NUM_A);
        expect(e.resumen).toContain(NUM_B);
        expect(e.resumen).not.toContain('Un solo número');
    });
});
