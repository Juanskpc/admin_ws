/**
 * Lo que escribe un cliente de verdad, contra el catálogo de barrios de Pasto entero (555 lugares).
 *
 * Nace de las pruebas reales del 2026-10-16 en Pregonchos: tres domicilios de cuatro salieron sin
 * cobrar el barrio, y la batería —que usaba barrios de juguete y direcciones limpias— no lo veía.
 * Los ejemplos están en `__tests__/_apoyo/direcciones_estilo_clientes.js`, inventados con el estilo de los
 * mensajes de los clientes de Zona Burger (sin copiar ninguno).
 *
 * Lo que se protege, en orden de gravedad:
 *  1. NUNCA cobrar el domicilio de otro barrio («corazon de jesus 2» no es Corazón de Jesús, que
 *     está en otra comuna; «frente al centro comercial» no es el barrio Centro; «Torres de San
 *     Luis» no es la vereda San Luis).
 *  2. Reconocer el barrio cuando el cliente lo dice a su manera (números por romanos, «b/», «el.Prado»).
 *  3. No suponer la forma de pago, sin borrar lo que la cocina necesita de la nota.
 *
 * Correr con:  npx jest __tests__/intelligence/estilo_clientes.test.js
 */
'use strict';

const registry = require('../../intelligence/core/registry');
const adaptadorRestaurante = require('../../intelligence/adapters/restaurante');
const pago = require('../../intelligence/adapters/restaurante/pago');
const flujoRestaurante = require('../../intelligence/adapters/restaurante/flujo');
const confirmacion = require('../../intelligence/engine/confirmacion');
const whatsapp = require('../../intelligence/channels/whatsapp/adaptador');
const catalogoPasto = require('../../migrations/data/barrios_pasto.json');
const {
    DIRECCIONES,
    BARRIOS_DEL_FORMULARIO,
    DICE_EL_PAGO,
    TELEFONOS,
} = require('../_apoyo/direcciones_estilo_clientes');

const { barrioEnTexto, elegirBarrio, leerTelefono } = flujoRestaurante;

/** El catálogo de Pasto como lo ve el asistente: con id y un precio por zona (distinto por zona). */
let siguiente = 0;
const PASTO = catalogoPasto.zonas.flatMap((z, iz) =>
    z.lugares.map((l) => ({ id_barrio: ++siguiente, nombre: l.nombre, zona: z.nombre, valor: 4000 + iz * 500 }))
);
const porNombre = (nombre) => PASTO.filter((b) => b.nombre === nombre);

beforeAll(() => adaptadorRestaurante.registrarCapacidades());
afterAll(() => registry._limpiar());
afterEach(() => jest.restoreAllMocks());

describe('el catálogo de prueba es el de verdad', () => {
    test('555 lugares en 29 zonas, y cada barrio esperado existe una sola vez', () => {
        expect(PASTO).toHaveLength(555);
        const esperados = [...DIRECCIONES, ...BARRIOS_DEL_FORMULARIO].map(([, b]) => b).filter(Boolean);
        for (const nombre of new Set(esperados)) expect([nombre, porNombre(nombre).length]).toEqual([nombre, 1]);
    });
});

describe('1. el barrio dentro de una dirección escrita a mano', () => {
    test.each(DIRECCIONES)('«%s» → %p', (texto, esperado) => {
        const r = barrioEnTexto(texto, PASTO);
        expect(r ? r.nombre : null).toBe(esperado);
    });

    // Los tres que cobrarían el domicilio de OTRO barrio, aparte para que no se pierdan en la lista.
    test('nunca el barrio equivocado: el número, el sitio y el conjunto', () => {
        expect(barrioEnTexto('Mz 4 casa 2 corazon de jesus 2', PASTO).nombre).toBe('Corazón De Jesús II');
        expect(barrioEnTexto('Alameda 2 casa 14', PASTO).nombre).toBe('Alameda II');
        expect(barrioEnTexto('Mz 3 casa 4 frente al centro comercial', PASTO)).toBeNull();
        expect(barrioEnTexto('Torres de san Luis torre 10 apt 205', PASTO)).toBeNull();
    });
});

