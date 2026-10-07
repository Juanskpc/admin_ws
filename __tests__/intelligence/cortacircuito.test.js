/**
 * Cortacircuito de bucles (2026-10-06).
 *
 * El caso: un número de empresa le escribió al WhatsApp de un negocio de citas; cada mensaje
 * suyo llegaba como `[unsupported]` y el asistente contestó «Elige uno de los servicios de la
 * lista, por favor.» 929 veces en 11 horas. Ver `intelligence/engine/cortacircuito.js`.
 *
 * La primera mitad prueba la decisión, sin base. La segunda monta el motor de verdad contra la
 * base LOCAL y comprueba lo que importa: que el mensaje NO sale.
 *
 * Correr con:  DB_PORT=5432 npx jest __tests__/intelligence/cortacircuito.test.js --forceExit
 */
require('dotenv').config();
const Models = require('../../app_core/models/conection');
const motor = require('../../intelligence/engine/motor');
const cortacircuito = require('../../intelligence/engine/cortacircuito');
const { CONFIG: COLA_CONFIG } = require('../../intelligence/engine/cola');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };
const CONFIG = { repetidas: 3, ilegibles: 3, ventanaHoras: 6, maxPorHora: 40, maxPorDia: 120 };
const ELIGE = 'Elige uno de los servicios de la lista, por favor.';

