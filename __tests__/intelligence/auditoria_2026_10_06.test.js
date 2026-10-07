/**
 * Auditoría de Zona Burger del 2026-10-06 (17:30 – 21:45).
 *
 *  1. El cajero tomó un domicilio a mano (ORD-7803). A los 25 minutos el asistente volvió, el
 *     cliente escribió «habitación 404» y el modelo armó el mismo pedido otra vez (ORD-7809): dos
 *     domicilios iguales, con dos domiciliarios. El Ledger no veía el pedido de caja.
 *  2. Un domicilio salió a nombre de «Cliente» y con dirección «pendiente» (ORD-7815): el modelo
 *     rellenó lo que no sabía.
 *  3. Lo que el cliente añadía después del resumen («Y una salchilimon», «Una viciosa mediana»,
 *     «Adición de costilla», «Mas 2 jugos») acababa en la nota, con el total sin tocar.
 *
 * Correr con:  npx jest __tests__/intelligence/auditoria_2026_10_06.test.js
 */
'use strict';

const registry = require('../../intelligence/core/registry');
const adaptador = require('../../intelligence/adapters/restaurante');
const pago = require('../../intelligence/adapters/restaurante/pago');
const confirmacion = require('../../intelligence/engine/confirmacion');
const { crearFlujoRestaurante, anadeProducto } = require('../../intelligence/adapters/restaurante/flujo');
const Models = require('../../app_core/models/conection');

beforeAll(() => adaptador.registrarCapacidades());
afterAll(() => registry._limpiar());
afterEach(() => jest.restoreAllMocks());

const falta = (extra) =>
    registry.obtener('tomar_pedido').confirmacion.falta({
        cliente: ['una criollita', 'a domicilio'],
        asistente: [],
        hilo: [{ rol: 'cliente', texto: 'habitación 404' }],
        ...extra,
    });

