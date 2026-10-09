/**
 * Menos mensajes por pedido (Zona Burger, 2026-10-07).
 *
 * Una salchipapa para recoger costó SIETE mensajes del asistente:
 *
 *   «Una salchipapa Criolla mediana»            → «¿A nombre de quién queda el pedido?»
 *   «Miguel Narváez»                            → «¿Para recoger, a domicilio o para comer aquí?»
 *   «Me confirmas en cuánto está, yo paso a     → «Los pedidos están saliendo en 40 a 60 minutos…
 *    recogerla»                                    Todavía no tengo ningún pedido tuyo»
 *   «Para recoger una salchipapa Criolla…»      → resumen
 *
 * Tres causas: cada dato que faltaba volvía solo (un turno por dato); a quien contestó cómo lo
 * recibía Y preguntó el tiempo se le oyó solo la pregunta; y el tiempo, que es lo que el cliente
 * pregunta después, no estaba en el resumen —y era el del domicilio, también para quien recoge—.
 *
 * Correr con:  npx jest __tests__/intelligence/menos_mensajes_por_pedido.test.js
 */
'use strict';

const registry = require('../../intelligence/core/registry');
const adaptador = require('../../intelligence/adapters/restaurante');
const pago = require('../../intelligence/adapters/restaurante/pago');
const contextoNegocio = require('../../intelligence/core/contextoNegocio');
const { crearFlujoRestaurante } = require('../../intelligence/adapters/restaurante/flujo');
const Models = require('../../app_core/models/conection');

const SALUDO = { rol: 'asistente', texto: '👋 ¡Buenas noches! Te saluda *ZONA BURGER*. Aquí tienes la carta 👇' };
const cliente = (texto) => ({ rol: 'cliente', texto });

beforeAll(() => adaptador.registrarCapacidades());
afterAll(() => registry._limpiar());
afterEach(() => jest.restoreAllMocks());

describe('tomar_pedido: lo que falta se pide junto', () => {
    beforeEach(() => jest.spyOn(Models.sequelize, 'query').mockResolvedValue([]));

    const falta = (args, hilo) =>
        registry.obtener('tomar_pedido').confirmacion.falta({
            args,
            hilo,
            cliente: hilo.filter((m) => m.rol === 'cliente').map((m) => m.texto),
            asistente: hilo.filter((m) => m.rol !== 'cliente').map((m) => m.texto),
            idConversacion: 'c1',
            idNegocio: 6,
        });

    test('EL CASO: sin nombre y sin decir cómo lo recibe → UNA pregunta con las dos cosas', async () => {
        const r = await falta(
            { tipo_entrega: 'LLEVAR', cliente_nombre: 'cliente' },
            [SALUDO, cliente('Para pedir una salchipapa'), cliente('Una salchipapa Criolla mediana')]
        );
        expect(r.codigo).toBe('FALTAN_DATOS');
        expect(r.mensaje).toContain('UN solo mensaje');
        expect(r.mensaje).toContain('A domicilio');
        expect(r.mensaje).toContain('dirección con el barrio y un teléfono');
        expect(r.mensaje).toContain('dime a nombre de quién');
    });

    test('con el nombre ya sabido, la pregunta de la entrega no lo vuelve a pedir', async () => {
        const r = await falta(
            { tipo_entrega: 'LLEVAR', cliente_nombre: 'Miguel Narváez' },
            [SALUDO, cliente('Una salchipapa Criolla mediana')]
        );
        expect(r.codigo).toBe('ENTREGA_SIN_DECIR');
        expect(r.mensaje).toContain('A domicilio');
        expect(r.mensaje).not.toContain('dime a nombre de quién');
    });

    test('domicilio sin dirección ni nombre → las dos en un mensaje', async () => {
        const r = await falta(
            { tipo_entrega: 'DOMICILIO', direccion: 'pendiente', cliente_nombre: 'Cliente' },
            [SALUDO, cliente('Una criollita a domicilio')]
        );
        expect(r.codigo).toBe('FALTAN_DATOS');
        expect(r.mensaje).toContain('las dos cosas en UN solo mensaje');
    });

    test('con una sola falta, su código de siempre', async () => {
        const hilo = [SALUDO, cliente('Una criollita para recoger')];
        expect((await falta({ tipo_entrega: 'LLEVAR', cliente_nombre: 'cliente' }, hilo)).codigo).toBe('NOMBRE_REQUERIDO');
        expect(
            (await falta({ tipo_entrega: 'DOMICILIO', direccion: 'N/A', cliente_nombre: 'Ana' }, hilo)).codigo
        ).toBe('DIRECCION_REQUERIDA');
        expect(await falta({ tipo_entrega: 'LLEVAR', cliente_nombre: 'Ana' }, hilo)).toBeNull();
    });
});

