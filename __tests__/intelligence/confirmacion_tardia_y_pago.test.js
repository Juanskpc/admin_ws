/**
 * Tres casos de la noche del 2026-10-16 en Zona Burger:
 *  - un «si» a los 12 minutos del resumen (la clienta pagaba por Nequi) → «no hice nada» y el
 *    pedido se perdió. Ahora se le repasa el resumen y se espera su sí otra vez;
 *  - «Pago por Nequi» con el resumen delante se repreguntaba y no llegaba a la nota;
 *  - el formulario llegó ANTES que el pedido y su «Pago: Nequi» no llegó al pedido (ORD-8372).
 *
 * Correr con:  npx jest __tests__/intelligence/confirmacion_tardia_y_pago.test.js
 */
const confirmacion = require('../../intelligence/engine/confirmacion');
const registryReal = require('../../intelligence/core/registry');
const adaptadorRestaurante = require('../../intelligence/adapters/restaurante');

beforeAll(() => adaptadorRestaurante.registrarCapacidades());
afterAll(() => registryReal._limpiar());

const MIN = 60 * 1000;

function montar({ anotar = true } = {}) {
    const registry = {
        obtener: () => ({
            confirmacion: {
                pregunta: ({ args: a }) => `¿Confirmo tu pedido a nombre de ${a.cliente_nombre}?${a.nota ? ` Nota: ${a.nota}` : ''}`,
                ...(anotar ? { anotar: ({ args: a, texto }) => ({ ...a, nota: a.nota ? `${a.nota}. ${texto}` : texto }) } : {}),
                hecho: () => 'Listo',
            },
        }),
    };
    const gate = { ejecutar: jest.fn().mockResolvedValue({ resultado: { numero_orden: 'ORD-1' } }) };
    const resolver = (texto, haceMin = 1, extra = {}) =>
        confirmacion.resolver(
            {
                conversacion: {
                    id_negocio: 6,
                    variables: {},
                    tarea_actual: confirmacion.TAREA,
                    tarea_datos: {
                        capacidad: 'tomar_pedido',
                        args: { cliente_nombre: 'Jessica', tipo_entrega: 'LLEVAR', items: [] },
                        preguntado_en: new Date(Date.now() - haceMin * MIN).toISOString(),
                        repreguntas: 0,
                        ...extra,
                    },
                },
                texto,
                turno: { id_turno: 1 },
                idNegocio: 6,
                invocaciones: [],
            },
            { gate, registry }
        );
    return { gate, resolver };
}

describe('un «sí» tardío a un pedido', () => {
    test('EL CASO: «si» a los 12 minutos repasa el resumen, no ejecuta y espera otra vez', async () => {
        const { gate, resolver } = montar();
        const d = await resolver('si', 12, { repreguntas: 1 });
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(d.pasos[0].decision).toBe('confirmacion_repasada');
        expect(d.respuestas[0].texto).toMatch(/te lo repaso/);
        expect(d.respuestas[0].texto).toMatch(/Confirmo tu pedido a nombre de Jessica/);
        expect(d.respuestas[0].opciones.map((o) => o.id)).toEqual(['si', 'no']);
        expect(d.tarea.datos.repreguntas).toBe(0);
        expect(Date.now() - Date.parse(d.tarea.datos.preguntado_en)).toBeLessThan(5000);
    });

    test('y el sí siguiente, ya fresco, sí lo toma', async () => {
        const { gate, resolver } = montar();
        const d = await resolver('si', 0);
        expect(gate.ejecutar).toHaveBeenCalledTimes(1);
        expect(d.pasos[0].decision).toBe('confirmacion_ejecutada');
    });

    test('pasada una hora, se suelta como siempre', async () => {
        const { gate, resolver } = montar();
        const d = await resolver('si', 61);
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(d.pasos[0].decision).toBe('confirmacion_caducada');
        expect(d.tarea).toBeNull();
    });

    test('otra cosa que no es un sí, tarde, tampoco revive el pedido', async () => {
        const { resolver } = montar();
        const d = await resolver('cuánto vale el domicilio', 12);
        expect(d.pasos[0].decision).toBe('confirmacion_caducada');
    });

    test('lo que no es un pedido (una cita) caduca igual que antes', async () => {
        const { gate, resolver } = montar({ anotar: false });
        const d = await resolver('sí', 12);
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(d.pasos[0].decision).toBe('confirmacion_caducada');
        expect(d.respuestas[0]).toMatch(/no hice nada/i);
    });
});