describe('2. el barrio escrito en el formulario («Barrio:»)', () => {
    test.each(BARRIOS_DEL_FORMULARIO)('«%s» → %p', (texto, esperado) => {
        const r = elegirBarrio(texto, PASTO);
        expect(r && !r.ambiguos ? r.nombre : r).toBe(esperado);
    });

    test('lo que tiene dos o más candidatos se pregunta, no se elige', () => {
        for (const texto of ['Santa Fe', 'Rosario', 'Quito Lopez', 'Chambu', 'Aquine']) {
            const r = elegirBarrio(texto, PASTO);
            expect([texto, Boolean(r?.ambiguos)]).toEqual([texto, true]);
        }
    });

    test('lo que no existe no se adivina', () => {
        for (const texto of ['bueno aires', 'Narnia', 'mi casa', 'xx']) {
            const r = elegirBarrio(texto, PASTO);
            expect([texto, r && !r.ambiguos ? r.nombre : null]).toEqual([texto, null]);
        }
    });

    test('un conjunto escrito como barrio no es el barrio («Torres de San Luis» no es la vereda)', () => {
        expect(elegirBarrio('Torres de San Luis', PASTO)).toBeNull();
        expect(elegirBarrio('Hotel casa madrigal', PASTO)).toBeNull();
        expect(elegirBarrio('San Luis', PASTO).nombre).toBe('San Luis');
    });

    test('si el modelo saca el barrio de un nombre de conjunto, no vale (evaluación del 2026-10-16)', () => {
        const sanLuis = porNombre('San Luis')[0];
        expect(flujoRestaurante.soloComoConjunto('Torres de san Luis torre 10 apto 205', sanLuis)).toBe(true);
        expect(flujoRestaurante.soloComoConjunto('Torres de san Luis, barrio san luis', sanLuis)).toBe(false);
        expect(flujoRestaurante.soloComoConjunto('Calle 3 # 4-5 san luis', sanLuis)).toBe(false);
        expect(flujoRestaurante.soloComoConjunto('', sanLuis)).toBe(false);
    });

    test('«2» contesta a «¿cuál de estos?» y no se confunde con «dos» del nombre', () => {
        const opciones = porNombre('Quito López I').concat(porNombre('Quito López II')).map((b) => b.id_barrio);
        expect(elegirBarrio('2', PASTO, opciones).nombre).toBe('Quito López II');
        expect(elegirBarrio('el 1', PASTO, opciones).nombre).toBe('Quito López I');
    });
});

describe('3. una conversación entera por el formulario, con el catálogo de Pasto', () => {
    /** Mismo montaje que la batería del formulario, con los 555 barrios de Pasto. */
    function montar({ telefonoVerificado = '573000000000' } = {}) {
        jest.spyOn(pago, 'ultimoPedidoVivo').mockResolvedValue(null);
        jest.spyOn(pago, 'textosDePago').mockResolvedValue({ domicilio: 'DOM', local: 'LOCAL' });
        return flujoRestaurante.crearFlujoRestaurante({
            tienePedidoReciente: async () => false,
            yaSeLeContestoSuPedido: async () => false,
            contextoNegocio: {
                obtener: async () => ({
                    id: 12, nombre: 'PREGONCHOS', tratamiento: 'PREGONCHOS', atencion: null,
                    tipoNegocio: 'RESTAURANTE', tiempoEstimado: { min: 40, max: 60 }, domicilioRango: null,
                }),
            },
            identidad: { resolver: async () => ({ principal: { telefono_verificado: telefonoVerificado } }) },
            gate: { ejecutar: jest.fn().mockResolvedValue({ resultado: { numero_orden: 'ORD-900' } }) },
            ahora: () => new Date('2026-10-16T19:30:00-05:00'),
            estadoAtencion: async () => ({ estado: 'ABIERTO' }),
            proximaApertura: async () => null,
            leerCarta: async () => ({ enlace: 'https://escalapp.cloud/restaurante/carta/12', productos: [] }),
            catalogo: {
                barrios: async () => ({ habilitado: true, barrios: PASTO }),
                mesas: async () => [],
                resolverBarrio: async () => null,
                resolverMesa: async () => null,
                resolverExclusiones: async ({ lineas }) => lineas.map(() => ({ validas: [], descartadas: [] })),
                formularioEntrega: async () => 'FLOW1',
            },
        });
    }
    const formulario = (campos) =>
        whatsapp.textoDeMensaje({
            type: 'interactive',
            interactive: {
                type: 'nfm_reply',
                nfm_reply: { name: 'flow', response_json: JSON.stringify({ flow_token: 'entrega:c1', ...campos }) },
            },
        });
    async function conversar(flujo, mensajes) {
        let tarea = null;
        let ultima = null;
        for (const texto of mensajes) {
            ultima = await flujo({
                conversacion: {
                    id_conversacion: 'c1', id_negocio: 12, canal: 'whatsapp', id_externo: '573000000000',
                    variables: { turnos: 2, nombre: 'Ana' }, humano_ultimo_en: null,
                    tarea_actual: tarea?.nombre ?? null, tarea_datos: tarea?.datos ?? null,
                },
                mensajes: [{ contenido: texto }], turno: { id_turno: 't' }, texto, consumo: { costos: [] },
            });
            if (ultima.soltarTarea) tarea = null;
            else if (ultima.tarea !== undefined) tarea = ultima.tarea;
        }
        return { tarea, ultima };
    }

    test.each(BARRIOS_DEL_FORMULARIO)('Barrio «%s» → el pedido sale con %p y su precio', async (barrio, esperado) => {
        const { tarea } = await conversar(montar(), [
            '#P12-4x1',
            formulario({ entrega: 'domicilio', barrio, direccion: 'Mz 4 casa 12', pago: 'Efectivo' }),
        ]);
        expect(tarea.nombre).toBe(confirmacion.TAREA);
        expect(tarea.datos.args.id_barrio).toBe(porNombre(esperado)[0].id_barrio);
    });

    test('un barrio con varios candidatos se pregunta con la lista, y el número elige', async () => {
        const flujo = montar();
        const primero = await conversar(flujo, [
            '#P12-4x1',
            formulario({ entrega: 'domicilio', barrio: 'Quito Lopez', direccion: 'Mz 4 casa 12', pago: 'Nequi' }),
        ]);
        const texto = (primero.ultima.respuestas || []).map((r) => r.texto || r).join('\n');
        expect(texto).toContain('Quito López III');
        expect(primero.tarea.nombre).not.toBe(confirmacion.TAREA);
    });

    test.each(TELEFONOS)('sin número visible, el teléfono «%s» del formulario va al pedido', async (escrito, esperado) => {
        const { tarea } = await conversar(montar({ telefonoVerificado: null }), [
            '#P12-4x1',
            formulario({ entrega: 'domicilio', barrio: 'Betania', direccion: 'Mz 4 casa 12', telefono: escrito, pago: 'Efectivo' }),
        ]);
        expect(tarea.datos.args.cliente_telefono).toBe(esperado);
    });
});