describe('tomar_pedido: el resumen dice cuánto falta', () => {
    const PRODUCTO = { id_producto: 59, nombre: 'Criollita mediana', precio: 28000 };
    const empaqueService = require('../../app_restaurante_api/services/empaqueService');

    function montar(tiempos) {
        jest.spyOn(contextoNegocio, 'obtener').mockResolvedValue({ id: 6, ...tiempos });
        jest.spyOn(Models.CartaProducto, 'findAll').mockResolvedValue([PRODUCTO]);
        jest.spyOn(empaqueService, 'calcular').mockResolvedValue([]);
        jest.spyOn(Models.sequelize, 'query').mockResolvedValue([]);
    }
    const resumen = (args) =>
        registry.obtener('tomar_pedido').confirmacion.pregunta({
            idNegocio: 6,
            args: { items: [{ cantidad: 1, id_producto: 59 }], cliente_nombre: 'Miguel Narváez', ...args },
        });

    const DOS = { tiempoEstimado: { min: 40, max: 60 }, tiempoRecoger: { min: 20, max: 40 } };

    test('EL CASO: para recoger dice el tiempo de RECOGER, no el del domicilio', async () => {
        montar(DOS);
        const texto = await resumen({ tipo_entrega: 'LLEVAR' });
        expect(texto).toContain('⏱️ Estará listo en unos 20 a 40 minutos, contados desde que confirmes.');
        expect(texto).not.toContain('40 a 60');
    });

    test('a domicilio dice el de la entrega', async () => {
        montar(DOS);
        const texto = await resumen({ tipo_entrega: 'DOMICILIO', direccion: 'Cra 20 #16-14', cliente_telefono: '3001234567' });
        expect(texto).toContain('⏱️ Te llega en unos 40 a 60 minutos, contados desde que confirmes.');
    });

    test('sin tiempo de recoger aparte, para recoger se dice el de siempre', async () => {
        montar({ tiempoEstimado: { min: 40, max: 60 }, tiempoRecoger: null });
        expect(await resumen({ tipo_entrega: 'LLEVAR' })).toContain('Estará listo en unos 40 a 60 minutos');
    });

    test('sin ningún tiempo configurado no se inventa uno', async () => {
        montar({ tiempoEstimado: null, tiempoRecoger: null });
        expect(await resumen({ tipo_entrega: 'LLEVAR' })).not.toContain('⏱️');
    });

    test('va después del total y antes del aviso', async () => {
        montar(DOS);
        const lineas = (await resumen({ tipo_entrega: 'LLEVAR' })).split('\n');
        const total = lineas.findIndex((l) => l.startsWith('*Total:'));
        expect(lineas[total + 1]).toContain('⏱️');
        expect(lineas[total + 2]).toContain('El total es aproximado');
    });
});

describe('el flujo: «¿cuánto se demora?»', () => {
    function montar({ tiempoRecoger = { min: 20, max: 40 }, hayPedido = false, ultimo = null } = {}) {
        jest.spyOn(pago, 'ultimoPedidoVivo').mockResolvedValue(ultimo);
        jest.spyOn(pago, 'textosDePago').mockResolvedValue({ domicilio: 'DOM', local: 'LOCAL' });
        return crearFlujoRestaurante({
            tienePedidoReciente: async () => hayPedido,
            yaSeLeContestoSuPedido: async () => false,
            contextoNegocio: {
                obtener: async () => ({
                    id: 6, nombre: 'ZONA BURGER', tratamiento: 'ZONA BURGER', atencion: null,
                    tipoNegocio: 'RESTAURANTE', tiempoEstimado: { min: 40, max: 60 }, tiempoRecoger,
                }),
            },
            identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
            gate: { ejecutar: jest.fn() },
            ahora: () => new Date('2026-10-07T21:12:07-05:00'),
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
    }
    const conversacion = () => ({
        id_conversacion: 'c1', id_negocio: 6, canal: 'whatsapp', id_externo: '573000000000',
        variables: { turnos: 4 }, humano_ultimo_en: null, tarea_actual: null, tarea_datos: {},
    });
    const decir = (flujo, texto) =>
        flujo({ conversacion: conversacion(), mensajes: [{ contenido: texto }], turno: { id_turno: 't' }, texto, consumo: { costos: [] } });

    test('EL CASO: «Me confirmas en cuánto está, yo paso a recogerla» → al modelo, con el tiempo de recoger', async () => {
        const d = await decir(montar(), 'Me confirmas en cuanto está yo paso a recogerla');
        expect(d.respuestas).toEqual([]);
        expect(d.pasos[0].decision).toBe('tiempo_con_entrega_al_modelo');
        expect(d.pasos[0].motivo).toMatchObject({ entrega: 'LLEVAR' });
        expect(d.notaParaElModelo).toContain('20 a 40 minutos');
        expect(d.notaParaElModelo).toContain('No le digas que no tiene ningún pedido');
    });

    test('la pregunta suelta, sin pedido: los dos tiempos en una frase', async () => {
        const d = await decir(montar(), '¿Cuánto se demora?');
        const texto = d.respuestas[0];
        expect(texto).toContain('Para recoger, *20 a 40 minutos*');
        expect(texto).toContain('a domicilio, *40 a 60 minutos*');
    });

    test('con un pedido para recoger ya tomado: el tiempo de recoger', async () => {
        const flujo = montar({ hayPedido: true, ultimo: { numero_orden: 'ORD-1', tipo_pedido: 'LLEVAR' } });
        const d = await decir(flujo, 'Cuánto se demora?');
        expect(d.respuestas[0]).toContain('*20 a 40 minutos*');
        expect(d.respuestas[0]).not.toContain('40 a 60');
    });

    test('con un domicilio ya tomado: el de la entrega', async () => {
        const flujo = montar({ hayPedido: true, ultimo: { numero_orden: 'ORD-2', tipo_pedido: 'DOMICILIO' } });
        const d = await decir(flujo, 'Cuánto se demora?');
        expect(d.respuestas[0]).toContain('*40 a 60 minutos*');
    });

    test('sin tiempo de recoger aparte, todo sigue como antes', async () => {
        const d = await decir(montar({ tiempoRecoger: null }), '¿Cuánto se demora?');
        expect(d.respuestas[0]).toContain('Los pedidos están saliendo en *40 a 60 minutos*');
    });
});
