/**
 * Auditoría de Zona Burger del 2026-10-05, la primera tarde con `gpt-5.6-luna`.
 *
 * Dos conversaciones reales:
 *
 *  1. «Me regala una salchilimon grande» → «No encuentro *Salchilimon grande* en la carta», dos
 *     veces. La Salchi-limón existe en personal y mediana; lo que no existe es la grande.
 *  2. «Me puedes dar tres salchipapa viciosa» → el modelo pidió confirmar «para recoger» sin que
 *     nadie lo dijera. El cliente preguntó «Hacen domicilio», el bot le pidió la dirección y A LA
 *     VEZ «¿lo confirmo?»; tocó «Sí» y el domicilio quedó tomado para recoger.
 *
 * Correr con:  npx jest __tests__/intelligence/auditoria_2026_10_05.test.js
 */
'use strict';

const registry = require('../../intelligence/core/registry');
const adaptador = require('../../intelligence/adapters/restaurante');
const pago = require('../../intelligence/adapters/restaurante/pago');
const confirmacion = require('../../intelligence/engine/confirmacion');
const { crearFlujoRestaurante } = require('../../intelligence/adapters/restaurante/flujo');
const { crearManejadorEscalera } = require('../../intelligence/engine/manejadorEscalera');

const CARTA = [
    { id_producto: 29, nombre: 'Salchi-limón personal', descripcion: 'Tamaño personal. Papa bañada en limón.', precio: 17500, visible: true },
    { id_producto: 62, nombre: 'Salchi-limón mediana (pareja)', descripcion: 'Tamaño pareja. Papa bañada en limón.', precio: 29000, visible: true },
    { id_producto: 30, nombre: 'Criollita pequeña', descripcion: 'Papa, chorizo y maduro.', precio: 15500, visible: true },
];
/** Está en la carta, pero hoy no se vende. */
const AGOTADOS = [
    { id_producto: 84, nombre: 'Salchibarril personal', descripcion: 'Papa con pollo y cerdo.', precio: 23000, visible: true },
];
const sinTildes = (t) =>
    String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

let cartaService;
let originales;

beforeAll(() => {
    cartaService = require('../../app_restaurante_api/services/cartaService');
    originales = {
        buscar: cartaService.buscarProductos,
        completa: cartaService.getCartaPublicaCompleta,
    };
    cartaService.getCartaPublicaCompleta = async () => [{ nombre: 'SALCHIPAPAS', productos: CARTA }];
    // La semántica del servicio real: la frase entera contra el nombre o contra la descripción.
    cartaService.buscarProductos = async (idNegocio, termino, opciones = {}) => {
        const t = sinTildes(termino);
        return [...CARTA, ...(opciones.includeDisabled ? AGOTADOS : [])].filter((p) => sinTildes(p.nombre).includes(t) || sinTildes(p.descripcion).includes(t));
    };
    adaptador.registrarCapacidades();
});

afterAll(() => {
    cartaService.buscarProductos = originales.buscar;
    cartaService.getCartaPublicaCompleta = originales.completa;
    registry._limpiar();
});

