/**
 * Auditoría del 2026-10-03 (Zona Burger): lo que se corrigió y por qué.
 *
 * Correr con:  npx jest __tests__/intelligence/auditoria_2026_10_03.test.js
 */
const flujo = require('../../intelligence/adapters/restaurante/flujo');
const { mismaPalabra } = require('../../intelligence/adapters/restaurante/index');
const { nombreLegible } = require('../../intelligence/engine/identidad');
const confirmacion = require('../../intelligence/engine/confirmacion');

describe('preguntas de tiempo con otras formas', () => {
    test.each([
        'Cuánto te demoras?',
        'cuanto tienpo se demora',
        'Cuánto tiempo se demora ?',
        'Cuanto se demora mas o menos',
        'que tanto te demoras',
    ])('%p es una pregunta de tiempo', (t) => expect(flujo.esPreguntaDeTiempo(t)).toBe(true));

    test('un pedido que menciona la demora no lo es', () => {
        expect(flujo.esPreguntaDeTiempo('si se demora mucho cancelo pero quiero dos salchipapas criollas pequeñas por favor')).toBe(false);
    });
});

describe('«con el domicilio» después del total', () => {
    test.each(['Con el domicilio', 'Cuánto es con domicilio', 'y cuanto seria con el domicilio', 'con domicilio incluido'])(
        '%p se contesta con el rango',
        (t) => expect(flujo.esPreguntaDeDomicilio(t)).toBe(true)
    );
    test.each(['quiero una salchipapa con domicilio a la calle 5 por favor', 'a domicilio', 'domicilio'])(
        '%p NO es esa pregunta',
        (t) => expect(flujo.esPreguntaDeDomicilio(t)).toBe(false)
    );
});

describe('foto, audio o ubicación sueltos', () => {
    test.each(['[image]', '[audio]', '[location]', '[document]'])('%s se reconoce', (t) => {
        expect(flujo.mediaSuelta(t)).toBeTruthy();
        expect(flujo.reclama(t)).toBe(true);
    });
    test.each(['[sticker]', 'hola', 'te mando la [image] luego', '[unsupported]'])('%s no', (t) => {
        expect(flujo.mediaSuelta(t)).toBeNull();
    });
});

describe('el buscador perdona erratas', () => {
    test.each([
        ['visiosa', 'viciosa'],
        ['limos', 'limon'],
        ['dulsinea', 'dulcinea'],
        ['papas', 'papa'],
    ])('%s ~ %s', (a, b) => expect(mismaPalabra(a, b)).toBe(true));
    test.each([
        ['mora', 'moda'],
        ['coca', 'cola'],
        ['limon', 'limpio'],
        ['salchipapa', 'hamburguesa'],
    ])('%s !~ %s', (a, b) => expect(mismaPalabra(a, b)).toBe(false));
});

describe('el nombre del perfil se limpia', () => {
    test.each([
        ['. 𐙚 Natha 𝜗𝜚', 'Natha'],
        ['Ángela  Yela ', 'Ángela Yela'],
        ['Mamá ❤️', 'Mamá'],
        ["María-José O'Neil", "María-José O'Neil"],
    ])('%p → %p', (entrada, salida) => expect(nombreLegible(entrada)).toBe(salida));
    test.each(['🔥', 'J', '12345', null])('%p no sirve', (v) => expect(nombreLegible(v)).toBeNull());
});

describe('confirmación pendiente', () => {
    const registry = {
        obtener: () => ({
            confirmacion: {
                pregunta: ({ args }) => `¿Confirmo a nombre de ${args.cliente_nombre}?`,
                anotar: ({ args, texto }) => ({ ...args, nota: texto }),
                hecho: () => 'Listo',
            },
        }),
    };
    const conv = (extra = {}) => ({
        id_negocio: 6,
        variables: {},
        tarea_actual: confirmacion.TAREA,
        tarea_datos: {
            capacidad: 'tomar_pedido',
            args: { cliente_nombre: 'Ana', tipo_entrega: 'MESA' },
            preguntado_en: new Date().toISOString(),
            repreguntas: 0,
            ...extra,
        },
    });
    const gate = { ejecutar: jest.fn().mockResolvedValue({ resultado: {} }) };
    beforeEach(() => gate.ejecutar.mockClear());
    const ctx = (texto, extra) => ({ conversacion: conv(extra), texto, turno: { id_turno: 1 }, idNegocio: 6, invocaciones: [] });

    test('«es para servirse, cuanto tienpo se demora» es una pregunta, NO una nota', async () => {
        const d = await confirmacion.resolver(ctx('Es para servirse ay en restaurante cuanto tienpo se demora'), { gate, registry });
        expect(d.pasos[0].decision).not.toBe('confirmacion_anotada');
        expect(gate.ejecutar).not.toHaveBeenCalled();
    });

    test('un sí que llegó con una persona atendiendo ejecuta y devuelve la conversación a la persona', async () => {
        const d = await confirmacion.resolver(ctx('si', { volver_a_humano: true }), { gate, registry });
        expect(gate.ejecutar).toHaveBeenCalledTimes(1);
        expect(d.estado).toBe('handoff_humano');
    });

    test('un sí normal no toca el estado', async () => {
        const d = await confirmacion.resolver(ctx('si'), { gate, registry });
        expect(d.estado).toBeUndefined();
    });
});
