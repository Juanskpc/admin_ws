/**
 * Auditoría de Zona Burger del 2026-10-07: tres de los nueve pedidos de la noche quedaron con la
 * entrega equivocada y los corrigió el cajero a mano.
 *
 *  1. ORD-7876 — «Una salchilimon personal» → resumen «para recoger» sin preguntar: la guardia
 *     de la entrega dio por dicho un «para recoger» del 2 de octubre.
 *  2. ORD-7878 — se le preguntó cómo lo recibía, el cliente siguió dictando productos, y el
 *     modelo eligió «para servir»: la guardia se conformaba con que se hubiera preguntado.
 *  3. ORD-7877 — con un domicilio esperando el sí, «¿o me queda cerca para ir a recoger?» se
 *     contestó y el «sí» siguiente tomó el domicilio.
 *  4. ORD-7876 otra vez — el cajero contestó y el «sí» de la clienta, que era para él, lo
 *     ejecutó el asistente.
 *  5. ORD-7878 otra vez — cada producto añadido con el resumen esperando rehacía el pedido solo
 *     con lo nuevo.
 *
 * Correr con:  npx jest __tests__/intelligence/auditoria_2026_10_07.test.js
 */
'use strict';

const registry = require('../../intelligence/core/registry');
const adaptador = require('../../intelligence/adapters/restaurante');
const pago = require('../../intelligence/adapters/restaurante/pago');
const confirmacion = require('../../intelligence/engine/confirmacion');
const { crearFlujoRestaurante } = require('../../intelligence/adapters/restaurante/flujo');
const { crearManejadorEscalera } = require('../../intelligence/engine/manejadorEscalera');
const Models = require('../../app_core/models/conection');

const SALUDO = { rol: 'asistente', texto: '👋 ¡Buenas noches! Te saluda *ZONA BURGER*. Aquí tienes la carta completa 👇' };
const PREGUNTA = { rol: 'asistente', texto: '¿La quieres a domicilio, para recoger o para comer aquí?' };
const cliente = (texto) => ({ rol: 'cliente', texto });

beforeAll(() => adaptador.registrarCapacidades());
afterAll(() => registry._limpiar());

describe('tomar_pedido: la entrega se mira en el pedido de ahora, y preguntar no es que conteste', () => {
    /** Sin pedido previo: ni en el Ledger ni tomado a mano. */
    beforeEach(() => jest.spyOn(Models.sequelize, 'query').mockResolvedValue([]));
    afterEach(() => jest.restoreAllMocks());

    const falta = (tipo, hilo) =>
        registry.obtener('tomar_pedido').confirmacion.falta({
            args: { tipo_entrega: tipo, cliente_nombre: 'Karen' },
            hilo,
            cliente: hilo.filter((m) => m.rol === 'cliente').map((m) => m.texto),
            asistente: hilo.filter((m) => m.rol !== 'cliente').map((m) => m.texto),
            idConversacion: 'c1',
            idNegocio: 6,
        });

    test('EL CASO (ORD-7876): un «para recoger» de otro día no vale para el pedido de hoy', async () => {
        const r = await falta('LLEVAR', [
            cliente('Dos salchilimon'),
            { rol: 'asistente', texto: '¿Las dos son para que pases a recogerlas o te las llevamos a domicilio?' },
            cliente('Para recoger, ya vamos'),
            { rol: 'asistente', texto: '¡Listo! Tu pedido quedó tomado. El número es ORD-7600 — guárdalo.' },
            cliente('Buena veci'),
            SALUDO,
            cliente('Tienen servicio hoy?'),
            { rol: 'asistente', texto: 'Sí, Karen 😊 Hoy estamos atendiendo y tomando pedidos.' },
            cliente('Una salchilimon personal porfiss'),
        ]);
        expect(r?.codigo).toBe('ENTREGA_SIN_DECIR');
    });

    test('EL CASO (ORD-7878): se le preguntó y siguió dictando productos → se vuelve a preguntar', async () => {
        const hilo = [SALUDO, cliente('1 salchi-limon personal'), PREGUNTA, cliente('1 salchi-limon media')];
        expect((await falta('MESA', hilo))?.codigo).toBe('ENTREGA_SIN_DECIR');
        expect((await falta('LLEVAR', hilo))?.codigo).toBe('ENTREGA_SIN_DECIR');
    });

    test('un «sí» a una pregunta de tres opciones no contesta cómo lo recibe', async () => {
        const r = await falta('LLEVAR', [SALUDO, cliente('Una viciosa personal'), PREGUNTA, cliente('Si')]);
        expect(r?.codigo).toBe('ENTREGA_SIN_DECIR');
    });

    test.each(['Para recoger', 'la segunda', 'yo paso por ella'])(
        'se le preguntó y contestó %p → pasa',
        async (respuesta) => {
            expect(await falta('LLEVAR', [SALUDO, cliente('Una viciosa'), PREGUNTA, cliente(respuesta)])).toBeNull();
        }
    );

    test('ya vio el resumen «para recogerlo» y solo añade un producto → pasa', async () => {
        const r = await falta('LLEVAR', [
            SALUDO,
            cliente('Una viciosa'),
            PREGUNTA,
            cliente('Para recoger'),
            { rol: 'asistente', texto: '¿Confirmo tu pedido a nombre de Karen, para recogerlo en el local? • 1 × Viciosa' },
            cliente('Y una salchilimon'),
        ]);
        expect(r).toBeNull();
    });

    test('lo dijo en este pedido sin que se le preguntara → pasa', async () => {
        expect(await falta('LLEVAR', [SALUDO, cliente('Me prepara una salchilimon, ya paso por ella')])).toBeNull();
        expect(await falta('MESA', [SALUDO, cliente('Una viciosa para comer aquí')])).toBeNull();
    });
});

