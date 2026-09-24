/**
 * Ingredientes que el cliente quita en la carta (`-r12.15` por línea del código), 2026-09-24.
 *
 * Contrato: `carrito.service.ts` escribe, `codigoPedido.js` lee. Aquí, sin base de datos:
 *   1. el LECTOR: códigos viejos idénticos; líneas con exclusiones distintas NO se suman; basura
 *      se ignora sin rechazar el pedido;
 *   2. el FLUJO: al leer el código se relee lo que se puede quitar y la confirmación recibe solo
 *      lo válido (`sin: "12.15"`) más los nombres de lo descartado (`sin_descartadas`).
 */
'use strict';

const codigoPedido = require('../../intelligence/adapters/restaurante/codigoPedido');
const exclusiones = require('../../intelligence/adapters/restaurante/exclusiones');
const flujo = require('../../intelligence/adapters/restaurante/flujo');

describe('codigoPedido.leer con ingredientes quitados', () => {
    it('un código SIN -r devuelve exactamente lo de siempre', () => {
        const r = codigoPedido.leer('#P12-4x2,9x1');
        expect(r).toEqual({
            idNegocio: 12,
            items: [
                { id_producto: 4, cantidad: 2 },
                { id_producto: 9, cantidad: 1 },
            ],
        });
        expect(Object.keys(r.items[0])).toEqual(['id_producto', 'cantidad']);
    });

    it('lee los ids quitados de UNA línea, ordenados y sin repetidos', () => {
        const r = codigoPedido.leer('#P12-4x1-r15.12.12,9x2');
        expect(r.items).toEqual([
            { id_producto: 4, cantidad: 1, exclusiones: [12, 15] },
            { id_producto: 9, cantidad: 2 },
        ]);
    });

    it('dos líneas del mismo producto con distintas exclusiones son líneas DISTINTAS', () => {
        const r = codigoPedido.leer('#P12-4x1-r12,4x1');
        expect(r.items).toEqual([
            { id_producto: 4, cantidad: 1, exclusiones: [12] },
            { id_producto: 4, cantidad: 1 },
        ]);
    });

    it('se suman solo las líneas que coinciden en producto Y exclusiones', () => {
        expect(codigoPedido.leer('#P12-4x2-r12.15,4x1-r15.12').items).toEqual([
            { id_producto: 4, cantidad: 3, exclusiones: [12, 15] },
        ]);
        // Sin exclusiones, como siempre: `4x2,4x1` → 3.
        expect(codigoPedido.leer('#P12-4x2,4x1').items).toEqual([{ id_producto: 4, cantidad: 3 }]);
    });

    it('basura en -r se ignora: el pedido NO se rechaza', () => {
        expect(codigoPedido.leer('#P12-4x1-rzz,9x1-r,5x1-r12zz.7').items).toEqual([
            { id_producto: 4, cantidad: 1 },
            { id_producto: 9, cantidad: 1 },
            { id_producto: 5, cantidad: 1, exclusiones: [7] },
        ]);
    });

    it('tope de exclusiones por línea', () => {
        const muchas = Array.from({ length: 30 }, (_, i) => i + 1).join('.');
        expect(codigoPedido.leer(`#P12-4x1-r${muchas}`).items[0].exclusiones).toHaveLength(
            codigoPedido.MAX_EXCLUSIONES
        );
    });

    it('convive con los modificadores de modalidad', () => {
        expect(codigoPedido.leer('#P12-4x1-r12~m=D~z=7')).toMatchObject({
            items: [{ id_producto: 4, cantidad: 1, exclusiones: [12] }],
            modalidad: 'DOMICILIO',
            idBarrio: 7,
        });
    });
});

describe('exclusiones.leerSin / escribirSin', () => {
    it('ida y vuelta, ordenado', () => {
        expect(exclusiones.leerSin('15.12')).toEqual([15, 12]);
        expect(exclusiones.escribirSin([15, 12, 12])).toBe('12.15');
        expect(exclusiones.leerSin('')).toEqual([]);
        expect(exclusiones.leerSin(undefined)).toEqual([]);
        expect(exclusiones.leerSin('a.0.-3.7')).toEqual([7]);
    });
});

describe('el flujo comprueba lo que se quitó antes de pedir el «sí»', () => {
    const catalogo = (respuesta) => ({
        barrios: async () => ({ habilitado: false, barrios: [] }),
        mesas: async () => [],
        resolverBarrio: async () => { throw new Error('no se usa'); },
        resolverMesa: async () => { throw new Error('no se usa'); },
        resolverExclusiones: async ({ lineas }) => lineas.map((l, k) => respuesta(l, k)),
    });

    const crear = (cat) =>
        flujo.crearFlujoRestaurante({
            contextoNegocio: {
                obtener: async () => ({ id: 12, nombre: 'P', tratamiento: 'P', atencion: null, tipoNegocio: 'RESTAURANTE' }),
            },
            identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
            gate: {},
            catalogo: cat,
        });

    const decir = (manejar, texto) =>
        manejar({
            conversacion: {
                id_conversacion: 'c', id_negocio: 12, canal: 'whatsapp', id_externo: '573000000000',
                variables: { turnos: 1, nombre: 'Ana' }, tarea_actual: null, tarea_datos: null,
            },
            mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' },
        });

    it('deja solo las exclusiones válidas en los argumentos y avisa de las descartadas', async () => {
        const manejar = crear(catalogo((l) => ({
            validas: l.ids.filter((id) => id === 12).map((id) => ({ id_ingrediente: id, nombre: 'cebolla' })),
            descartadas: l.ids.filter((id) => id !== 12).map((id) => ({ id_ingrediente: id, nombre: 'tomate' })),
        })));

        const d = await decir(manejar, 'Hola, quiero pedir:\n\n#P12-4x1-r12.15~m=R');
        const args = d.tarea.datos.args;

        expect(args.items).toEqual([{ id_producto: 4, cantidad: 1, sin: '12' }]);
        expect(args.sin_descartadas).toBe('tomate');
    });

    it('sin nada que quitar los argumentos son los de siempre (sin `sin` ni `sin_descartadas`)', async () => {
        const manejar = crear(catalogo(() => ({ validas: [], descartadas: [] })));
        const d = await decir(manejar, '#P12-4x1~m=R');

        expect(d.tarea.datos.args.items).toEqual([{ id_producto: 4, cantidad: 1 }]);
        expect(d.tarea.datos.args.sin_descartadas).toBeUndefined();
    });

    it('si comprobar falla, el pedido sigue con lo que llegó (ejecutar lo vuelve a comprobar)', async () => {
        const cat = catalogo(() => ({ validas: [], descartadas: [] }));
        cat.resolverExclusiones = async () => { throw new Error('caído'); };
        const d = await decir(crear(cat), '#P12-4x1-r12~m=R');

        expect(d.tarea.datos.args.items).toEqual([{ id_producto: 4, cantidad: 1, sin: '12' }]);
    });
});
