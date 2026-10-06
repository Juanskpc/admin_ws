/**
 * Auditoría de Zona Burger del 2026-10-05, la hora fuerte (17:26 – 19:10).
 *
 *  1. Con un pedido esperando el sí, el asistente preguntó «¿Cuáles dos sabores prefieres?» y a
 *     la vez «¿Lo confirmo? sí o no». El cliente contestó «si» y el pedido salió sin hervidos.
 *  2. «Ahora mismo no tengo a nadie del negocio disponible… en el transcurso del día», dos veces,
 *     con el local abierto y contestando 30 segundos después.
 *  3. «Esa viene con queso mor» y, 6 s después, «A domicilio»: el bot ya había contestado lo
 *     primero. WhatsApp no avisa de que alguien escribe; el texto libre espera un poco más.
 *
 * Correr con:  npx jest __tests__/intelligence/auditoria_2026_10_05_noche.test.js
 */
'use strict';

const pago = require('../../intelligence/adapters/restaurante/pago');
const confirmacion = require('../../intelligence/engine/confirmacion');
const registry = require('../../intelligence/core/registry');
const texto = require('../../intelligence/engine/texto');
const { ColaParticionada } = require('../../intelligence/engine/cola');
const { crearFlujoRestaurante } = require('../../intelligence/adapters/restaurante/flujo');
const { crearManejadorEscalera } = require('../../intelligence/engine/manejadorEscalera');

const ARGS = { items: [{ cantidad: 2, id_producto: 27 }], tipo_entrega: 'LLEVAR', cliente_nombre: 'cliente' };
const conPendiente = (extra = {}) => ({
    id_conversacion: 'c1', id_negocio: 6, canal: 'whatsapp', id_externo: '573000000000',
    variables: { turnos: 3 }, humano_ultimo_en: null,
    tarea_actual: confirmacion.TAREA,
    tarea_datos: { capacidad: 'tomar_pedido', args: ARGS, preguntado_en: '2026-10-05T23:48:32.000Z', repreguntas: 0, ...extra },
});
const entrada = (conv, dicho) => ({
    conversacion: conv, mensajes: [{ contenido: dicho }], turno: { id_turno: 't' }, texto: dicho, consumo: { costos: [] },
});

describe('la escalera: una pregunta del modelo no se junta con «¿lo confirmo?»', () => {
    const escalera = (respuesta) =>
        crearManejadorEscalera({
            determinista: async () => ({ pasos: [], respuestas: [], variables: {}, resultado: 'sin_respuesta', nivel: 'determinista' }),
            llm: async () => ({ pasos: [], respuestas: [respuesta], resultado: 'resuelto', nivel: 'llm' }),
        });

    test('EL CASO: «¿Cuáles dos sabores prefieres?» sale sola y marca el pendiente', async () => {
        const d = await escalera('Tenemos lulo, maracuyá y mora. ¿Cuáles dos sabores prefieres?')(
            entrada(conPendiente(), 'Y dos hervidos de que sabores tiene?')
        );
        expect(d.respuestas).toHaveLength(1);
        expect(d.tarea.nombre).toBe(confirmacion.TAREA);
        expect(d.tarea.datos.pregunta_abierta).toBe(true);
        // El pendiente sigue siendo el mismo: ni su hora ni sus argumentos cambian.
        expect(d.tarea.datos.args).toEqual(ARGS);
        expect(d.tarea.datos.preguntado_en).toBe('2026-10-05T23:48:32.000Z');
    });

    test('también con un emoji detrás de la interrogación', async () => {
        const d = await escalera('¿De qué sabor lo quieres? 😊')(entrada(conPendiente(), 'y un jugo'));
        expect(d.respuestas).toHaveLength(1);
        expect(d.tarea.datos.pregunta_abierta).toBe(true);
    });

    test('una respuesta que NO pregunta sigue recordando el sí, y limpia la marca', async () => {
        const d = await escalera('El domicilio vale entre $7.000 y $9.000.')(
            entrada(conPendiente({ pregunta_abierta: true }), 'cuanto vale el domi')
        );
        expect(d.respuestas).toHaveLength(2);
        expect(d.respuestas[1].texto).toContain('¿Lo confirmo?');
        expect(d.tarea.datos.pregunta_abierta).toBe(false);
    });
});

