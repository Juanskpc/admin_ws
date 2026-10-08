/**
 * `asistente_mira_stock`: que el asistente tenga en cuenta el inventario es una decisión aparte
 * de controlarlo en caja (2026-10-07).
 *
 * Zona Burger apagó `controla_inventario` para que caja no se bloqueara, y con eso el asistente
 * dejó de saber qué estaba agotado: las dos cosas colgaban del mismo interruptor. Ahora valen las
 * cuatro combinaciones, y la carta digital sigue al control de caja como siempre.
 *
 * Lo que puede romperse en silencio: que la decisión del asistente se cuele en la carta digital,
 * o que la de caja siga mandando sobre el asistente.
 *
 * Correr con:  npx jest __tests__/restaurante/asistente_mira_stock.test.js
 */
'use strict';

const Models = require('../../app_core/models/conection');
const cartaService = require('../../app_restaurante_api/services/cartaService');

const SIN_STOCK = {
    id_producto: 1,
    nombre: 'Discordia',
    descripcion: 'Hamburguesa',
    ingredientes: [{ porcion: 100, ingrediente: { stock_actual: 0 } }],
};
const CON_STOCK = {
    id_producto: 2,
    nombre: 'Dulcinea',
    descripcion: 'Hamburguesa',
    ingredientes: [{ porcion: 100, ingrediente: { stock_actual: 5000 } }],
};

afterEach(() => jest.restoreAllMocks());

const negocio = (fila) => jest.spyOn(Models.GenerNegocio, 'findByPk').mockResolvedValue(fila);

describe('asistenteMiraStock: manda la decisión del asistente, no la de caja', () => {
    test.each([
        // controla_inventario, asistente_mira_stock, ¿el asistente mira el stock?
        [true, true, true],
        [true, false, false], // caja controla y el negocio le dijo al asistente que no lo mire
        [false, true, true], // caja no controla y el asistente sí lo mira
        [false, false, false],
    ])('caja controla=%p, asistente_mira_stock=%p → %p', async (controla, mira, esperado) => {
        negocio({ controla_inventario: controla, asistente_mira_stock: mira });
        expect(await cartaService.asistenteMiraStock(6)).toBe(esperado);
    });

    test('una base sin la columna todavía sigue al control de caja, como antes', async () => {
        negocio({ controla_inventario: false });
        expect(await cartaService.asistenteMiraStock(6)).toBe(false);
        negocio({ controla_inventario: true });
        expect(await cartaService.asistenteMiraStock(6)).toBe(true);
    });
});

describe('buscarProductos: quién decide si se filtra por existencias', () => {
    const nombres = (lista) => lista.map((p) => p.nombre).sort();
    beforeEach(() => jest.spyOn(Models.CartaProducto, 'findAll').mockResolvedValue([SIN_STOCK, CON_STOCK]));

    test('el asistente con la opción encendida no ofrece lo que no tiene insumos, aunque caja no controle', async () => {
        negocio({ controla_inventario: false });
        const r = await cartaService.buscarProductos(6, 'hamburguesa', { miraStock: true });
        expect(nombres(r)).toEqual(['Dulcinea']);
    });

    test('el asistente con la opción apagada lo ofrece todo, aunque caja sí controle', async () => {
        negocio({ controla_inventario: true });
        const r = await cartaService.buscarProductos(6, 'hamburguesa', { miraStock: false });
        expect(nombres(r)).toEqual(['Discordia', 'Dulcinea']);
    });

    test('sin esa opción (la carta digital) sigue mandando el control de caja', async () => {
        negocio({ controla_inventario: true, asistente_mira_stock: false });
        expect(nombres(await cartaService.buscarProductos(6, 'hamburguesa'))).toEqual(['Dulcinea']);
        negocio({ controla_inventario: false, asistente_mira_stock: true });
        expect(nombres(await cartaService.buscarProductos(6, 'hamburguesa'))).toEqual(['Discordia', 'Dulcinea']);
    });
});
