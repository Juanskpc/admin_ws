/**
 * «No Veci» es un no (Zona Burger, 2026-10-12). A «Si Veci» se le enseñó el 10-01; al no, no, y
 * ante el resumen de un pedido se anotó «No Veci» como nota de cocina y se repreguntó.
 *
 * Correr con:  npx jest __tests__/intelligence/confirmacion_no_veci.test.js
 */
const { esNegacion } = require('../../intelligence/engine/texto');
const confirmacion = require('../../intelligence/engine/confirmacion');

describe('esNegacion', () => {
    test.each(['no', 'No', 'No Veci', 'no veci', 'Noo veci', 'No señor', 'no gracias', 'No, porfa'])(
        '%p es un no',
        (texto) => expect(esNegacion(texto)).toBe(true)
    );

    test.each(['No, sin cebolla', 'no le pongas salsa', 'Si veci', 'Noche', 'veci no', 'Nombre: Ana'])(
        '%p NO es un no limpio',
        (texto) => expect(esNegacion(texto)).toBe(false)
    );
});

describe('confirmación pendiente de un pedido', () => {
    const args = { cliente_nombre: 'Jazmin', tipo_entrega: 'DOMICILIO', items: [] };
    const registry = {
        obtener: () => ({
            confirmacion: {
                pregunta: ({ args: a }) => `¿Confirmo a nombre de ${a.cliente_nombre}?`,
                anotar: ({ args: a, texto }) => ({ ...a, nota: texto }),
                hecho: () => 'Listo',
            },
        }),
    };
    const conversacion = () => ({
        id_negocio: 6,
        variables: {},
        tarea_actual: confirmacion.TAREA,
        tarea_datos: {
            capacidad: 'tomar_pedido',
            args: { ...args },
            preguntado_en: new Date().toISOString(),
            repreguntas: 0,
        },
    });
    const gate = { ejecutar: jest.fn().mockResolvedValue({ resultado: {} }) };
    const resolver = (texto) =>
        confirmacion.resolver(
            { conversacion: conversacion(), texto, turno: { id_turno: 1 }, idNegocio: 6, invocaciones: [] },
            { gate, registry }
        );

    beforeEach(() => gate.ejecutar.mockClear());

    test('«No Veci» se rechaza: no ejecuta, no anota y no repregunta', async () => {
        const d = await resolver('No Veci');
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(JSON.stringify(d.pasos)).toContain('confirmacion_rechazada');
        expect(JSON.stringify(d.pasos)).not.toContain('confirmacion_anotada');
        expect(JSON.stringify(d.respuestas)).not.toMatch(/Anotado/);
    });

    test('«No, sin cebolla» sigue yendo a la nota', async () => {
        const d = await resolver('No, sin cebolla');
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(JSON.stringify(d.pasos)).toContain('confirmacion_anotada');
    });
});
