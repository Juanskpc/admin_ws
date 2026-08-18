/**
 * El productor de `intelligence.costo` (F6 — ADR-022).
 *
 * F5-A creó la tabla y la dejó vacía a propósito; F5-E destapó que `invocacion_capacidad`
 * tampoco tenía productor. Esta suite existe para que `costo` no repita la historia: comprueba
 * que el gasto **llega a la base**, con el número exacto, y —lo que de verdad importa— que
 * **sobrevive a que el manejador falle**, porque para entonces los tokens ya se pagaron.
 *
 * ADR-022 trata el costo con estándar contable, no de telemetría: «los logs se pueden perder;
 * esto no». Un turno con LLM sin su fila de costo es un agujero en la factura que nadie detecta
 * hasta fin de mes.
 *
 * Requiere:   npm run migrate:intelligence-ledger
 * Correr con: npx jest __tests__/intelligence/ --runInBand
 */
require('dotenv').config();
const Models = require('../../app_core/models/conection');
const motor = require('../../intelligence/engine/motor');
const { CONFIG: COLA_CONFIG } = require('../../intelligence/engine/cola');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };

const CANAL = 'test_costo';
const DEBOUNCE_TEST = 200;

let idNegocio;
let contador = 0;

const consulta = (sql, replacements = {}) => sequelize.query(sql, { replacements, ...SELECT });
const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;
const nuevoInterlocutor = () => `costo_${Date.now()}_${contador++}`;

const conversacionDe = (idExterno) =>
    unaFila(
        `SELECT * FROM intelligence.conversacion WHERE canal = :canal AND id_externo = :idExterno;`,
        { canal: CANAL, idExterno }
    );

const turnoDe = (idConversacion) =>
    unaFila(
        `SELECT * FROM intelligence.turno WHERE id_conversacion = :id ORDER BY secuencia LIMIT 1;`,
        { id: idConversacion }
    );

const costosDe = (idConversacion) =>
    consulta(`SELECT * FROM intelligence.costo WHERE id_conversacion = :id ORDER BY creado_en;`, {
        id: idConversacion,
    });

/** Un uso de modelo con números redondos, para poder comprobar el importe a mano. */
const USO = {
    proveedor: 'anthropic',
    modelo: 'claude-opus-5',
    tokensEntrada: 1000, // 1000 × $5/MTok      = $0.005
    tokensSalida: 200, //    200 × $25/MTok     = $0.005
    tokensCacheLectura: 2000, // 2000 × $0.5/MTok = $0.001
    tokensCacheEscritura: 0,
    costoUsd: '0.01100000',
    latenciaMs: 42,
};

/** Empuja un turno por el motor con el manejador que se le pase. */
async function turnoCon(manejador, texto = 'hola') {
    const quien = nuevoInterlocutor();
    motor.registrarManejador(manejador);
    await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto });
    await motor.drenar();
    const conversacion = await conversacionDe(quien);
    return { conversacion, turno: await turnoDe(conversacion.id_conversacion) };
}

beforeAll(async () => {
    const negocio = await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 1;`
    );
    if (!negocio) throw new Error('No hay ningún negocio activo. Corre scripts/seed_dev_local.js.');
    idNegocio = negocio.id_negocio;

    COLA_CONFIG.debounceMs = DEBOUNCE_TEST;
    COLA_CONFIG.debounceMaxMs = DEBOUNCE_TEST * 4;
});

beforeEach(() => motor._reiniciar());
afterEach(() => motor.detener());

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
        for (const tabla of ['costo', 'mensaje', 'turno']) {
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

describe('productor de intelligence.costo', () => {
    it('un turno determinista no escribe NINGUNA fila de costo y queda como tal', async () => {
        const { conversacion, turno } = await turnoCon(async () => ({
            respuestas: ['Menú: 1) Corte'],
            nivel: 'determinista',
        }));

        expect(await costosDe(conversacion.id_conversacion)).toHaveLength(0);
        expect(turno.nivel).toBe('determinista');
    }, 20000);

    it('escribe el gasto con el importe exacto y marca el turno como llm', async () => {
        const { conversacion, turno } = await turnoCon(async ({ consumo }) => {
            consumo.costos.push({ ...USO });
            return { respuestas: ['Un corte cuesta $35.000.'], nivel: 'llm' };
        });

        const costos = await costosDe(conversacion.id_conversacion);
        expect(costos).toHaveLength(1);
        // `numeric` vuelve como cadena del driver: se compara como cadena, sin pasar por Number.
        expect(String(costos[0].costo_usd)).toBe('0.01100000');
        expect(costos[0].modelo).toBe('claude-opus-5');
        expect(costos[0].tokens_cache_lectura).toBe(2000);
        expect(costos[0].id_turno).toBe(turno.id_turno);
        expect(turno.nivel).toBe('llm');
    }, 20000);

    it('el gasto SOBREVIVE a que el manejador falle después de llamar al modelo', async () => {
        const { conversacion, turno } = await turnoCon(async ({ consumo }) => {
            consumo.costos.push({ ...USO });
            const e = new Error('el manejador se rompió después de gastar');
            e.code = 'ROTO_A_PROPOSITO';
            throw e;
        });

        // La decisión se perdió —eso es correcto, el savepoint la deshizo— pero los tokens
        // se pagaron igual y la fila tiene que estar. Es la diferencia entre un Ledger y un log.
        expect(await costosDe(conversacion.id_conversacion)).toHaveLength(1);
        expect(turno.resultado).toBe('error');
        expect(turno.error_codigo).toBe('ROTO_A_PROPOSITO');
        expect(turno.nivel).toBe('llm');
    }, 20000);

    it('no se puede gastar y declararse determinista', async () => {
        const { conversacion, turno } = await turnoCon(async ({ consumo }) => {
            consumo.costos.push({ ...USO });
            // El manejador miente: gasta y dice que fue el Nivel 1.
            return { respuestas: ['contesto'], nivel: 'determinista' };
        });

        expect(await costosDe(conversacion.id_conversacion)).toHaveLength(1);
        // La pregunta 12 del Ledger es el ratio determinista-vs-IA; sería la primera en mentir.
        expect(turno.nivel).toBe('llm');
    }, 20000);

    it('varias llamadas en un turno dejan una fila cada una', async () => {
        const { conversacion } = await turnoCon(async ({ consumo }) => {
            consumo.costos.push({ ...USO });
            consumo.costos.push({ ...USO, tokensSalida: 400 });
            return { respuestas: ['listo'], nivel: 'llm' };
        });

        const costos = await costosDe(conversacion.id_conversacion);
        expect(costos).toHaveLength(2);
        // Una fila por llamada y no una suma por turno: así se puede responder «¿cuántas
        // vueltas dio y cuánto costó cada una?», que es lo que se mira cuando un turno sale caro.
        expect(costos.map((c) => c.tokens_salida).sort()).toEqual([200, 400]);
    }, 20000);

});
