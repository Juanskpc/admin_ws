/**
 * Auditoría de Zona Burger del 2026-10-04 (ver docs/auditoria-2026-10-04-zona-burger.md).
 *
 * Correr con:  npx jest __tests__/intelligence/auditoria_2026_10_04.test.js
 */
'use strict';

const pago = require('../../intelligence/adapters/restaurante/pago');
const { crearFlujoRestaurante, TAREA_PEDIDO, PASO_PEDIDO } = require('../../intelligence/adapters/restaurante/flujo');

// La plantilla que el personal manda y el cliente devuelve llena (tal cual llegó hoy).
const PLANTILLA_LLENA = [
    '📝 Pedido: salchipapa grande la viciosa',
    '📍 Dirección: carrera 17 bis número 23-40 centenario',
    '👤 Nombre: Erika Arteaga',
    '📞 Teléfono: 3126989583',
    '💳 Medio de pago: efectivo',
].join('\n');

describe('un pedido con su forma de pago NO es una pregunta de pago', () => {
    test('la plantilla llena del personal', () => {
        expect(pago.esPreguntaDePago(PLANTILLA_LLENA, { hayPedido: true })).toBe(false);
        expect(pago.pareceDatosDePedido(PLANTILLA_LLENA)).toBe(true);
    });

    test('un pedido que termina pidiendo el medio de pago', () => {
        const t =
            'Para un domicilio 1 hamburguesa dulce pecado y 1 hamburguesa dulcinea. Al mirador de aquine torre 4 bloque B apto 1108.\n' +
            'Me envía el medio de pago para consignar.';
        expect(pago.esPreguntaDePago(t, { hayPedido: true })).toBe(false);
    });

    test('«medio de pago nequi» lo dice, no lo pregunta', () => {
        expect(pago.esPreguntaDePago('Medio de pago nequi', { hayPedido: true })).toBe(false);
        expect(pago.esPreguntaDePago('medio de pago: efectivo', { hayPedido: true })).toBe(false);
    });

    test('las preguntas de verdad siguen contestándose', () => {
        expect(pago.esPreguntaDePago('Cómo pago?')).toBe(true);
        expect(pago.esPreguntaDePago('cuales son los medios de pago')).toBe(true);
        expect(pago.esPreguntaDePago('Me das el Nequi por favor')).toBe(true);
    });

    test('«cancelar» dentro de la plantilla no pregunta anular o pagar', () => {
        expect(pago.esCancelarAmbiguo(`${PLANTILLA_LLENA}\ncancelo en efectivo`)).toBe(false);
        expect(pago.esCancelarAmbiguo('cancelo en efectivo')).toBe(true);
    });
});

