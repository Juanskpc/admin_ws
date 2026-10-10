/**
 * La cuota mensual de WhatsApp — lo que se puede probar sin Postgres.
 *
 * Desde el 1 de octubre de 2026 Meta cobra los *service messages* pasada la asignación mensual de
 * cada número. Lo que esta suite congela es la parte que decide **cuándo se avisa**, que es donde
 * un fallo se nota tarde y mal: un aviso de más enseña a ignorar la campanita, y uno de menos
 * convierte la factura en la primera noticia.
 *
 * El conteo en sí (`consumoDelMes`, `mensajesPorCita`) es SQL sobre tablas particionadas y se
 * prueba contra una base de verdad, como el resto del Ledger.
 *
 *   npx jest __tests__/intelligence/cuota_whatsapp.test.js
 */
'use strict';

const cuota = require('../../intelligence/channels/whatsapp/cuota');
const aviso = require('../../intelligence/avisos/cuotaWhatsapp');

/** Un consumo como el que devuelve `consumoDelMes`, a partir del porcentaje. */
function consumo(porcentaje) {
    const servicio = Math.round(porcentaje * cuota.ASIGNACION_MENSUAL);
    return {
        id_negocio: 10,
        negocio: "D'Alex",
        servicio,
        plantilla: 0,
        asignacion: cuota.ASIGNACION_MENSUAL,
        restantes: Math.max(0, cuota.ASIGNACION_MENSUAL - servicio),
        porcentaje,
    };
}

describe('cuándo se avisa de la cuota', () => {
    test('por debajo del umbral no se avisa: no hay nada que hacer todavía', () => {
        expect(aviso.nivelDeAviso(consumo(0), 0)).toBeNull();
        expect(aviso.nivelDeAviso(consumo(0.5), 0)).toBeNull();
        expect(aviso.nivelDeAviso(consumo(0.79), 0)).toBeNull();
    });

    test('al llegar al umbral se avisa una vez, y solo una', () => {
        expect(aviso.nivelDeAviso(consumo(0.8), 0)).toBe('umbral');
        // Un aviso diario diciendo lo mismo enseña a no abrir la campanita.
        expect(aviso.nivelDeAviso(consumo(0.85), 1)).toBeNull();
        expect(aviso.nivelDeAviso(consumo(0.99), 1)).toBeNull();
    });

    test('agotarla avisa otra vez, aunque ya se hubiera avisado del umbral', () => {
        // Son dos cosas distintas: «te quedan doscientos» y «de aquí en adelante se cobra».
        expect(aviso.nivelDeAviso(consumo(1), 1)).toBe('agotada');
        expect(aviso.nivelDeAviso(consumo(1.4), 1)).toBe('agotada');
        // Pero no una tercera.
        expect(aviso.nivelDeAviso(consumo(1.4), 2)).toBeNull();
    });

    test('un mes sin avisos previos y ya pasada: sale el de agotada', () => {
        expect(aviso.nivelDeAviso(consumo(1.2), 0)).toBe('agotada');
    });
});

describe('qué dice el aviso', () => {
    test('el del umbral dice cuánto queda y cuánto cuesta una cita', () => {
        const { titulo, mensaje } = aviso.comoSeDice('umbral', consumo(0.8), {
            promedio: 7, citasGratisAlMes: 142,
        });

        // Reescrito el 2026-10-10: el techo dejó de ser el de Meta y pasó a ser el CONTRATADO,
        // y agotarlo ahora tiene consecuencia —el asistente deja de conversar—. El aviso tiene
        // que decir las tres cosas que permiten actuar, no solo el porcentaje.
        expect(titulo).toMatch(/Te quedan 200 mensajes/);
        // 1. Dónde está el gasto, y cuánto queda en la unidad que el dueño entiende.
        expect(mensaje).toMatch(/7 mensajes de media/);
        expect(mensaje).toMatch(/28 más este mes/); // 200 restantes / 7 por conversación
        // 2. Qué va a pasar. Es lo que faltaba y lo que convierte el dato en una advertencia.
        expect(mensaje).toMatch(/deja de conversar/);
        // 3. Qué hacer.
        expect(mensaje).toMatch(/paquete/);
    });

    test('el de agotada dice QUÉ pasa, qué hacer y cuándo se renueva', () => {
        const { titulo, mensaje } = aviso.comoSeDice('agotada', consumo(1), { promedio: 0 });

        expect(titulo).toMatch(/agotaron/);
        // Lo importante no es que «se cobre»: es que el asistente dejó de atender solo y que
        // las conversaciones ahora las contesta una persona. Sin eso, el negocio se entera
        // cuando un cliente le reclama.
        expect(mensaje).toMatch(/deja de conversar/);
        expect(mensaje).toMatch(/Conversaciones/);
        expect(mensaje).toMatch(/paquete/);
        expect(mensaje).toMatch(/día 1/);
    });

    test('sin medición del gasto por cita no se inventa una cifra', () => {
        const { mensaje } = aviso.comoSeDice('umbral', consumo(0.8), { promedio: 0, citasGratisAlMes: null });
        expect(mensaje).not.toMatch(/media/);
        expect(mensaje).not.toMatch(/null/);
    });
});

describe('el mes se cuenta en hora de Bogotá', () => {
    test('el primero del mes a medianoche ya es el mes nuevo', () => {
        // Un `toISOString()` aquí correría la fecha cinco horas y el día 1 contaría todavía el mes
        // anterior: es la trampa que este repositorio ya pagó dos veces con las citas.
        expect(cuota.primerDiaDelMes(new Date('2026-10-01T05:00:00Z'))).toBe('2026-10-01 00:00:00-05');
    });

    test('el último día del mes anterior sigue en su mes', () => {
        // 30 de septiembre, 20:00 en Bogotá = 1 de octubre, 01:00 UTC.
        expect(cuota.primerDiaDelMes(new Date('2026-10-01T01:00:00Z'))).toBe('2026-09-01 00:00:00-05');
    });
});
