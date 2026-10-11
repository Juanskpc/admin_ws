/**
 * Lo que salió de la auditoría del 2026-10-10 sobre Zona Burger: los mensajes que el asistente
 * mandaba de más, medidos en la ventana 2026-10-05 → 2026-10-10 (1.166 salientes facturables).
 *
 * Cada caso es un patrón REAL de esa ventana, con su cuenta:
 *
 *   · 47 «¡Con gusto! 😊» detrás de un «Gracias» con la conversación ya cerrada  → §1
 *   · 12 de 33 avisos de «cerrado» repetidos a menos de 5 minutos del anterior   → §2
 *   ·  9 turnos partidos en dos mensajes, 8 de ellos el mismo par               → §3
 *   ·  5 de 22 stickers que despertaron al asistente por un «?» anterior         → §4
 *
 * Ninguno toca la base.
 */
'use strict';
require('dotenv').config();

const cortesia = require('../../intelligence/engine/cortesia');
const { unirRespuestas, TOPE_CUERPO } = require('../../intelligence/engine/unirRespuestas');
const flujo = require('../../intelligence/adapters/restaurante/flujo');

describe('§1 la cortesía de cierre ya no gasta un mensaje', () => {
    const conv = (variables = { turnos: 4 }) => ({ conversacion: { variables: { ...variables } } });
    const dijo = (texto) => async () => texto;
    const CIERRE = '¡Listo! Tu pedido quedó tomado. El número es ORD-8062.';

    test.each([
        'Gracias',
        'Muchas gracias',
        'Ok gracias',
        'Vale gracias',
        'Listo muchas gracias',
        'Bueno muchas gracias',
        'gracias veci',
    ])('«%s» tras un cierre → silencio', async (texto) => {
        const d = await cortesia.decidir({ ...conv(), texto }, { hayTarea: false, ultimoDelAsistente: dijo(CIERRE) });
        expect(d.respuestas).toEqual([]);
        expect(d.resultado).toBe('sin_respuesta');
        expect(d.pasos[0].decision).toBe('cortesia_sin_respuesta');
    });

    test('lo que PIDE algo sigue atendiéndose, y olvida la marca', async () => {
        const ctx = { ...conv({ turnos: 6, [cortesia.MARCA]: true }), texto: 'Y de tomar que hay?' };
        expect(await cortesia.decidir(ctx, { hayTarea: false, ultimoDelAsistente: dijo(CIERRE) })).toBeNull();
        expect(ctx.conversacion.variables[cortesia.MARCA]).toBeUndefined();
    });

    test('un «ok» que contesta una pregunta no se calla', async () => {
        const d = await cortesia.decidir(
            { ...conv(), texto: 'ok' },
            { hayTarea: false, ultimoDelAsistente: dijo('¿Te la dejo para recoger?') }
        );
        expect(d).toBeNull();
    });
});

describe('§2 el aviso de local cerrado no se repite a los segundos', () => {
    const T0 = Date.parse('2026-10-08T17:12:10-05:00');
    const ctxDe = (variables, desplazamientoMs) => ({
        idNegocio: 6,
        conversacion: { id_negocio: 6, variables },
        ahora: () => new Date(T0 + desplazamientoMs),
    });
    // Zona Burger abre a las 16:30: el estado real de ese día era «en horario, pero sin caja».
    const abre = async () => null;

    test('el primero tras la bienvenida sí sale, corto', async () => {
        const d = await flujo.avisoFueraDeServicio(
            ctxDe({ turnos: 2, aviso_cerrado_en: new Date(T0 - 20 * 1000).toISOString() }, 0),
            'aun_no_abre',
            { proximaApertura: abre }
        );
        expect(d.respuestas).toHaveLength(1);
        expect(d.resultado).toBe('resuelto');
        expect(d.variables.aviso_cerrado_corto_en).toBeTruthy();
    });

    test('el segundo a los 23 segundos: silencio', async () => {
        const d = await flujo.avisoFueraDeServicio(
            ctxDe(
                {
                    turnos: 3,
                    aviso_cerrado_en: new Date(T0 - 20 * 1000).toISOString(),
                    aviso_cerrado_corto_en: new Date(T0).toISOString(),
                },
                23 * 1000
            ),
            'aun_no_abre',
            { proximaApertura: abre }
        );
        expect(d.respuestas).toEqual([]);
        expect(d.resultado).toBe('sin_respuesta');
        expect(d.pasos[0].motivo.repetido).toBe(true);
    });

    test('pasados 6 minutos vuelve a salir: ya puede ser otra intención', async () => {
        const d = await flujo.avisoFueraDeServicio(
            ctxDe(
                {
                    turnos: 4,
                    aviso_cerrado_en: new Date(T0).toISOString(),
                    aviso_cerrado_corto_en: new Date(T0).toISOString(),
                },
                6 * 60 * 1000
            ),
            'aun_no_abre',
            { proximaApertura: abre }
        );
        expect(d.respuestas).toHaveLength(1);
        expect(d.resultado).toBe('resuelto');
    });

    test('el aviso largo no se pierde: a la media hora la carta vuelve', async () => {
        const d = await flujo.avisoFueraDeServicio(
            ctxDe(
                {
                    turnos: 9,
                    aviso_cerrado_en: new Date(T0 - 31 * 60 * 1000).toISOString(),
                    aviso_cerrado_corto_en: new Date(T0 - 31 * 60 * 1000).toISOString(),
                },
                0
            ),
            'fuera_de_horario',
            { proximaApertura: abre }
        );
        expect(d.respuestas).toHaveLength(1);
        // El largo renueva el sello de los 30 min; el corto solo renueva el suyo.
        expect(Date.parse(d.variables.aviso_cerrado_en)).toBe(T0);
    });
});