describe('la decisión', () => {
    const decidir = (datos) => cortacircuito.decidir(datos, CONFIG);

    test('EL CASO: ya lo dijo tres veces seguidas → la cuarta no sale, y no cambia el estado', () => {
        const corte = decidir({
            respuestas: [ELIGE],
            entrantesDelTurno: ['[unsupported]'],
            ultimasDelAsistente: [ELIGE, ELIGE, ELIGE, '¡Hola! ¿En qué te puedo ayudar?'],
            ilegiblesEnVentana: 3,
            enLaHora: 4,
            enElDia: 4,
        });
        expect(corte).toMatchObject({ regla: 'repeticion', pasar_a_persona: false });
    });

    test('dos veces seguidas todavía no', () => {
        expect(decidir({ respuestas: [ELIGE], ultimasDelAsistente: [ELIGE, ELIGE] })).toBeNull();
        expect(decidir({ respuestas: [ELIGE], ultimasDelAsistente: [ELIGE, ELIGE, 'otra cosa'] })).toBeNull();
    });

    test('si ahora tiene OTRA cosa que decir, habla (una persona que por fin eligió)', () => {
        expect(
            decidir({ respuestas: ['¿Para qué día?'], ultimasDelAsistente: [ELIGE, ELIGE, ELIGE] })
        ).toBeNull();
    });

    test('se compara sin mayúsculas ni espacios de más, y vale la forma canónica', () => {
        const corte = decidir({
            respuestas: [{ texto: `  ${ELIGE.toUpperCase()}  `, opciones: [] }],
            ultimasDelAsistente: [ELIGE, ELIGE, ELIGE],
        });
        expect(corte.regla).toBe('repeticion');
    });

    test('mensajes ilegibles: se contestan tres, el cuarto se ignora aunque la respuesta varíe', () => {
        const base = { respuestas: ['No pude leer tu mensaje.'], entrantesDelTurno: ['[unsupported]'], ultimasDelAsistente: ['a', 'b', 'c'] };
        expect(decidir({ ...base, ilegiblesEnVentana: 3 })).toBeNull();
        expect(decidir({ ...base, ilegiblesEnVentana: 4 })).toMatchObject({ regla: 'ilegibles', pasar_a_persona: false });
    });

    test('un ilegible junto a un texto de verdad no es un turno ilegible', () => {
        expect(
            decidir({
                respuestas: ['Claro'],
                entrantesDelTurno: ['[unsupported]', 'quiero una cita'],
                ilegiblesEnVentana: 9,
            })
        ).toBeNull();
    });

    test('demasiadas respuestas en una hora, o en un día → pasa a una persona', () => {
        expect(decidir({ respuestas: ['x'], enLaHora: 40, enElDia: 40 })).toMatchObject({
            regla: 'ritmo_hora',
            pasar_a_persona: true,
        });
        expect(decidir({ respuestas: ['x'], enLaHora: 5, enElDia: 120 })).toMatchObject({
            regla: 'ritmo_dia',
            pasar_a_persona: true,
        });
        expect(decidir({ respuestas: ['x'], enLaHora: 39, enElDia: 119 })).toBeNull();
    });

    test('un turno que no iba a decir nada no se toca', () => {
        expect(decidir({ respuestas: [], ultimasDelAsistente: [ELIGE, ELIGE, ELIGE], enLaHora: 99 })).toBeNull();
    });

    test('una regla en 0 queda apagada', () => {
        const apagado = { ...CONFIG, repetidas: 0, maxPorHora: 0 };
        expect(
            cortacircuito.decidir({ respuestas: [ELIGE], ultimasDelAsistente: [ELIGE, ELIGE, ELIGE], enLaHora: 500 }, apagado)
        ).toBeNull();
    });

    test('si la base falla, el turno sigue: un cortacircuito roto no deja mudo al asistente', async () => {
        const espia = jest.spyOn(sequelize, 'query').mockRejectedValueOnce(new Error('sin base'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const corte = await cortacircuito.evaluar({
            conversacion: { id_conversacion: 'c1', id_negocio: 1 },
            mensajes: [{ contenido: '[unsupported]' }],
            respuestas: [ELIGE],
        });
        expect(corte).toBeNull();
        expect(espia).toHaveBeenCalled();
        jest.restoreAllMocks();
    });
});

describe('en el motor, contra la base', () => {
    /** Canal sintético: nada real usa este nombre, así que la limpieza es inequívoca. */
    const CANAL = 'test_cortacircuito';
    const originales = { ...cortacircuito.CONFIG };
    let idNegocio;
    let contador = 0;

    const consulta = (sql, replacements = {}) => sequelize.query(sql, { replacements, ...SELECT });
    const nuevo = () => `bot_${Date.now()}_${contador++}`;
    const conversacionDe = async (idExterno) =>
        (
            await consulta(
                `SELECT * FROM intelligence.conversacion
                  WHERE id_negocio = :idNegocio AND canal = :canal AND id_externo = :idExterno;`,
                { idNegocio, canal: CANAL, idExterno }
            )
        )[0];
    const salientesDe = (id) =>
        consulta(
            `SELECT contenido FROM intelligence.mensaje
              WHERE id_conversacion = :id AND direccion = 'saliente' ORDER BY creado_en;`,
            { id }
        );
    /** Un mensaje del otro bot y su turno, de uno en uno: como llegaron de verdad. */
    const escribe = async (quien, texto) => {
        await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto });
        await motor.drenar();
    };

    beforeAll(async () => {
        const [negocio] = await consulta(
            `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 1;`
        );
        if (!negocio) throw new Error('No hay ningún negocio activo. Corre scripts/seed_dev_local.js.');
        idNegocio = negocio.id_negocio;
        COLA_CONFIG.debounceMs = 50;
        COLA_CONFIG.debounceMaxMs = 200;
    });

    beforeEach(() => {
        Object.assign(cortacircuito.CONFIG, originales);
        motor._reiniciar();
        // El flujo de citas atascado en «elige un servicio»: diga lo que diga el otro, lo mismo.
        motor.registrarManejador(async () => ({ respuestas: [ELIGE], nivel: 'determinista' }));
    });

    afterEach(() => motor.detener());

    afterAll(async () => {
        Object.assign(cortacircuito.CONFIG, originales);
        const ids = (
            await consulta(`SELECT id_conversacion FROM intelligence.conversacion WHERE canal = :canal;`, { canal: CANAL })
        ).map((f) => f.id_conversacion);
        if (ids.length > 0) {
            await sequelize.query(
                `DELETE FROM intelligence.paso WHERE id_turno IN
                    (SELECT id_turno FROM intelligence.turno WHERE id_conversacion IN (:ids));`,
                { replacements: { ids }, logging: false }
            );
            for (const tabla of ['mensaje', 'turno']) {
                await sequelize.query(`DELETE FROM intelligence.${tabla} WHERE id_conversacion IN (:ids);`, {
                    replacements: { ids },
                    logging: false,
                });
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

    test('EL CASO: ocho mensajes del otro bot → el asistente contesta tres y se calla', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const quien = nuevo();
        for (let i = 0; i < 8; i++) await escribe(quien, '[unsupported]');

        const conversacion = await conversacionDe(quien);
        const salientes = await salientesDe(conversacion.id_conversacion);
        expect(salientes.map((m) => m.contenido)).toEqual([ELIGE, ELIGE, ELIGE]);
        // Callarse no saca al asistente de la conversación.
        expect(conversacion.estado).toBe('activa');

        const cortes = await consulta(
            `SELECT p.motivo, t.resultado FROM intelligence.paso p
               JOIN intelligence.turno t USING (id_turno)
              WHERE t.id_conversacion = :id AND p.decision = 'bucle_cortado' ORDER BY t.secuencia;`,
            { id: conversacion.id_conversacion }
        );
        expect(cortes).toHaveLength(5);
        expect(cortes[0].motivo.regla).toBe('repeticion');
        expect(cortes.every((c) => c.resultado === 'sin_respuesta')).toBe(true);
        jest.restoreAllMocks();
    }, 30000);

    test('si después dice algo distinto, vuelve a hablar', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const quien = nuevo();
        for (let i = 0; i < 5; i++) await escribe(quien, 'hola');
        motor.registrarManejador(async () => ({ respuestas: ['¿Para qué día?'], nivel: 'determinista' }));
        await escribe(quien, 'corte de cabello');

        const { id_conversacion } = await conversacionDe(quien);
        expect((await salientesDe(id_conversacion)).map((m) => m.contenido)).toEqual([ELIGE, ELIGE, ELIGE, '¿Para qué día?']);
        jest.restoreAllMocks();
    }, 30000);

    test('por ritmo: pasa a una persona, no vuelve solo, y deja de abrir turnos', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        Object.assign(cortacircuito.CONFIG, { repetidas: 0, ilegibles: 0, maxPorHora: 4 });
        const quien = nuevo();
        // Una persona había intervenido antes: sin el corte, la reactivación por plazo contaría desde aquí.
        await escribe(quien, 'uno');
        await sequelize.query(
            `UPDATE intelligence.conversacion SET humano_ultimo_en = now() - interval '3 hours'
              WHERE id_negocio = :idNegocio AND canal = :canal AND id_externo = :quien;`,
            { replacements: { idNegocio, canal: CANAL, quien }, logging: false }
        );
        for (let i = 0; i < 6; i++) await escribe(quien, `mensaje ${i}`);

        const conversacion = await conversacionDe(quien);
        expect(conversacion.estado).toBe('handoff_humano');
        expect(conversacion.humano_ultimo_en).toBeNull();
        expect(await salientesDe(conversacion.id_conversacion)).toHaveLength(4);

        const turnos = await consulta(
            `SELECT resultado FROM intelligence.turno WHERE id_conversacion = :id ORDER BY secuencia;`,
            { id: conversacion.id_conversacion }
        );
        // 4 contestados + 1 que corta. Los dos mensajes siguientes ya no abren turno.
        expect(turnos.map((t) => t.resultado)).toEqual(['resuelto', 'resuelto', 'resuelto', 'resuelto', 'handoff']);

        const [auditoria] = await consulta(
            `SELECT detalle FROM auditoria.audit_evento
              WHERE modulo = 'intelligence' AND accion = 'bucle_cortado'
                AND detalle->>'id_conversacion' = :id;`,
            { id: String(conversacion.id_conversacion) }
        );
        expect(auditoria.detalle.regla).toBe('ritmo_hora');
        await sequelize.query(
            `DELETE FROM auditoria.audit_evento WHERE accion = 'bucle_cortado' AND detalle->>'id_conversacion' = :id;`,
            { replacements: { id: String(conversacion.id_conversacion) }, logging: false }
        );
        jest.restoreAllMocks();
    }, 30000);
});