describe('con un resumen esperando el sí', () => {
    afterEach(() => jest.restoreAllMocks());

    function montar({ gate = { ejecutar: jest.fn() } } = {}) {
        jest.spyOn(pago, 'ultimoPedidoVivo').mockResolvedValue(null);
        jest.spyOn(pago, 'textosDePago').mockResolvedValue({ domicilio: 'DOM', local: 'LOCAL' });
        const flujo = crearFlujoRestaurante({
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
            ahora: () => new Date('2026-10-07T19:31:23-05:00'),
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
        return { flujo, gate };
    }

    const conversacion = (args, extra = {}) => ({
        id_conversacion: 'c1', id_negocio: 6, canal: 'whatsapp', id_externo: '573000000000',
        variables: { turnos: 3 }, humano_ultimo_en: null,
        tarea_actual: confirmacion.TAREA,
        tarea_datos: {
            capacidad: 'tomar_pedido',
            args,
            preguntado_en: '2026-10-08T00:30:53.000Z', // 19:30:53 de Bogotá
            repreguntas: 0,
        },
        ...extra,
    });
    const turno = (flujo, conv, texto) =>
        flujo({ conversacion: conv, mensajes: [{ contenido: texto }], turno: { id_turno: 't' }, texto, consumo: { costos: [] } });

    const DOMICILIO = {
        items: [{ cantidad: 1, id_producto: 32 }], tipo_entrega: 'DOMICILIO',
        direccion: 'Carrera 24 número 28 80, Calvario', cliente_nombre: 'Stiven', cliente_telefono: '3126920681',
    };
    const RECOGER = { items: [{ cantidad: 1, id_producto: 29 }], tipo_entrega: 'LLEVAR', cliente_nombre: 'Karen Gisell' };

    test('EL CASO (ORD-7877): domicilio esperando y «o me queda cerca para ir a recoger» → se suelta', async () => {
        const { flujo, gate } = montar();
        const d = await turno(flujo, conversacion(DOMICILIO), 'O me queda SERCA para ir a recoger');
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(d.soltarTarea).toBe(true);
        expect(d.pasos[0].decision).toBe('confirmacion_soltada_por_entrega');
        expect(d.pasos[0].motivo).toMatchObject({ de: 'DOMICILIO', a: 'LLEVAR' });
        expect(d.notaParaElModelo).toContain('DESCARTÓ');
    });

    test('EL CASO (ORD-7876): el cajero escribió tras el resumen → el «sí» no ejecuta, se enseña otra vez', async () => {
        const { flujo, gate } = montar();
        const conv = conversacion(RECOGER, { humano_ultimo_en: '2026-10-08T00:31:22.000Z' });
        const d = await turno(flujo, conv, 'si');

        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(d.pasos[0].decision).toBe('confirmacion_si_tras_persona');
        expect(d.respuestas[0].texto).toContain('te lo muestro otra vez');
        expect(d.respuestas[0].opciones.map((o) => o.id)).toEqual(['si', 'no']);
        // El pendiente sigue, con el reloj en hora: el siguiente «sí» ya es a ESE resumen.
        expect(d.tarea.nombre).toBe(confirmacion.TAREA);
        expect(Date.parse(d.tarea.datos.preguntado_en)).toBeGreaterThan(Date.parse(conv.humano_ultimo_en));
    });

    test('si la persona escribió ANTES del resumen, el «sí» sigue su camino de siempre', async () => {
        const { flujo } = montar();
        const conv = conversacion(RECOGER, { humano_ultimo_en: '2026-10-08T00:20:00.000Z' });
        const d = await turno(flujo, conv, 'si');
        const decisiones = d.pasos.map((p) => p.decision);
        expect(decisiones).not.toContain('confirmacion_si_tras_persona');
    });

    test('EL CASO (ORD-7878): un producto añadido va al modelo CON lo que ya estaba anotado', async () => {
        const { flujo } = montar();
        const args = { items: [{ cantidad: 1, id_producto: 62 }], tipo_entrega: 'LLEVAR', cliente_nombre: 'Danniel paz' };
        const d = await turno(flujo, conversacion(args), '1 dulce pecado');
        expect(d.pasos[0].decision).toBe('confirmacion_pregunta_al_modelo');
        expect(d.soltarTarea).toBeUndefined();
        expect(d.notaParaElModelo).toContain('"id_producto":62');
        expect(d.notaParaElModelo).toContain('TODO lo que ya estaba anotado');
    });

    test('la escalera le pasa esa nota al modelo aunque la tarea no se suelte', async () => {
        const llm = jest.fn().mockResolvedValue({
            pasos: [], respuestas: ['Listo, agrego el Dulce pecado.'], variables: {}, resultado: 'resuelto', nivel: 'llm',
        });
        const nota = '[Nota del sistema: hay un pedido esperando el sí]';
        const manejador = crearManejadorEscalera({
            determinista: async () => ({
                pasos: [], respuestas: [], variables: {}, resultado: 'sin_respuesta', nivel: 'determinista',
                notaParaElModelo: nota,
            }),
            llm,
        });
        await manejador({
            conversacion: conversacion(RECOGER), mensajes: [{ contenido: '1 dulce pecado' }],
            turno: { id_turno: 't' }, texto: '1 dulce pecado', consumo: { costos: [] },
        });
        expect(llm).toHaveBeenCalledTimes(1);
        expect(llm.mock.calls[0][0].texto).toBe(`1 dulce pecado\n\n${nota}`);
        // El pendiente llega intacto: no se soltó.
        expect(llm.mock.calls[0][0].conversacion.tarea_actual).toBe(confirmacion.TAREA);
    });
});

describe('buscar_producto: lo que el negocio desactivó se dice «agotado por hoy», no «no encuentro»', () => {
    const cartaService = require('../../app_restaurante_api/services/cartaService');
    const sinTildes = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const VENDE = [{ id_producto: 30, nombre: 'Criollita pequeña', descripcion: 'Salchipapa con chorizo.', precio: 15500, visible: true }];
    /** Desactivadas hoy por el negocio: están en la carta, pero no se venden. */
    const DESACTIVADAS = [
        { id_producto: 29, nombre: 'Salchi-limón personal', descripcion: 'Papa bañada en limón.', precio: 17500, visible: true },
        { id_producto: 62, nombre: 'Salchi-limón mediana (pareja)', descripcion: 'Papa bañada en limón.', precio: 29000, visible: true },
    ];

    beforeEach(() => {
        jest.spyOn(cartaService, 'asistenteMiraStock').mockResolvedValue(false);
        jest.spyOn(cartaService, 'getCartaPublicaCompleta').mockResolvedValue([{ nombre: 'SALCHIPAPAS', productos: VENDE }]);
        // Como el servicio real: la frase entera, letra por letra, contra el nombre o la descripción.
        jest.spyOn(cartaService, 'buscarProductos').mockImplementation(async (id, termino, opciones = {}) => {
            const t = sinTildes(termino);
            return [...VENDE, ...(opciones.includeDisabled ? DESACTIVADAS : [])].filter(
                (p) => sinTildes(p.nombre).includes(t) || sinTildes(p.descripcion).includes(t)
            );
        });
    });
    afterEach(() => jest.restoreAllMocks());

    const buscar = (termino) => registry.obtener('buscar_producto').ejecutar({ idNegocio: 6, args: { termino } });

    test.each(['salchilimon', 'Salchilimon', 'salchi limon personal'])(
        'EL CASO: «¿tienes disponible %s?» con la Salchi-limón desactivada → agotada, con la frase',
        async (termino) => {
            const r = await buscar(termino);
            expect(r.agotados_ahora).toEqual(expect.arrayContaining(['Salchi-limón personal']));
            expect(r.nota_agotado).toContain('hoy se agotó');
            expect(r.nota_agotado).toContain('Nunca digas «no encuentro»');
        }
    );

    test('lo que de verdad no existe sigue sin existir, y sin frase de agotado', async () => {
        const r = await buscar('pizza hawaiana');
        expect(r.agotados_ahora).toEqual([]);
        expect(r.nota_agotado).toBeUndefined();
    });

    test('lo que sí se vende no se da por agotado', async () => {
        const r = await buscar('criollita');
        expect(r.productos.map((p) => p.nombre)).toEqual(['Criollita pequeña']);
        expect(r.agotados_ahora).toBeUndefined();
    });
});