describe('el flujo', () => {
    const catalogo = {
        barrios: async () => ({ habilitado: false, barrios: [] }),
        mesas: async () => [],
        resolverBarrio: async () => null,
        resolverMesa: async () => null,
        resolverExclusiones: async () => ({ validas: [], descartadas: [] }),
    };
    const AHORA = new Date('2026-10-04T18:20:00-05:00');
    const crear = ({ pedidoReciente = false, telefonoProbado = '573000000000', yaContestado = false } = {}) =>
        crearFlujoRestaurante({
            tienePedidoReciente: async () => pedidoReciente,
            yaSeLeContestoSuPedido: async () => yaContestado,
            contextoNegocio: {
                obtener: async () => ({
                    id: 6, nombre: 'ZONA BURGER', tratamiento: 'ZONA BURGER', atencion: null,
                    tipoNegocio: 'RESTAURANTE', tiempoEstimado: { min: 40, max: 60 },
                }),
            },
            identidad: { resolver: async () => ({ principal: { telefono_verificado: telefonoProbado } }) },
            gate: {},
            ahora: () => AHORA,
            estadoAtencion: async () => ({ estado: 'ABIERTO' }),
            proximaApertura: async () => null,
            leerCarta: async () => ({ enlace: 'https://escalapp.cloud/restaurante/carta/6', productos: [] }),
            catalogo,
        });
    const conv = (extra = {}) => ({
        id_conversacion: 'c1', id_negocio: 6, canal: 'whatsapp', id_externo: '573000000000',
        variables: { turnos: 3 }, tarea_actual: null, tarea_datos: {}, humano_ultimo_en: null, ...extra,
    });
    const decir = (manejar, c, texto) =>
        manejar({ conversacion: c, mensajes: [{ contenido: texto }], turno: { id_turno: 1 }, texto });

    beforeEach(() => {
        jest.spyOn(pago, 'ultimoPedidoVivo').mockResolvedValue(null);
        jest.spyOn(pago, 'textosDePago').mockResolvedValue({ domicilio: 'DOM', local: 'LOCAL' });
    });
    afterEach(() => jest.restoreAllMocks());

    test('la plantilla llena no recibe el texto de pago', async () => {
        const d = await decir(crear(), conv(), PLANTILLA_LLENA);
        expect(d.pasos.map((p) => p.decision)).not.toContain('pago_respondido');
    });

    describe('pregunta por su pedido y lo atendió una persona', () => {
        const haceUnRato = new Date(AHORA.getTime() - 30 * 60 * 1000);

        test.each(['Ya hice el pedido', 'Se demora aún el domicilio ?', 'Ya salió mi pedido', 'Cuanto se demora el domicilio veci'])(
            '%p vuelve a la persona, sin decir que no hay pedido',
            async (texto) => {
                const d = await decir(crear(), conv({ humano_ultimo_en: haceUnRato }), texto);
                expect(d.pasos[0].decision).toBe('pedido_de_persona_a_persona');
                expect(d.estado).toBe('handoff_humano');
                expect(d.respuestas.join(' ')).not.toMatch(/ningún pedido/);
            }
        );

        test('si el pedido lo tomó el asistente, el tiempo se contesta como siempre', async () => {
            const d = await decir(crear({ pedidoReciente: true }), conv({ humano_ultimo_en: haceUnRato }), 'Cuánto se demora');
            expect(d.pasos[0].decision).toBe('tiempo_estimado_respondido');
        });

        test('sin persona reciente, «ya salió mi pedido» lo atiende el modelo', async () => {
            const hace8h = new Date(AHORA.getTime() - 8 * 3600 * 1000);
            const d = await decir(crear(), conv({ humano_ultimo_en: hace8h }), 'Ya salió mi pedido');
            expect(d.pasos[0].decision).toBe('cedido_al_modelo');
        });
    });

    test('el teléfono con una frase detrás: solo el número, el resto a la nota', async () => {
        const c = conv({
            tarea_actual: TAREA_PEDIDO,
            tarea_datos: {
                items: [{ id_producto: 4, cantidad: 1 }], nombre: 'Loren', entrega: 'DOMICILIO',
                direccion: 'Calle 24 # 16-92 centenario', paso: PASO_PEDIDO.TELEFONO,
            },
        });
        const d = await decir(crear({ telefonoProbado: null }), c, '3169932352 , porfa es que pago es con tarjeta');
        const args = d.tarea.datos.args;
        expect(args.cliente_telefono).toBe('3169932352');
        expect(args.nota).toMatch(/tarjeta/);
    });

    test('«buenas noches» con espacio duro se devuelve igual a las 6 PM', async () => {
        const d = await decir(crear(), conv({ variables: {} }), 'Buenas noches');
        expect(d.respuestas[0].texto).toMatch(/Buenas noches/);
    });

    describe('estado del pedido: la primera vez se contesta, la segunda va a una persona', () => {
        test('primera vez: el tiempo, como siempre', async () => {
            const d = await decir(crear({ pedidoReciente: true }), conv(), 'Cuánto se demora');
            expect(d.pasos[0].decision).toBe('tiempo_estimado_respondido');
        });
        test.each(['Cuánto se demora', 'Pues ya son los 60 minutos que me dijeron se demora aún más?', 'Ya salió mi pedido'])(
            'repreguntado %p → persona, sin contar minutos',
            async (texto) => {
                const d = await decir(crear({ pedidoReciente: true, yaContestado: true }), conv(), texto);
                expect(d.pasos[0].decision).toBe('pedido_repreguntado_a_persona');
                expect(d.estado).toBe('handoff_humano');
                expect(d.respuestas[0]).toMatch(/Ya le dejé tu mensaje/);
                expect(d.respuestas[0]).not.toMatch(/minutos/);
            }
        );
    });

    test.each(['Cuantas cajas vienen', 'en cuántas cajas viene?', 'No venia una caja y media'])(
        '%p: no se adivina, va a una persona',
        async (texto) => {
            const d = await decir(crear({ pedidoReciente: true }), conv(), texto);
            expect(d.pasos[0].decision).toBe('empaque_a_persona');
            expect(d.respuestas[0]).toMatch(/No tengo ese dato con exactitud/);
            expect(d.estado).toBe('handoff_humano');
        }
    );

    describe('con un pedido esperando el sí', () => {
        const pendiente = (tipo) =>
            conv({
                tarea_actual: 'confirmar_mutacion',
                tarea_datos: {
                    capacidad: 'tomar_pedido',
                    args: { items: [{ id_producto: 4, cantidad: 1 }], tipo_entrega: tipo, cliente_nombre: 'Ana' },
                    preguntado_en: AHORA.toISOString(),
                },
            });
        test.each([
            ['¿Lo tienes en combo?', 'DOMICILIO'],
            ['El domicilio siempre me cobran 6 mil', 'DOMICILIO'],
            ['Si. Cambios', 'DOMICILIO'],
            ['No necesito empaque allá voy a consumir', 'LLEVAR'],
            ['que salsas trae', 'LLEVAR'],
        ])('%p lo contesta el modelo y el pedido sigue esperando', async (texto, tipo) => {
            const d = await decir(crear(), pendiente(tipo), texto);
            expect(d.pasos[0].decision).toBe('confirmacion_pregunta_al_modelo');
            expect(d.respuestas).toEqual([]);
            expect('tarea' in d).toBe(false); // el motor conserva la confirmación
        });
    });
});