describe('decir cómo paga con el resumen delante', () => {
    test.each(['Pago por Nequi', 'pago en efectivo', 'Pagaré con transferencia', 'Le pago con nequi al domi'])(
        '%p va a la nota',
        async (texto) => {
            const { gate, resolver } = montar();
            const d = await resolver(texto);
            expect(gate.ejecutar).not.toHaveBeenCalled();
            expect(d.pasos[0].decision).toBe('confirmacion_anotada');
            expect(d.respuestas[0].texto).toContain(texto);
        }
    );

    test.each(['¿Cuánto pago con domicilio?', 'cuanto pago en total', 'Me confirma el valor del domicilio'])(
        '%p sigue siendo una pregunta, no una nota',
        async (texto) => {
            const { resolver } = montar();
            const d = await resolver(texto);
            expect(d.pasos[0].decision).not.toBe('confirmacion_anotada');
        }
    );

    test('con el sí al final de la ráfaga se anota y se toma', async () => {
        const { gate, resolver } = montar();
        await resolver('Pago por Nequi\nsi');
        expect(gate.ejecutar).toHaveBeenCalledTimes(1);
        expect(gate.ejecutar.mock.calls[0][0].args.nota).toBe('Pago por Nequi');
    });
});

describe('el pago del formulario que llegó antes que el pedido', () => {
    const ajustar = (args, hilo) => registryReal.obtener('tomar_pedido').confirmacion.ajustar({ args, hilo });
    const SALUDO = { rol: 'asistente', texto: '👋 ¡Buenas noches! Te saluda *ZONA BURGER*.' };
    const FORM = {
        rol: 'cliente',
        texto: '📋 Formulario enviado\nEntrega: domicilio\nBarrio: Avenida Santander\nDireccion: Calle 22 # 23-52\nPago: Nequi',
    };

    test('EL CASO ORD-8372: el modelo no copió el pago → se pone en la nota', () => {
        const hilo = [SALUDO, FORM, { rol: 'asistente', texto: '¿Qué te gustaría pedir?' }, { rol: 'cliente', texto: 'Una salchilimon' }];
        expect(ajustar({ items: [], tipo_entrega: 'DOMICILIO' }, hilo).nota).toBe('Pago: Nequi');
        expect(ajustar({ items: [], nota: 'Sin cebolla' }, hilo).nota).toBe('Sin cebolla. Pago: Nequi');
    });

    test('si la nota ya dice el pago, no se repite', () => {
        const hilo = [SALUDO, FORM];
        expect(ajustar({ nota: 'Pago: Nequi' }, hilo).nota).toBe('Pago: Nequi');
    });

    test('el formulario de un pedido ANTERIOR no cuenta', () => {
        const hilo = [FORM, { rol: 'asistente', texto: '¡Listo! Tu pedido quedó tomado. El número es ORD-1' }, { rol: 'cliente', texto: 'otra salchilimon' }];
        expect(ajustar({ items: [] }, hilo).nota).toBeUndefined();
    });

    test('un formulario sin pago no añade nada', () => {
        const hilo = [SALUDO, { rol: 'cliente', texto: '📋 Formulario enviado\nEntrega: recoger' }];
        const args = { items: [] };
        expect(ajustar(args, hilo)).toBe(args);
    });
});