describe('buscar_producto: el plato existe, el tamaño no', () => {
    const buscar = (termino) =>
        registry.obtener('buscar_producto').ejecutar({ idNegocio: 6, args: { termino } });
    const nombres = (r) => r.productos.map((p) => p.nombre).sort();

    test('EL CASO: «salchilimon grande» trae las que hay y dice que la grande no', async () => {
        const r = await buscar('salchilimon grande');
        expect(nombres(r)).toEqual(['Salchi-limón mediana (pareja)', 'Salchi-limón personal']);
        expect(r.tamano_que_no_hay).toBe('grande');
        expect(r.nota).toContain('SÍ está en la carta');
    });

    test('«salchilimon» en una palabra es la Salchi-limón, y no se mira como agotada', async () => {
        const r = await buscar('salchilimon');
        expect(nombres(r)).toEqual(['Salchi-limón mediana (pareja)', 'Salchi-limón personal']);
        expect(r.tamano_que_no_hay).toBeUndefined();
        expect(r.agotados_ahora).toBeUndefined();
    });

    test('«salchibarril» (agotada) NO es la Salchi-limón: sale en agotados_ahora', async () => {
        // La regresión de las 18:49: la tolerancia de más escondió los agotados y el modelo
        // anotó una Salchi-limón mediana donde el cliente pidió salchibarril.
        const r = await buscar('salchibarril');
        expect(r.agotados_ahora).toEqual(['Salchibarril personal']);
    });

    test('un tamaño que sí existe no avisa de nada', async () => {
        const r = await buscar('salchilimon mediana');
        expect(nombres(r)).toEqual(['Salchi-limón mediana (pareja)']);
        expect(r.tamano_que_no_hay).toBeUndefined();
    });

    test('lo que no existe en ningún tamaño sigue sin existir', async () => {
        const r = await buscar('pizza grande');
        expect(r.productos).toEqual([]);
        expect(r.tamano_que_no_hay).toBeUndefined();
    });
});

describe('pedir el Nequi «para cancelar» es pagar, no anular', () => {
    test('EL CASO: «Por favor me regalan Nequi para cancelar»', () => {
        expect(pago.esPreguntaDePago('Por favor me regalan Nequi para cancelar', { hayPedido: true })).toBe(true);
    });
});

describe('tomar_pedido: «para recoger» no se supone', () => {
    const falta = (args, cliente, asistente = []) =>
        registry.obtener('tomar_pedido').confirmacion.falta({ args, cliente, asistente });

    test('EL CASO: nadie habló de cómo lo recibe → vuelve al modelo para que pregunte', async () => {
        const r = await falta({ tipo_entrega: 'LLEVAR' }, ['Hola', 'Me puedes dar tres salchipapa viciosa 15500']);
        expect(r.codigo).toBe('ENTREGA_SIN_DECIR');
    });

    test.each(['yo la recojo', 'Ya paso por ella', 'para llevar porfa', 'voy por él', 'la recogemos en el local'])(
        'el cliente dijo %p → pasa',
        async (frase) => {
            expect(await falta({ tipo_entrega: 'LLEVAR' }, ['una criollita', frase])).toBeNull();
        }
    );

    test('si ya se le preguntó (o ya vio un resumen «para recogerlo»), pasa', async () => {
        const r = await falta(
            { tipo_entrega: 'LLEVAR' },
            ['una criollita', 'la segunda'],
            ['¿La quieres a domicilio, para recoger o para comer aquí?']
        );
        expect(r).toBeNull();
    });

    test('un domicilio, o un pedido de quien ya está en una mesa, no pasan por aquí', async () => {
        expect(await falta({ tipo_entrega: 'DOMICILIO' }, ['una criollita'])).toBeNull();
        expect(await falta({ tipo_entrega: 'MESA', id_mesa: 4 }, ['una criollita'])).toBeNull();
    });

    test('«para servir» sin mesa tampoco se supone', async () => {
        expect((await falta({ tipo_entrega: 'MESA' }, ['Me puede regalar una criolla mediana'])).codigo).toBe('ENTREGA_SIN_DECIR');
        expect(await falta({ tipo_entrega: 'MESA' }, ['una criollita', 'para servir'])).toBeNull();
        expect(await falta({ tipo_entrega: 'MESA' }, ['una criollita', 'ya vamos para allá'])).toBeNull();
    });
});

