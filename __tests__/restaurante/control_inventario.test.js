/**
 * El interruptor de control de inventario (`gener_negocio.controla_inventario`).
 *
 * Muchos restaurantes pequeños no tienen la receta cargada, así que la comprobación de
 * stock solo servía para que el POS les preguntara en cada venta por insumos que nunca
 * registraron. Apagando el interruptor, el pedido pasa y el inventario se queda quieto.
 *
 * Lo que hay que sostener son tres cosas, y la tercera es la que de verdad importa:
 *
 *  1. Encendido (el default), un pedido sin stock suficiente rebota con STOCK_INSUFICIENTE.
 *  2. Apagado, ese mismo pedido pasa.
 *  3. Apagado, el stock **no se mueve**: ni baja ni queda en negativo. Descontar sin avisar
 *     habría sido la media tinta peor de las dos, porque llena Inventario de alertas rojas
 *     que son justo lo que el negocio quería quitarse de encima.
 *
 * Corre contra la base de verdad, como el resto de suites de este repo. La receta y el
 * insumo los crea y los borra la propia suite: depender de la carta sembrada haría que el
 * test pasara o se saltara según la base.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const cajaService = require('../../app_restaurante_api/services/cajaService');

const sequelize = Models.sequelize;

const STOCK_INICIAL = 10;      // gramos que hay del insumo
const PORCION = 400;           // gramos que se lleva cada unidad del producto: nunca alcanza

let idNegocio;
let idUsuario;
let idProducto;
let precio;
let idIngrediente;
let idCaja;
let cajaEraDeLaSuite = false;
let controlOriginal;

const ordenesCreadas = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

async function setControlInventario(activo) {
    await sequelize.query(
        'UPDATE general.gener_negocio SET controla_inventario = :v WHERE id_negocio = :n;',
        { replacements: { v: activo, n: idNegocio } },
    );
}

async function stockActual() {
    const fila = await unaFila(
        'SELECT stock_actual FROM restaurante.carta_ingrediente WHERE id_ingrediente = :i;',
        { i: idIngrediente },
    );
    return Number(fila?.stock_actual ?? 0);
}

async function crearPedido() {
    const orden = await pedidoService.crearOrden({
        idNegocio,
        idUsuario,
        idMesa: null,
        mesa: 'TEST-INV',
        nota: 'test control inventario',
        tipoPedido: 'LLEVAR',
        items: [{ id_producto: idProducto, cantidad: 1, precio_unitario: precio, exclusiones: [] }],
    });
    ordenesCreadas.push(orden.id_orden);
    return orden;
}

async function borrarOrden(idOrden) {
    for (const sql of [
        'DELETE FROM restaurante.rest_movimiento_caja WHERE id_orden = :o',
        'DELETE FROM restaurante.rest_pago_orden WHERE id_orden = :o',
        `DELETE FROM restaurante.pedid_detalle_exclu
          WHERE id_detalle IN (SELECT id_detalle FROM restaurante.pedid_detalle WHERE id_orden = :o)`,
        'DELETE FROM restaurante.pedid_detalle WHERE id_orden = :o',
        'DELETE FROM restaurante.pedid_orden WHERE id_orden = :o',
    ]) {
        await sequelize.query(sql, { replacements: { o: idOrden } });
    }
}

beforeAll(async () => {
    const negocio = await unaFila(
        `SELECT id_negocio, controla_inventario FROM general.gener_negocio
          WHERE nombre = 'Restaurante Demo';`,
    );
    idNegocio = negocio?.id_negocio;
    controlOriginal = negocio?.controla_inventario;

    idUsuario = (await unaFila(
        `SELECT id_usuario FROM general.gener_negocio_usuario
          WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 1;`,
        { n: idNegocio },
    ))?.id_usuario;

    const producto = await unaFila(
        `SELECT id_producto, precio FROM restaurante.carta_producto
          WHERE id_negocio = :n AND estado = 'A' AND precio > 0 ORDER BY id_producto LIMIT 1;`,
        { n: idNegocio },
    );
    idProducto = producto?.id_producto;
    precio = Number(producto?.precio ?? 0);

    // Un insumo que nunca alcanza, atado al producto que va a pedirse. Así el caso de
    // «no hay stock» es exacto y no depende de lo que traiga la base.
    idIngrediente = (await unaFila(
        `INSERT INTO restaurante.carta_ingrediente
             (id_negocio, nombre, unidad_medida, stock_actual, estado)
         VALUES (:n, 'TEST-insumo-control', 'g', :s, 'A')
         RETURNING id_ingrediente;`,
        { n: idNegocio, s: STOCK_INICIAL },
    ))?.id_ingrediente;

    await sequelize.query(
        `INSERT INTO restaurante.carta_producto_ingred
             (id_producto, id_ingrediente, porcion, unidad_medida, es_removible, estado)
         VALUES (:p, :i, :porcion, 'g', false, 'A');`,
        { replacements: { p: idProducto, i: idIngrediente, porcion: PORCION } },
    );

    const abierta = await unaFila(
        `SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`,
        { n: idNegocio },
    );
    if (abierta) {
        idCaja = abierta.id_caja;
    } else {
        idCaja = (await cajaService.abrirCaja({
            idNegocio, idUsuario, montoApertura: 0, observaciones: 'test control inventario',
        })).id_caja;
        cajaEraDeLaSuite = true;
    }
});

afterAll(async () => {
    for (const idOrden of ordenesCreadas) await borrarOrden(idOrden);
    await sequelize.query(
        'DELETE FROM restaurante.carta_producto_ingred WHERE id_ingrediente = :i;',
        { replacements: { i: idIngrediente } },
    );
    await sequelize.query(
        'DELETE FROM restaurante.carta_ingrediente WHERE id_ingrediente = :i;',
        { replacements: { i: idIngrediente } },
    );
    // El interruptor se deja exactamente como estaba: es configuración del negocio,
    // no estado de la prueba.
    await sequelize.query(
        'UPDATE general.gener_negocio SET controla_inventario = :v WHERE id_negocio = :n;',
        { replacements: { v: controlOriginal, n: idNegocio } },
    );
    if (cajaEraDeLaSuite) {
        await sequelize.query(
            `UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_caja = :c AND estado = 'A';`,
            { replacements: { c: idCaja } },
        );
    }
    await sequelize.close();
});

describe('control de inventario por negocio', () => {
    it('encendido, un pedido sin stock suficiente no pasa', async () => {
        await setControlInventario(true);

        await expect(crearPedido()).rejects.toMatchObject({ code: 'STOCK_INSUFICIENTE' });
        expect(await stockActual()).toBe(STOCK_INICIAL);
    });

    it('apagado, ese mismo pedido pasa', async () => {
        await setControlInventario(false);

        const orden = await crearPedido();

        expect(orden.id_orden).toBeGreaterThan(0);
        expect(orden.estado).toBe('ABIERTA');
    });

    it('apagado, el stock no se mueve ni queda en negativo', async () => {
        await setControlInventario(false);
        const antes = await stockActual();

        await crearPedido();

        expect(await stockActual()).toBe(antes);
    });

    it('al volver a encenderlo, la comprobación vuelve sin tocar nada más', async () => {
        await setControlInventario(true);

        await expect(crearPedido()).rejects.toMatchObject({ code: 'STOCK_INSUFICIENTE' });
    });

    it('encendido y con stock de sobra, el pedido pasa y descuenta la porción', async () => {
        await setControlInventario(true);
        await sequelize.query(
            'UPDATE restaurante.carta_ingrediente SET stock_actual = :s WHERE id_ingrediente = :i;',
            { replacements: { s: PORCION * 3, i: idIngrediente } },
        );

        await crearPedido();

        expect(await stockActual()).toBe(PORCION * 2);
    });
});
