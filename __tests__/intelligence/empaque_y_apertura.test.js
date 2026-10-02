/**
 * Dos piezas del asistente de restaurante, pedidas el 2026-10-02 (Zona Burger):
 *
 *  1. Fuera de horario, el bot dice A QUÉ HORA abre (hoy, mañana o el día que sea) en vez de
 *     «te atendemos apenas sea posible».
 *  2. El empaque de los pedidos para llevar y a domicilio lo calcula el servidor, por producto.
 *
 * Correr con:  npx jest __tests__/intelligence/empaque_y_apertura.test.js
 */
const Models = require('../../app_core/models/conection');
const empaqueService = require('../../app_restaurante_api/services/empaqueService');
const { fraseDeApertura, crearFlujoRestaurante } = require('../../intelligence/adapters/restaurante/flujo');

describe('fraseDeApertura', () => {
    test('hoy', () => {
        expect(fraseDeApertura({ dias_adelante: 0, dia_semana: 3, hora: '17:00' })).toBe(
            'Hoy abrimos a las 5:00 PM.'
        );
    });

    test('mañana', () => {
        expect(fraseDeApertura({ dias_adelante: 1, dia_semana: 4, hora: '11:30' })).toBe(
            'Abrimos mañana a las 11:30 AM.'
        );
    });

    test('otro día: lo nombra', () => {
        expect(fraseDeApertura({ dias_adelante: 3, dia_semana: 6, hora: '12:00' })).toBe(
            'Abrimos el sábado a las 12:00 PM.'
        );
    });

    test('el mismo día de la semana que viene', () => {
        expect(fraseDeApertura({ dias_adelante: 7, dia_semana: 2, hora: '18:00' })).toBe(
            'Abrimos el próximo martes a las 6:00 PM.'
        );
    });

    test('medianoche y mediodía', () => {
        expect(fraseDeApertura({ dias_adelante: 1, dia_semana: 1, hora: '00:00' })).toContain('12:00 AM');
        expect(fraseDeApertura({ dias_adelante: 1, dia_semana: 1, hora: '12:00' })).toContain('12:00 PM');
    });

    test('sin dato no inventa una hora', () => {
        expect(fraseDeApertura(null)).toBeNull();
        expect(fraseDeApertura({})).toBeNull();
    });
});

describe('el saludo fuera de horario', () => {
    const crear = (proximaApertura) =>
        crearFlujoRestaurante({
            contextoNegocio: { obtener: async () => ({ id: 12, tratamiento: 'Pregonchos' }) },
            identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
            gate: {},
            catalogo: { barrios: async () => ({ habilitado: false, barrios: [] }), mesas: async () => [] },
            estadoAtencion: async () => ({ estado: 'fuera_de_horario' }),
            proximaApertura,
            ahora: () => new Date('2026-09-24T15:00:00-05:00'),
        });
    const decir = (flujo) =>
        flujo({
            mensaje: { texto: 'hola', tipo: 'texto' },
            conversacion: { id_negocio: 12, variables: {} },
            identidad: {},
        });
    const texto = (d) => d.respuestas.map((r) => r.texto).join('\n');

    test('dice a qué hora abre', async () => {
        const d = await decir(crear(async () => ({ dias_adelante: 0, dia_semana: 4, hora: '17:00' })));
        expect(texto(d)).toMatch(/fuera de nuestro horario/);
        expect(texto(d)).toContain('Hoy abrimos a las 5:00 PM.');
        expect(texto(d)).not.toMatch(/apenas sea posible/);
    });

    test('si abre otro día, lo dice', async () => {
        const d = await decir(crear(async () => ({ dias_adelante: 1, dia_semana: 5, hora: '17:00' })));
        expect(texto(d)).toContain('Abrimos mañana a las 5:00 PM.');
    });

    test('sin horario conocido o con la consulta caída, cae a la frase de siempre', async () => {
        for (const proxima of [async () => null, async () => { throw new Error('bd caída'); }]) {
            const d = await decir(crear(proxima));
            expect(texto(d)).toMatch(/apenas sea posible/);
        }
    });
});

describe('empaqueService.calcular', () => {
    const consulta = jest.spyOn(Models.sequelize, 'query');
    afterAll(() => consulta.mockRestore());

    const LIGADOS = [
        { id_producto: 1, id_producto_empaque: 56, cantidad_empaque: 1 }, // hamburguesa → pequeño
        { id_producto: 2, id_producto_empaque: 57, cantidad_empaque: 1 }, // salchipapa → mediano
        { id_producto: 3, id_producto_empaque: 57, cantidad_empaque: 3 }, // promo → 3 medianos
    ];
    const EMPAQUES = [
        { id_producto: 56, nombre: 'pequeño', precio: '500.00' },
        { id_producto: 57, nombre: 'mediano', precio: '1000.00' },
    ];

    beforeEach(() => {
        consulta.mockReset();
        consulta.mockResolvedValueOnce(LIGADOS).mockResolvedValueOnce(EMPAQUES);
    });

    test('mesa y otros tipos: no cobra empaque ni consulta nada', async () => {
        const r = await empaqueService.calcular({
            idNegocio: 6,
            tipoPedido: 'MESA',
            items: [{ id_producto: 1, cantidad: 2 }],
        });
        expect(r).toEqual([]);
        expect(consulta).not.toHaveBeenCalled();
    });

    test('un empaque por unidad, sumando los del mismo tipo', async () => {
        const r = await empaqueService.calcular({
            idNegocio: 6,
            tipoPedido: 'DOMICILIO',
            items: [
                { id_producto: 1, cantidad: 2 }, // 2 pequeños
                { id_producto: 2, cantidad: 1 }, // 1 mediano
                { id_producto: 3, cantidad: 1 }, // 3 medianos
            ],
        });
        expect(r).toEqual([
            { id_producto: 56, nombre: 'pequeño', cantidad: 2, precio_unitario: 500 },
            { id_producto: 57, nombre: 'mediano', cantidad: 4, precio_unitario: 1000 },
        ]);
    });

    test('un producto sin empaque ligado no suma nada', async () => {
        consulta.mockReset();
        consulta.mockResolvedValueOnce([]);
        const r = await empaqueService.calcular({
            idNegocio: 6,
            tipoPedido: 'LLEVAR',
            items: [{ id_producto: 99, cantidad: 1 }],
        });
        expect(r).toEqual([]);
        expect(consulta).toHaveBeenCalledTimes(1);
    });

    test('la cantidad por defecto es 1 y el filtro es por negocio', async () => {
        const r = await empaqueService.calcular({
            idNegocio: 6,
            tipoPedido: 'LLEVAR',
            items: [{ id_producto: 1 }],
        });
        expect(r[0].cantidad).toBe(1);
        for (const [, opciones] of consulta.mock.calls) {
            expect(opciones.replacements.idNegocio).toBe(6);
        }
    });
});