describe('§3 un turno sale en los menos mensajes que quepan', () => {
    // El par real: 8 de los 9 turnos partidos de la ventana eran la respuesta del modelo y, suelto
    // detrás, el recordatorio con botones que pega `manejadorEscalera.conSiPendiente`.
    const NAG = {
        texto: 'Todavía no he enviado tu pedido. ¿Lo confirmo? Respóndeme sí o no.',
        opciones: [
            { id: 'si', etiqueta: 'Sí, confirmo' },
            { id: 'no', etiqueta: 'No' },
        ],
    };

    test('la respuesta y el recordatorio salen en UN mensaje, con los botones al final', () => {
        const d = unirRespuestas({
            respuestas: ['El domicilio cuesta entre $6.000 y $9.000, según dónde estés.', NAG],
        });
        expect(d.respuestas).toHaveLength(1);
        expect(d.respuestas[0].texto).toBe(
            'El domicilio cuesta entre $6.000 y $9.000, según dónde estés.\n\n' +
                'Todavía no he enviado tu pedido. ¿Lo confirmo? Respóndeme sí o no.'
        );
        expect(d.respuestas[0].opciones).toEqual(NAG.opciones);
    });

    test('una respuesta con opciones no absorbe a la siguiente: el menú va al final', () => {
        const conMenu = { texto: 'Elige el tamaño', opciones: [{ id: 'p', etiqueta: 'Pequeña' }] };
        const d = unirRespuestas({ respuestas: [conMenu, 'Y el domicilio va aparte.'] });
        expect(d.respuestas).toHaveLength(2);
    });

    test('si no cabe en el cuerpo interactivo se mandan los dos, como antes', () => {
        const largo = 'x'.repeat(TOPE_CUERPO);
        const d = unirRespuestas({ respuestas: [largo, NAG] });
        expect(d.respuestas).toHaveLength(2);
    });

    test('es idempotente y no toca lo que ya viene suelto', () => {
        const una = { respuestas: ['solo esto'] };
        expect(unirRespuestas(una).respuestas).toEqual(['solo esto']);
        const d = unirRespuestas({ respuestas: ['a', 'b'] });
        expect(unirRespuestas(d).respuestas).toEqual(d.respuestas);
    });
});

describe('§4 un sticker no contesta una pregunta', () => {
    const conv = (variables = { turnos: 4 }) => ({ conversacion: { variables: { ...variables } } });
    const dijo = (texto) => async () => texto;

    test.each(['[sticker]', '[reaction]'])('%s tras una pregunta → silencio, no modelo', async (texto) => {
        const d = await cortesia.decidir(
            { ...conv(), texto },
            { hayTarea: false, ultimoDelAsistente: dijo('¿Te muestro algo del menú?') }
        );
        expect(d.respuestas).toEqual([]);
        expect(d.resultado).toBe('sin_respuesta');
    });

    test('con una tarea a medias el flujo lo sigue leyendo: el 👍 que confirma no se pierde', async () => {
        const d = await cortesia.decidir(
            { ...conv(), texto: '[sticker]' },
            { hayTarea: true, ultimoDelAsistente: dijo('¿Lo confirmo?') }
        );
        expect(d).toBeNull();
    });

    test('en el primer mensaje de la conversación sigue mereciendo bienvenida', async () => {
        const d = await cortesia.decidir(
            { ...conv({ turnos: 0 }), texto: '[sticker]' },
            { hayTarea: false, ultimoDelAsistente: dijo('') }
        );
        expect(d).toBeNull();
    });

    test('`soloMedio` distingue el sticker de la palabra', () => {
        expect(cortesia.leer('[sticker]').soloMedio).toBe(true);
        expect(cortesia.leer('gracias').soloMedio).toBe(false);
        expect(cortesia.leer('[image]').cortesia).toBe(false);
    });
});