describe('el flujo: con la pregunta del modelo abierta, un «sí» no ejecuta', () => {
    const gate = { ejecutar: jest.fn() };
    const crear = () =>
        crearFlujoRestaurante({
            tienePedidoReciente: async () => false,
            yaSeLeContestoSuPedido: async () => false,
            contextoNegocio: {
                obtener: async () => ({
                    id: 6, nombre: 'ZONA BURGER', tratamiento: 'ZONA BURGER', atencion: null,
                    tipoNegocio: 'RESTAURANTE', tiempoEstimado: { min: 40, max: 60 },
                }),
            },
            identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
            gate,
            ahora: () => new Date('2026-10-05T18:49:00-05:00'),
            estadoAtencion: async () => ({ estado: 'ABIERTO' }),
            proximaApertura: async () => null,
            leerCarta: async () => ({ enlace: 'https://escalapp.cloud/restaurante/carta/6', productos: [] }),
            catalogo: {
                barrios: async () => ({ habilitado: false, barrios: [] }),
                mesas: async () => [],
                resolverBarrio: async () => null,
                resolverMesa: async () => null,
                resolverExclusiones: async () => ({ validas: [], descartadas: [] }),
            },
        });

    beforeEach(() => {
        gate.ejecutar.mockReset();
        jest.spyOn(pago, 'ultimoPedidoVivo').mockResolvedValue(null);
        jest.spyOn(pago, 'textosDePago').mockResolvedValue({ domicilio: 'DOM', local: 'LOCAL' });
        jest.spyOn(registry, 'obtener').mockReturnValue({
            confirmacion: { pregunta: async () => '¿Confirmo tu pedido: 2 × Pata-crunch?', hecho: () => 'Hecho', anotar: (x) => x.args },
        });
    });
    afterEach(() => jest.restoreAllMocks());

    test('EL CASO: «si» tras «¿Cuáles dos sabores prefieres?» vuelve a enseñar el resumen', async () => {
        const d = await crear()(entrada(conPendiente({ pregunta_abierta: true }), 'si'));
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(d.pasos[0].decision).toBe('confirmacion_si_ambiguo');
        expect(d.respuestas[0].texto).toContain('2 × Pata-crunch');
        expect(d.respuestas[0].texto).toContain('Respóndeme sí o no');
        expect(d.tarea.datos.pregunta_abierta).toBe(false);
    });

    test('lo que conteste a esa pregunta («lulo y mora») lo lee el modelo, no acaba de nota', async () => {
        const d = await crear()(entrada(conPendiente({ pregunta_abierta: true }), 'lulo y mora'));
        expect(d.respuestas).toEqual([]);
        expect(d.pasos[0].decision).toBe('confirmacion_respuesta_al_modelo');
        expect('tarea' in d).toBe(false);
    });
});

describe('¿puede seguir escribiendo?', () => {
    test.each([
        'Esa viene con queso mor',
        'Salchipapa la viciosa porfavor mediana',
        'Me puede regalar una criolla mediana',
        'A domicilio',
    ])('%p es texto libre: se espera un poco más', (t) => {
        expect(texto.puedeSeguirEscribiendo(t)).toBe(true);
    });

    test.each([
        'si',
        'Sí veci',
        'no',
        'Buenas noches',
        'pagar_pedido',
        '[image]',
        '3148446617',
        'Hola, quiero pedir:\n• 1 × Choripapa\n#P6-33x1~m=R',
    ])('%p ya está completo: se contesta enseguida', (t) => {
        expect(texto.puedeSeguirEscribiendo(t)).toBe(false);
    });
});

describe('la cola: dos esperas', () => {
    const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
    const montar = (config) => {
        const atendidas = [];
        const cola = new ColaParticionada({
            procesar: async (clave) => { atendidas.push(clave); },
            config: { debounceMs: 30, debounceMaxMs: 400, debounceTextoMs: 200, debounceTextoMaxMs: 600, ...config },
        });
        return { cola, atendidas };
    };

    test('el texto libre espera la larga; lo completo, la corta', async () => {
        const { cola, atendidas } = montar();
        cola.despertar('libre', {}, { puedeSeguir: true });
        cola.despertar('completo');
        await dormir(110);
        expect(atendidas).toEqual(['completo']);
        await dormir(200);
        expect(atendidas).toEqual(['completo', 'libre']);
        cola.detener?.();
    });

    test('EL CASO: la segunda parte llega dentro de la espera y es UN solo turno', async () => {
        const { cola, atendidas } = montar();
        cola.despertar('c', {}, { puedeSeguir: true }); // «Esa viene con queso mor»
        await dormir(120);
        cola.despertar('c', {}, { puedeSeguir: true }); // «A domicilio»
        await dormir(120);
        expect(atendidas).toEqual([]);
        await dormir(200);
        expect(atendidas).toEqual(['c']);
        cola.detener?.();
    });

    test('apagada (0, el valor por defecto) todo espera lo de siempre', async () => {
        const { cola, atendidas } = montar({ debounceTextoMs: 0 });
        cola.despertar('libre', {}, { puedeSeguir: true });
        await dormir(110);
        expect(atendidas).toEqual(['libre']);
        cola.detener?.();
    });
});
