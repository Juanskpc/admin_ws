/**
 * Handoff — las tres decisiones del dueño del 2026-08-18 (la mitad de ADR-023 que faltaba).
 *
 * Son reglas de producto, no de mecánica, y por eso tienen su propia suite: si alguien cambia el
 * texto o el estado sin darse cuenta de que está cambiando una promesa al cliente, esto falla.
 *
 * No toca la base de datos: el handoff se compone con lo que se le pasa.
 */
'use strict';

const handoff = require('../../intelligence/engine/handoff');

const SIN_HORARIO = { id: 1, nombre: 'Barbería Don Nico', tratamiento: 'Barbería Don Nico', atencion: null };
const CON_HORARIO = { ...SIN_HORARIO, atencion: { desde: '09:00', hasta: '18:00' } };

describe('handoff: qué se le dice al cliente', () => {
    it('dice que NO hay nadie, en vez de prometer que contestan en un momento', () => {
        // El fallo original: «te confirmo en un momento» a las 11 de la noche, y silencio.
        const texto = handoff.mensaje(SIN_HORARIO);
        expect(texto).toMatch(/no tengo a nadie/i);
        expect(texto).not.toMatch(/en un momento/i);
    });

    it('sin horario configurado, promete el día y no una hora', () => {
        expect(handoff.mensaje(SIN_HORARIO)).toContain(handoff.CUANDO_SIN_HORARIO);
    });

    it('con horario configurado, dice la hora del negocio', () => {
        expect(handoff.mensaje(CON_HORARIO)).toContain('a partir de las 09:00');
    });

    it('un horario a medias NO se convierte en una hora inventada', () => {
        // Configuración incompleta de un inquilino no puede salir como «a partir de las undefined»
        // ni como una hora que nadie prometió. Cae a la franja honesta.
        for (const roto of [{}, { desde: null }, { desde: '' }, { desde: 'mañana' }, { desde: '25:00' }]) {
            const texto = handoff.mensaje({ ...SIN_HORARIO, atencion: roto });
            expect(texto).toContain(handoff.CUANDO_SIN_HORARIO);
            expect(texto).not.toMatch(/a partir de las/);
        }
    });

    it('sin contexto de negocio tampoco revienta', () => {
        // Un negocio inactivo o ilegible devuelve el genérico. Escalar tiene que seguir siendo
        // posible: quedarse sin frase sería dejar mudo justo el camino de emergencia.
        for (const nada of [null, undefined, {}]) {
            expect(handoff.mensaje(nada)).toContain(handoff.CUANDO_SIN_HORARIO);
        }
    });
});

describe('handoff: el bot se calla de verdad', () => {
    it('pone la conversación en handoff_humano, que es el estado que apaga al bot', () => {
        // Antes esto era SOLO una frase: la conversación seguía «activa» y el bot contestaba el
        // turno siguiente, después de haber prometido que intervenía una persona.
        const d = handoff.decision({ pasos: [], invocaciones: [], variables: {} }, SIN_HORARIO);
        expect(d.estado).toBe('handoff_humano');
    });

    it('el turno se cuenta como handoff y no como resuelto', () => {
        // La pregunta 11 del Ledger es la tasa de resolución. Un escalado no es una resolución, y
        // contarlo como tal esconde justo el número que hay que vigilar.
        const d = handoff.decision({ pasos: [], invocaciones: [], variables: {} }, SIN_HORARIO);
        expect(d.resultado).toBe('handoff');
    });

    it('conserva lo que el manejador ya había acumulado', () => {
        // Los pasos y las invocaciones son el rastro del turno en el Ledger. Escalar no puede
        // borrarlo: es justo el turno que alguien va a querer mirar.
        const base = {
            pasos: [{ tipo: 'regla', decision: 'prompt_armado' }],
            invocaciones: [{ capacidad: 'consultar_servicios', resultado: 'ok' }],
            variables: { nombre: 'Ana' },
            nivel: 'llm',
        };
        const d = handoff.decision(base, SIN_HORARIO);
        expect(d.pasos).toEqual(base.pasos);
        expect(d.invocaciones).toEqual(base.invocaciones);
        expect(d.variables).toEqual(base.variables);
        expect(d.nivel).toBe('llm');
    });
});
