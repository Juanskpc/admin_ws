/**
 * «Cancelar» es pagar, y cómo se paga depende del pedido (2026-10-03).
 *
 * Correr con:  npx jest __tests__/intelligence/cancelar_y_pago.test.js
 */
const pago = require('../../intelligence/adapters/restaurante/pago');
const { crearFlujoRestaurante } = require('../../intelligence/adapters/restaurante/flujo');

describe('esCancelarAmbiguo', () => {
    test.each([
        'Cancelar',
        'cancelo',
        'quiero cancelar',
        'Cuánto le cancelo?',
        'cancelo por nequi',
        'cancelo al domiciliario',
        'Cancelar en efectivo',
        'ya cancelé',
    ])('%p pregunta', (t) => expect(pago.esCancelarAmbiguo(t)).toBe(true));

    test.each([
        'anular el pedido',
        'cancela y anúlalo por favor',
        'quiero una salchipapa',
        'si se demora mucho cancelo pero quiero dos salchipapas criollas pequeñas por favor gracias',
    ])('%p no', (t) => expect(pago.esCancelarAmbiguo(t)).toBe(false));
});

describe('preguntas de pago', () => {
    test.each([
        'Cómo pago?',
        'cuales son las formas de pago',
        'Me das el Nequi por favor',
        'me regalas nequi porfa',
        'a que numero transfiero',
        'aceptan nequi',
    ])('%p es una pregunta de pago', (t) => expect(pago.esPreguntaDePago(t)).toBe(true));

    test('una palabra suelta solo cuenta con un pedido hecho', () => {
        expect(pago.esPreguntaDePago('Nequi')).toBe(false);
        expect(pago.esPreguntaDePago('Nequi', { hayPedido: true })).toBe(true);
        expect(pago.esPreguntaDePago('por transferencia', { hayPedido: true })).toBe(true);
    });

    test('«pago por nequi» dentro de un pedido no es la pregunta', () => {
        expect(pago.esPreguntaDePago('Quiero una salchipapa pago por nequi', { hayPedido: true })).toBe(false);
    });
});

describe('frasePago por tipo de pedido', () => {
    const t = { domicilio: 'DOM', local: 'LOCAL' };
    test('cada tipo recibe SU texto', () => {
        expect(pago.frasePago('DOMICILIO', t)).toBe('DOM');
        expect(pago.frasePago('LLEVAR', t)).toBe('LOCAL');
        expect(pago.frasePago('MESA', t)).toBe('LOCAL');
    });
    test('sin saber el tipo van los dos, rotulados', () => {
        const f = pago.frasePago(null, t);
        expect(f).toContain('DOM');
        expect(f).toContain('LOCAL');
    });
    test('sin texto configurado no se inventa nada', () => {
        expect(pago.frasePago('DOMICILIO', { domicilio: null, local: 'LOCAL' })).toBeNull();
        expect(pago.frasePago(null, { domicilio: null, local: null })).toBeNull();
    });
});

describe('el flujo', () => {
    const flujo = crearFlujoRestaurante({
        tienePedidoReciente: async () => true,
        contextoNegocio: {
            obtener: async () => ({ id: 6, nombre: 'ZONA BURGER', tratamiento: 'ZONA BURGER', atencion: null, tipoNegocio: 'RESTAURANTE' }),
        },
        identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
        gate: {},
        ahora: () => new Date('2026-10-03T20:00:00-05:00'),
        catalogo: {
            barrios: async () => ({ habilitado: false, barrios: [] }),
            mesas: async () => [],
            resolverBarrio: async () => null,
            resolverMesa: async () => null,
            resolverExclusiones: async () => ({ validas: [], descartadas: [] }),
        },
    });
    const conv = { id_conversacion: 'c1', id_negocio: 6, canal: 'whatsapp', id_externo: '573000000000', variables: { turnos: 3 }, tarea_actual: null, tarea_datos: {} };
    const turno = (texto) => flujo({ conversacion: conv, mensajes: [], turno: { id_turno: 1 }, texto });
    let vivo, textos;
    beforeEach(() => {
        vivo = jest.spyOn(pago, 'ultimoPedidoVivo').mockResolvedValue({ numero_orden: 'ORD-1', tipo_pedido: 'DOMICILIO' });
        textos = jest.spyOn(pago, 'textosDePago').mockResolvedValue({ domicilio: 'PAGO AL DOMICILIARIO', local: 'PAGO AL LOCAL' });
    });
    afterEach(() => jest.restoreAllMocks());

    test('«Cancelar» pregunta con dos botones y no anula', async () => {
        const d = await turno('Cancelar');
        const r = d.respuestas[0];
        expect(r.texto).toBe('¿Deseas anular el pedido o pagar?');
        expect(r.opciones.map((o) => o.id)).toEqual(['anular_pedido', 'pagar_pedido']);
        expect(d.pasos[0].decision).toBe('cancelar_ambiguo');
    });

    test('«Pagar» en un domicilio da el texto del domicilio', async () => {
        const d = await turno('pagar_pedido');
        expect(d.respuestas).toEqual(['PAGO AL DOMICILIARIO']);
    });

    test('«Pagar» en un pedido para llevar da el texto del local', async () => {
        vivo.mockResolvedValue({ numero_orden: 'ORD-2', tipo_pedido: 'LLEVAR' });
        const d = await turno('pagar_pedido');
        expect(d.respuestas).toEqual(['PAGO AL LOCAL']);
    });

    test('«¿me das el Nequi?» en una mesa da el texto del local', async () => {
        vivo.mockResolvedValue({ numero_orden: 'ORD-3', tipo_pedido: 'MESA' });
        const d = await turno('Me das el Nequi por favor');
        expect(d.respuestas).toEqual(['PAGO AL LOCAL']);
    });

    test('«Anular el pedido» pide la confirmación del pedido vivo (nunca anula directo)', async () => {
        const d = await turno('anular_pedido');
        expect(d.pasos.map((p) => p.decision)).toContain('confirmacion_solicitada');
        expect(d.tarea.datos.capacidad).toBe('cancelar_pedido');
        expect(d.tarea.datos.args).toEqual({ numero_orden: 'ORD-1' });
    });

    test('anular sin pedido vivo lo dice', async () => {
        vivo.mockResolvedValue(null);
        const d = await turno('anular_pedido');
        expect(d.respuestas[0]).toMatch(/No encuentro un pedido/);
    });

    test('sin texto de pago configurado, «pagar» no inventa nada y cede el turno', async () => {
        textos.mockResolvedValue({ domicilio: null, local: null });
        const d = await turno('pagar_pedido');
        expect(d.respuestas || []).not.toContain('PAGO AL LOCAL');
    });
});
