/**
 * El freno por cupo — qué pasa cuando un negocio agota los mensajes que contrató.
 *
 * ## La decisión que esto congela (2026-10-10)
 *
 * Se evaluaron dos formas de frenar y se descartó la primera:
 *
 *   ✗ **Pausar el asistente.** `asistente_pausado` deja el mensaje SIN turno, o sea silencio
 *     absoluto: el cliente le escribe al restaurante y no le contesta nadie. Medido contra el
 *     cliente real, pasarse 1.000 mensajes cuesta $940 y pausar dos días le cuesta al negocio
 *     ~$900.000 en pedidos.
 *   ✓ **Degradar.** El asistente deja de conversar pero NO se calla: contesta una vez y pasa la
 *     conversación a una persona. ~8,6 mensajes por conversación → 1.
 *
 * ## Lo que se prueba aquí, y por qué cada caso
 *
 * Los cuatro fallos de este freno son caros y silenciosos:
 *
 *   1. Que **no frene** → el mes se dispara y nadie se entera hasta la factura.
 *   2. Que **frene una baja** → obligación legal incumplida por ahorrar un mensaje.
 *   3. Que **falle cerrado** → un bug en la consulta del cupo deja mudo a un negocio al día.
 *
 * Hay un cuarto que **no se cubre aquí**: que el freno se coma un «gracias» —gastaría el mismo
 * mensaje Y metería en la Bandeja una conversación que no necesita a nadie—. Depende del ORDEN
 * dentro de `decidir()` (el freno va después de `cortesia`) y probarlo exige una base de datos,
 * porque `cortesia` lee el historial. Queda sostenido por el comentario de `manejadorEscalera`
 * y por la suite de cortesía, no por una prueba de aquí.
 *
 * Sin base de datos: la escalera recibe el cupo inyectado (ADR-017, el núcleo no conoce canales),
 * así que aquí se le pasa una función y se mira qué decide.
 *
 *   npx jest __tests__/intelligence/cupo_freno.test.js
 */
'use strict';

const { crearManejadorEscalera } = require('../../intelligence/engine/manejadorEscalera');
const handoff = require('../../intelligence/engine/handoff');

const NEGOCIO = 6;

/** Una conversación viva y corriente, sin tarea a medias. */
const conversacion = (extra = {}) => ({
    id_conversacion: 'c1',
    id_negocio: NEGOCIO,
    canal: 'whatsapp',
    id_externo: '573000000000',
    estado: 'activa',
    variables: { turnos: 3 },
    humano_ultimo_en: null,
    tarea_actual: null,
    tarea_datos: null,
    ...extra,
});

const entrada = (texto, conv = conversacion()) => ({
    conversacion: conv,
    idNegocio: NEGOCIO,
    mensajes: [{ contenido: texto }],
    turno: { id_turno: 't' },
    texto,
    consumo: { costos: [] },
});

/** El Nivel 1 y el Nivel 4, que aquí solo sirven para saber si se llegó a ellos. */
const hacerEscalera = ({ cupoAgotado, determinista = null, llm = null } = {}) => {
    const visto = { determinista: 0, llm: 0 };
    const manejador = crearManejadorEscalera({
        cupoAgotado,
        resolverNegocio: async () => ({ tratamiento: 'Zona Burger', atencion: null }),
        determinista:
            determinista ??
            (async () => {
                visto.determinista += 1;
                return { pasos: [], respuestas: [], variables: {}, resultado: 'sin_respuesta', nivel: 'determinista' };
            }),
        llm:
            llm ??
            (async () => {
                visto.llm += 1;
                return { pasos: [], respuestas: [{ texto: 'lo que fuera' }], resultado: 'resuelto', nivel: 'llm' };
            }),
    });
    return { manejador, visto };
};

describe('con el cupo agotado', () => {
    test('escala en vez de callarse: contesta UNA vez y pasa a una persona', async () => {
        const { manejador, visto } = hacerEscalera({ cupoAgotado: async () => true });

        const d = await manejador(entrada('Hola, quiero pedir una hamburguesa'));

        expect(d.estado).toBe(handoff.ESTADO_HANDOFF);
        expect(d.resultado).toBe('handoff');
        // Una sola respuesta: el freno no puede generar el gasto que existe para evitar.
        expect(d.respuestas).toHaveLength(1);
        expect(String(d.respuestas[0])).not.toHaveLength(0);
        // Y no se pagó ni el flujo ni el modelo, que es de donde viene el costo.
        expect(visto.llm).toBe(0);
    });

    test('deja el rastro en el Ledger: se sabe POR QUÉ se escaló', async () => {
        const { manejador } = hacerEscalera({ cupoAgotado: async () => true });

        const d = await manejador(entrada('¿tienen domicilio?'));

        const paso = (d.pasos || []).find((p) => p.decision === 'cupo_agotado');
        expect(paso).toBeDefined();
        expect(paso.motivo.regla).toBe('mensajes_del_mes_agotados');
    });

    test('una BAJA se atiende igual: es obligación legal, no un mensaje más', async () => {
        const { manejador } = hacerEscalera({ cupoAgotado: async () => true });

        const d = await manejador(entrada('BAJA'));

        // Lo que NO puede pasar es que la baja acabe escalada a una persona: el opt-out bloquea
        // y se calla, y eso tiene que ganarle al freno.
        expect(d.estado).not.toBe(handoff.ESTADO_HANDOFF);
    });
});

describe('sin cupo agotado', () => {
    test('la escalera funciona como siempre', async () => {
        const { manejador, visto } = hacerEscalera({ cupoAgotado: async () => false });

        const d = await manejador(entrada('Hola, quiero pedir una hamburguesa'));

        expect(d.estado).not.toBe(handoff.ESTADO_HANDOFF);
        expect(visto.llm).toBe(1);
    });

    test('sin freno inyectado tampoco cambia nada (es el sistema de hasta hoy)', async () => {
        const { manejador, visto } = hacerEscalera({ cupoAgotado: null });

        const d = await manejador(entrada('Hola, quiero pedir una hamburguesa'));

        expect(d.estado).not.toBe(handoff.ESTADO_HANDOFF);
        expect(visto.llm).toBe(1);
    });
});

describe('cuando el cupo no se puede calcular', () => {
    test('falla ABIERTO: se atiende igual', async () => {
        // Un mes caro es dinero; un negocio frenado por un bug es un cliente que no entiende
        // por qué su asistente dejó de trabajar. Entre los dos errores, éste es el barato.
        const { manejador, visto } = hacerEscalera({
            cupoAgotado: async () => {
                throw new Error('la base no contestó');
            },
        });

        const d = await manejador(entrada('Hola, quiero pedir una hamburguesa'));

        expect(d.estado).not.toBe(handoff.ESTADO_HANDOFF);
        expect(visto.llm).toBe(1);
    });
});