describe('4. los teléfonos como los escriben', () => {
    test.each(TELEFONOS)('«%s» → %s', (texto, esperado) => {
        expect(leerTelefono(texto)).toBe(esperado);
    });
});

describe('5. la forma de pago: no se supone, y no se borra lo de la cocina', () => {
    const ajustar = (nota, hilo) => registry.obtener('tomar_pedido').confirmacion.ajustar({ args: { nota }, hilo }).nota;
    const PEDIDO_ANTERIOR = [
        { rol: 'cliente', texto: 'Una criollita, pago en efectivo' },
        { rol: 'asistente', texto: '¡Listo! Tu pedido quedó tomado. El número es ORD-0085' },
        { rol: 'cliente', texto: 'Hola, otra criollita a domicilio' },
        { rol: 'cliente', texto: 'Cra 20 #10-30 atahualpa 3001234567' },
    ];

    test.each(DICE_EL_PAGO)('si en este pedido dijo «%s», el pago de la nota se respeta', (dicho) => {
        expect(ajustar('Pago en efectivo', [...PEDIDO_ANTERIOR, { rol: 'cliente', texto: dicho }])).toBe('Pago en efectivo');
    });

    test.each([
        ['Pago en efectivo', undefined],
        ['Pago: Nequi', undefined],
        ['El cliente paga en efectivo', undefined],
        ['Paga al domiciliario en efectivo', undefined],
        ['Pago contra entrega en efectivo', undefined],
        ['Pagará con tarjeta', undefined],
        ['Cancela por Nequi', undefined],
        ['Pago con llave', undefined],
        ['Nequi', undefined],
        ['Pago en efectivo, sin cebolla', 'sin cebolla'],
        ['Sin cebolla. Pago en efectivo', 'Sin cebolla.'],
        ['Pago: Efectivo. Barrio: Betania', 'Barrio: Betania'],
        ['Pagará con tarjeta. Casa esquinera', 'Casa esquinera'],
        ['Sin ají, pago con Nequi y salsa aparte', 'Sin ají, y salsa aparte'],
        ['Timbre dañado', 'Timbre dañado'],
        ['Lleva cambio de 50 mil', 'Lleva cambio de 50 mil'],
    ])('si no lo dijo en este pedido: «%s» → %p', (nota, queda) => {
        expect(ajustar(nota, PEDIDO_ANTERIOR)).toBe(queda);
    });
});