describe('tomar_pedido: cambiar un pedido ya tomado no crea otro', () => {
    const Models = require('../../app_core/models/conection');
    const DOMICILIO = { tipo_entrega: 'DOMICILIO', direccion: 'Clínica Palermo', cliente_telefono: '3147274829' };
    const TOMADO = { rol: 'asistente', texto: '¡Listo! Tu pedido quedó tomado. El número es ORD-7789 — guárdalo para consultar cómo va.' };
    const falta = (hilo, idConversacion = 'c1') =>
        registry.obtener('tomar_pedido').confirmacion.falta({ args: DOMICILIO, hilo, idConversacion });
    /** Lo que diría el Ledger: ¿este chat tomó un pedido hace poco? */
    const ledger = (hay) => jest.spyOn(Models.sequelize, 'query').mockResolvedValue(hay ? [{ hay: 1 }] : []);

    afterEach(() => jest.restoreAllMocks());

    test('EL CASO: «solo salsa de piña y tomate, menos la BBQ» tras el pedido → no se crea otro', async () => {
        ledger(true);
        const r = await falta([
            { rol: 'cliente', texto: 'si' },
            TOMADO,
            { rol: 'cliente', texto: 'Ok' },
            { rol: 'cliente', texto: 'Solo salsa de piña y tomate menos la salsa Barbie quio' },
        ]);
        expect(r.codigo).toBe('YA_HAY_PEDIDO');
        expect(r.mensaje).toContain('ORD-7789');
        expect(r.mensaje).toContain('pasar_a_persona');
    });

    test.each(['Me regalas otra criollita aparte', 'quiero hacer otro pedido', 'también quiero una gaseosa'])(
        'si pide otro (%p), pasa',
        async (frase) => {
            ledger(true);
            expect(await falta([TOMADO, { rol: 'cliente', texto: frase }])).toBeNull();
        }
    );

    test('si el asistente ya preguntó si es un pedido nuevo y dijo que sí, pasa', async () => {
        ledger(true);
        const r = await falta([
            TOMADO,
            { rol: 'cliente', texto: 'una dulcinea para mi hermano' },
            { rol: 'asistente', texto: '¿Es un pedido nuevo, aparte del anterior?' },
            { rol: 'cliente', texto: 'si' },
        ]);
        expect(r).toBeNull();
    });

    test('sin pedido reciente en el Ledger no se mira nada (el de ayer no cuenta)', async () => {
        ledger(false);
        expect(await falta([TOMADO, { rol: 'cliente', texto: 'una viciosa pequeña' }])).toBeNull();
    });

    test('si el Ledger no se puede leer, no se bloquea la venta', async () => {
        jest.spyOn(Models.sequelize, 'query').mockRejectedValue(new Error('sin base'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await falta([TOMADO, { rol: 'cliente', texto: 'sin salsa' }])).toBeNull();
    });

    test('sin conversación (el arnés, un test) no consulta', async () => {
        const espia = ledger(true);
        expect(await falta([TOMADO, { rol: 'cliente', texto: 'sin salsa' }], null)).toBeNull();
        expect(espia).not.toHaveBeenCalled();
    });
});

describe('«que me regalen…» pide, no pregunta', () => {
    const texto = require('../../intelligence/engine/texto');
    const N = (t) => texto.normalizar(t).replace(/[¡¿!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();

    test.each(['Que me regalen salsa de ajo porfis', 'que sea sin cebolla', 'Que venga bien caliente', 'que no le pongan BBQ'])(
        '%p va a la nota del pedido',
        (frase) => {
            expect(texto.esPeticionConQue(N(frase))).toBe(true);
            expect(confirmacion.lineasParaAnotar(frase, { afirma: false })).toEqual([frase]);
        }
    );

    test.each(['Que sabores tienen', 'que trae la viciosa', 'qué vale el domicilio'])('%p sigue siendo una pregunta', (frase) => {
        expect(texto.esPeticionConQue(N(frase))).toBe(false);
        expect(confirmacion.lineasParaAnotar(frase, { afirma: false })).toEqual([]);
    });
});

describe('con un pedido esperando el sí, hablar de OTRA entrega suelta la confirmación', () => {
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
            gate: {},
            ahora: () => new Date('2026-10-05T17:05:00-05:00'),
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
    const ARGS = { items: [{ cantidad: 3, id_producto: 31 }], tipo_entrega: 'LLEVAR', cliente_nombre: 'Kevin' };
    const conPendiente = (args) => ({
        id_conversacion: 'c1', id_negocio: 6, canal: 'whatsapp', id_externo: '573000000000',
        variables: { turnos: 3 }, humano_ultimo_en: null,
        tarea_actual: confirmacion.TAREA,
        tarea_datos: { capacidad: 'tomar_pedido', args, preguntado_en: '2026-10-05T22:04:30.000Z', repreguntas: 0 },
    });
    const decir = (c, texto) =>
        crear()({ conversacion: c, mensajes: [{ contenido: texto }], turno: { id_turno: 1 }, texto });

    beforeEach(() => {
        jest.spyOn(pago, 'ultimoPedidoVivo').mockResolvedValue(null);
        jest.spyOn(pago, 'textosDePago').mockResolvedValue({ domicilio: 'DOM', local: 'LOCAL' });
    });
    afterEach(() => jest.restoreAllMocks());

    test('EL CASO: «Hacen domicilio» con un pedido para recoger → cede al modelo SIN el pendiente', async () => {
        const d = await decir(conPendiente(ARGS), 'Hacen domicilio');
        expect(d.respuestas).toEqual([]);
        expect(d.soltarTarea).toBe(true);
        expect(d.tarea).toBeNull();
        expect(d.notaParaElModelo).toContain('DESCARTÓ');
        // El modelo no tiene que volver a buscar los productos: van en la nota.
        expect(d.notaParaElModelo).toContain('"id_producto":31');
    });

    test('preguntar por el domicilio de un pedido que YA es a domicilio no suelta nada', async () => {
        const d = await decir(
            conPendiente({ ...ARGS, tipo_entrega: 'DOMICILIO', direccion: 'Calle 1', cliente_telefono: '3001112233' }),
            '¿y el domicilio siempre me lo cobran?'
        );
        expect(d.soltarTarea).toBeUndefined();
        expect('tarea' in d).toBe(false);
    });

    test('la escalera: sin «¿lo confirmo?», con la nota al modelo y la tarea cerrada', async () => {
        let visto = null;
        const llm = async (ctx) => {
            visto = ctx;
            return { pasos: [], respuestas: ['Sí hacemos domicilio. ¿A qué dirección?'], resultado: 'resuelto', nivel: 'llm' };
        };
        const determinista = async () => ({
            pasos: [], respuestas: [], variables: {}, tarea: null, resultado: 'sin_respuesta',
            nivel: 'determinista', soltarTarea: true, notaParaElModelo: '[NOTA]',
        });
        const escalera = crearManejadorEscalera({ determinista, llm });
        const conv = conPendiente(ARGS);
        const d = await escalera({
            conversacion: conv, mensajes: [{ contenido: 'Hacen domicilio' }], turno: { id_turno: 't' },
            texto: 'Hacen domicilio', consumo: { costos: [] },
        });

        expect(d.respuestas).toEqual(['Sí hacemos domicilio. ¿A qué dirección?']);
        expect(d.tarea).toBeNull();
        expect(visto.texto).toBe('Hacen domicilio\n\n[NOTA]');
        expect(visto.conversacion.tarea_actual).toBeNull();
        // La conversación original no se toca: es del motor.
        expect(conv.tarea_actual).toBe(confirmacion.TAREA);
    });

    test('la escalera: una pregunta cualquiera sigue recordando el sí pendiente', async () => {
        const llm = async () => ({ pasos: [], respuestas: ['Vale $15.500.'], resultado: 'resuelto', nivel: 'llm' });
        const determinista = async () => ({
            pasos: [], respuestas: [], variables: {}, resultado: 'sin_respuesta', nivel: 'determinista',
        });
        const escalera = crearManejadorEscalera({ determinista, llm });
        const d = await escalera({
            conversacion: conPendiente(ARGS), mensajes: [{ contenido: '¿cuánto vale?' }], turno: { id_turno: 't' },
            texto: '¿cuánto vale?', consumo: { costos: [] },
        });
        expect(d.respuestas).toHaveLength(2);
        expect(d.respuestas[1].texto).toContain('¿Lo confirmo?');
        expect('tarea' in d).toBe(false);
    });
});
