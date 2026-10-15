/**
 * Adiciones que el cliente le pone a un plato en la carta (`-a31.31.40` por línea), 2026-10-15.
 *
 * Contrato: `carrito.service.ts` escribe, `codigoPedido.js` lee. Aquí, sin base de datos:
 *   1. el LECTOR: códigos viejos idénticos; un id repetido es una más por plato; líneas con
 *      adiciones distintas NO se suman; basura se ignora; convive con `-r` y los modificadores;
 *   2. el FLUJO: las adiciones llegan a `tomar_pedido` como `con: "31.31.40"`.
 * Quién las valida y les pone precio es `crearOrden` (ver `__tests__/restaurante/adiciones.test.js`).
 */
'use strict';

const codigoPedido = require('../../intelligence/adapters/restaurante/codigoPedido');
const adiciones = require('../../intelligence/adapters/restaurante/adiciones');
const flujo = require('../../intelligence/adapters/restaurante/flujo');

describe('codigoPedido.leer con adiciones', () => {
    it('un código sin -a devuelve exactamente lo de siempre', () => {
        const r = codigoPedido.leer('#P12-4x2-r12,9x1');
        expect(r.items).toEqual([
            { id_producto: 4, cantidad: 2, exclusiones: [12] },
            { id_producto: 9, cantidad: 1 },
        ]);
        expect(Object.keys(r.items[1])).toEqual(['id_producto', 'cantidad']);
    });

    it('lee las adiciones de una línea; un id repetido es una más por plato', () => {
        expect(codigoPedido.leer('#P12-4x2-a31.40.31,9x1').items).toEqual([
            {
                id_producto: 4,
                cantidad: 2,
                adiciones: [
                    { id_producto: 31, cantidad: 2 },
                    { id_producto: 40, cantidad: 1 },
                ],
            },
            { id_producto: 9, cantidad: 1 },
        ]);
    });

    it('convive con lo que se quita y con los modificadores', () => {
        expect(codigoPedido.leer('#P12-4x1-r12.15-a31~m=D~z=7')).toMatchObject({
            items: [{ id_producto: 4, cantidad: 1, exclusiones: [12, 15], adiciones: [{ id_producto: 31, cantidad: 1 }] }],
            modalidad: 'DOMICILIO',
            idBarrio: 7,
        });
    });

    it('«una con queso» y «una con todo» son dos líneas; dos iguales se suman', () => {
        expect(codigoPedido.leer('#P12-4x1-a31,4x1').items).toEqual([
            { id_producto: 4, cantidad: 1, adiciones: [{ id_producto: 31, cantidad: 1 }] },
            { id_producto: 4, cantidad: 1 },
        ]);
        expect(codigoPedido.leer('#P12-4x1-a31.40,4x2-a40.31').items).toEqual([
            {
                id_producto: 4,
                cantidad: 3,
                adiciones: [
                    { id_producto: 31, cantidad: 1 },
                    { id_producto: 40, cantidad: 1 },
                ],
            },
        ]);
    });

    it('basura en -a se ignora: el pedido NO se rechaza', () => {
        expect(codigoPedido.leer('#P12-4x1-a,9x1-a0.7').items).toEqual([
            { id_producto: 4, cantidad: 1 },
            { id_producto: 9, cantidad: 1, adiciones: [{ id_producto: 7, cantidad: 1 }] },
        ]);
    });
});

describe('adiciones.leerCon / escribirCon / enTexto', () => {
    it('ida y vuelta, ordenado', () => {
        expect(adiciones.escribirCon([{ id_producto: 40 }, { id_producto: 31, cantidad: 2 }])).toBe('31.31.40');
        expect(adiciones.leerCon('31.31.40')).toEqual([
            { id_producto: 31, cantidad: 2 },
            { id_producto: 40, cantidad: 1 },
        ]);
        expect(adiciones.leerCon(undefined)).toEqual([]);
    });

    it('tope de ids por línea', () => {
        const muchos = Array.from({ length: 50 }, () => '7').join('.');
        expect(adiciones.leerCon(muchos)).toEqual([{ id_producto: 7, cantidad: adiciones.MAX_POR_LINEA }]);
    });

    it('texto para la confirmación', () => {
        expect(adiciones.enTexto([{ nombre: 'Queso', cantidad: 2 }, { nombre: 'Tocineta', cantidad: 1 }])).toBe(
            '+ 2 Queso, + Tocineta'
        );
    });
});

describe('el flujo pasa las adiciones a tomar_pedido', () => {
    const catalogo = {
        barrios: async () => ({ habilitado: false, barrios: [] }),
        mesas: async () => [],
        resolverBarrio: async () => { throw new Error('no se usa'); },
        resolverMesa: async () => { throw new Error('no se usa'); },
        resolverExclusiones: async ({ lineas }) =>
            lineas.map((l) => ({ validas: l.ids.map((id) => ({ id_ingrediente: id, nombre: 'x' })), descartadas: [] })),
    };
    const manejar = flujo.crearFlujoRestaurante({
        contextoNegocio: {
            obtener: async () => ({ id: 12, nombre: 'P', tratamiento: 'P', atencion: null, tipoNegocio: 'RESTAURANTE' }),
        },
        identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
        gate: {},
        catalogo,
    });
    const decir = (texto) =>
        manejar({
            conversacion: {
                id_conversacion: 'c', id_negocio: 12, canal: 'whatsapp', id_externo: '573000000000',
                variables: { turnos: 1, nombre: 'Ana' }, tarea_actual: null, tarea_datos: null,
            },
            mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' },
        });

    it('con adiciones: `con`, junto a `sin` si también quitó algo', async () => {
        const d = await decir('Hola, quiero pedir:\n\n#P12-4x2-r12-a31.31.40,9x1~m=R');
        expect(d.tarea.datos.args.items).toEqual([
            { id_producto: 4, cantidad: 2, sin: '12', con: '31.31.40' },
            { id_producto: 9, cantidad: 1 },
        ]);
    });
});