describe('tomar_pedido: el negocio ya le tomó el pedido a mano', () => {
    const ARGS = {
        tipo_entrega: 'DOMICILIO',
        direccion: 'Hotel Nova, habitación 404, San Miguel',
        cliente_nombre: 'alen santacruz',
        cliente_telefono: '3106557967',
    };
    /** Primera consulta: el Ledger (este chat no tomó nada). Segunda: los pedidos de caja. */
    const base = (deCaja) =>
        jest
            .spyOn(Models.sequelize, 'query')
            .mockImplementation(async (sql) =>
                /invocacion_capacidad/.test(sql) ? [] : deCaja ? [{ numero_orden: deCaja }] : []
            );

    test('EL CASO: «habitación 404» con ORD-7803 tomado en caja → no se crea otro', async () => {
        const espia = base('ORD-7803');
        const r = await falta({ args: ARGS, idConversacion: 'c1', idNegocio: 6, telefono: '573106557967' });
        expect(r.codigo).toBe('YA_HAY_PEDIDO');
        expect(r.mensaje).toContain('ORD-7803');
        expect(r.mensaje).toContain('pasar_a_persona');
        // Se busca por los últimos 10 dígitos, sin repetir el mismo número.
        const caja = espia.mock.calls.find(([sql]) => /pedid_orden/.test(sql));
        expect(caja[1].replacements.finales).toEqual(['3106557967']);
    });

    test('si pide otro, o ya dijo que es un pedido nuevo, pasa', async () => {
        base('ORD-7803');
        const comun = { args: ARGS, idConversacion: 'c1', idNegocio: 6, telefono: '573106557967' };
        expect(await falta({ ...comun, hilo: [{ rol: 'cliente', texto: 'quiero otra criollita aparte' }] })).toBeNull();
        expect(
            await falta({
                ...comun,
                hilo: [
                    { rol: 'asistente', texto: '¿Es un pedido nuevo, aparte del anterior?' },
                    { rol: 'cliente', texto: 'si' },
                ],
            })
        ).toBeNull();
    });

    test('sin pedido de caja, pasa', async () => {
        base(null);
        expect(await falta({ args: ARGS, idConversacion: 'c1', idNegocio: 6, telefono: '573106557967' })).toBeNull();
    });

    test('sin teléfono con qué comparar (BSUID que no lo ha dicho) no consulta la caja', async () => {
        const espia = base('ORD-7803');
        const r = await falta({
            args: { ...ARGS, cliente_telefono: undefined },
            idConversacion: 'c1',
            idNegocio: 6,
            telefono: null,
        });
        expect(r).toBeNull();
        expect(espia.mock.calls.some(([sql]) => /pedid_orden/.test(sql))).toBe(false);
    });

    test('si la base falla, no se bloquea la venta', async () => {
        jest.spyOn(Models.sequelize, 'query').mockRejectedValue(new Error('sin base'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await falta({ args: ARGS, idConversacion: null, idNegocio: 6, telefono: '573106557967' })).toBeNull();
    });
});

describe('tomar_pedido: ni la dirección ni el nombre se rellenan', () => {
    const DOMI = { tipo_entrega: 'DOMICILIO', direccion: 'Cra 20 #16-14', cliente_nombre: 'Karen Mora' };

    test.each(['pendiente', 'Pendiente', 'Por confirmar', 'N/A', 'sin dirección', '-', 'Dirección'])(
        'EL CASO: dirección %p → vuelve al modelo para que la pida',
        async (direccion) => {
            const r = await falta({ args: { ...DOMI, direccion } });
            expect(r.codigo).toBe('DIRECCION_REQUERIDA');
        }
    );

    test.each(['Cra 20 #16-14', 'Hotel Chambú', 'Hotel Nova, habitación por confirmar', 'Cárcel, barrio La Esperanza'])(
        'una dirección de verdad (%p) pasa',
        async (direccion) => {
            expect(await falta({ args: { ...DOMI, direccion } })).toBeNull();
        }
    );

    test.each(['Cliente', 'cliente', 'Clienta', 'usuario', 'Sin nombre'])(
        'EL CASO: nombre %p → vuelve al modelo para que lo pregunte',
        async (cliente_nombre) => {
            const r = await falta({ args: { ...DOMI, cliente_nombre } });
            expect(r.codigo).toBe('NOMBRE_REQUERIDO');
        }
    );

    test('un nombre de verdad pasa, también para recoger', async () => {
        expect(await falta({ args: DOMI })).toBeNull();
        expect(
            await falta({
                args: { tipo_entrega: 'LLEVAR', cliente_nombre: 'Juan Pablo' },
                cliente: ['una salchilimon', 'para recoger'],
            })
        ).toBeNull();
    });

    test('«pendiente» en un pedido para recoger no es problema: ahí no hay dirección', async () => {
        const r = await falta({
            args: { tipo_entrega: 'LLEVAR', direccion: 'pendiente', cliente_nombre: 'Juan Pablo' },
            cliente: ['para recoger'],
        });
        expect(r).toBeNull();
    });
});

describe('con un pedido esperando el sí, un producto añadido no es una nota', () => {
    test.each([
        'Y una salchilimon',
        'Una viciosa mediana',
        'Una viciosa mediana y una pequeña',
        'Mas 2 jugos de maracuya en leche, eso seria todo',
        'Adición de costilla',
        'La salchipapa con adicion de costilla',
        'también la dulcinea',
        '2 gaseosas',
    ])('%p lo lee el modelo', (t) => {
        expect(anadeProducto(t)).toBe(true);
    });

    test.each([
        'sin cebolla por favor',
        'Pero el domicilio es cerca',
        'Frente a torres del cielo',
        'Clínica Proinsalud',
        '3 piso apto 301',
        '2 cuadras abajo del parque',
        'Un momento',
        '3185046173',
        'La salsa aparte',
    ])('%p sigue siendo una nota', (t) => {
        expect(anadeProducto(t)).toBe(false);
    });

    test('EL CASO: «Y una salchilimon» con el resumen pendiente → al modelo, y el pendiente sigue', async () => {
        const gate = { ejecutar: jest.fn() };
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
            ahora: () => new Date('2026-10-06T20:33:55-05:00'),
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
        const conversacion = {
            id_conversacion: 'c1', id_negocio: 6, canal: 'whatsapp', id_externo: '573000000000',
            variables: { turnos: 3 }, humano_ultimo_en: null,
            tarea_actual: confirmacion.TAREA,
            tarea_datos: {
                capacidad: 'tomar_pedido',
                args: { items: [{ cantidad: 1, id_producto: 31 }], tipo_entrega: 'LLEVAR', cliente_nombre: 'Anderson' },
                preguntado_en: '2026-10-07T01:33:15.000Z',
                repreguntas: 0,
            },
        };
        const d = await flujo({
            conversacion, mensajes: [{ contenido: 'Y una salchilimon' }], turno: { id_turno: 't' },
            texto: 'Y una salchilimon', consumo: { costos: [] },
        });
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(d.respuestas).toEqual([]);
        expect(d.pasos[0].decision).toBe('confirmacion_pregunta_al_modelo');
        expect('tarea' in d).toBe(false);
    });
});