describe('lo que no se anota como nota de cocina', () => {
    const confirmacion = require('../../intelligence/engine/confirmacion');
    test.each(['Voy para allá', 'Para Servir', 'Para recogerla', 'ya voy', 'Estoy llegando'])('%p no se anota', (t) => {
        expect(confirmacion.lineasParaAnotar(t, { afirma: false })).toEqual([]);
    });
    test('una nota de verdad sí', () => {
        expect(confirmacion.lineasParaAnotar('sin cebolla por favor', { afirma: false })).toEqual(['sin cebolla por favor']);
    });
});

describe('buscar_producto se queda con lo que se nombró (2026-10-04)', () => {
    const { afinarResultado } = require('../../intelligence/adapters/restaurante/index');
    const p = (id, nombre, categoria, descripcion = '') => ({ id_producto: id, nombre, categoria, descripcion });
    const SALCHIPAPAS = [
        p(1, 'choripapa', 'SALCHIPAPAS', 'Papa a la francesa, chorizo'),
        p(2, 'viciosa', 'SALCHIPAPAS', 'Tamaño pequeño. Papas a la francesa'),
        p(3, 'viciosa mediana', 'SALCHIPAPAS', 'Papas a la francesa'),
        p(4, 'familiar', 'SALCHIPAPAS', 'Sabor La Criollita, The House o La Viciosa'),
    ];
    const nombres = (r) => r.map((x) => x.nombre);

    test('un nombre exacto trae solo ese producto, no todo lo que dice «papa»', () => {
        expect(nombres(afinarResultado(SALCHIPAPAS, 'choripapa'))).toEqual(['choripapa']);
    });
    test('el nombre con sus tamaños, sin lo que solo lo menciona en la descripción', () => {
        expect(nombres(afinarResultado(SALCHIPAPAS, 'viciosa'))).toEqual(['viciosa', 'viciosa mediana']);
    });
    test('el nombre de la categoría trae la categoría entera', () => {
        expect(afinarResultado(SALCHIPAPAS, 'salchipapas')).toHaveLength(4);
    });
    test('categoría + lo que lo lleva en el nombre («hamburguesa» → las 4 y la carne de hamburguesa)', () => {
        const r = afinarResultado(
            [p(10, 'Discordia', 'HAMBURGUESAS'), p(11, 'Dulcinea', 'HAMBURGUESAS'), p(12, 'Carne de hamburguesa', 'ADICIONALES'), p(13, 'perro loco', 'HOT DOG', 'queso, carne de hamburguesa')],
            'hamburguesa'
        );
        expect(nombres(r)).toEqual(['Discordia', 'Dulcinea', 'Carne de hamburguesa']);
    });
    test('si nada lo lleva en el nombre, se queda todo (la descripción es la única pista)', () => {
        expect(afinarResultado(SALCHIPAPAS, 'francesa')).toHaveLength(4);
    });
    test('«pequeña» no cuenta como palabra del nombre', () => {
        expect(nombres(afinarResultado(SALCHIPAPAS, 'viciosa pequeña'))).toEqual(['viciosa', 'viciosa mediana']);
    });
});
