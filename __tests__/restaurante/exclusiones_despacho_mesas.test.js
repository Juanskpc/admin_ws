/**
 * Los ingredientes que el cliente pidió quitar llegan a Despacho y a Mesas.
 *
 * La orden ya se guardaba bien —`crearDetallesOrden` escribe las exclusiones, y Cocina y Caja las
 * leían—, pero la consulta de Despacho y el tablero de Mesas no las traían: el tiquete, la tarjeta y
 * «Editar pedido» veían un pedido normal. Un pedido de WhatsApp «sin cebolla» llegaba al negocio
 * sin decirlo, y cocinaba lo que el cliente no quería.
 *
 * Corre contra la base de verdad y necesita `Restaurante Demo` con carta (`seed_dev_local.js`). El
 * ingrediente y la mesa los crea y los borra la propia suite.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const cajaService = require('../../app_restaurante_api/services/cajaService');
const mesaService = require('../../app_restaurante_api/services/mesaService');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuario;
let idProducto;
let precio;
let idIngrediente;
let idCaja;
let cajaEraDeLaSuite = false;
let idMesa;

const ordenesCreadas = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
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
    idNegocio = (await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`,
    ))?.id_negocio;

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
    idProducto = producto.id_producto;
    precio = Number(producto.precio);

    idIngrediente = (await unaFila(
        `INSERT INTO restaurante.carta_ingrediente (id_negocio, nombre, unidad_medida, estado)
         VALUES (:n, 'TEST-cebolla', 'g', 'A') RETURNING id_ingrediente;`,
        { n: idNegocio },
    )).id_ingrediente;
    await sequelize.query(
        `INSERT INTO restaurante.carta_producto_ingred (id_producto, id_ingrediente, es_removible, estado)
         VALUES (:p, :i, true, 'A');`,
        { replacements: { p: idProducto, i: idIngrediente } },
    );

    const abierta = await unaFila(
        `SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`,
        { n: idNegocio },
    );
    if (abierta) {
        idCaja = abierta.id_caja;
    } else {
        idCaja = (await cajaService.abrirCaja({
            idNegocio, idUsuario, montoApertura: 0, observaciones: 'test exclusiones despacho',
        })).id_caja;
        cajaEraDeLaSuite = true;
    }

    const mesa = await mesaService.crearMesa({ idNegocio, nombre: 'TEST mesa exclusiones' });
    idMesa = mesa.id_mesa;
});

afterAll(async () => {
    for (const id of ordenesCreadas) await borrarOrden(id);
    if (idMesa) await Models.RestMesa.destroy({ where: { id_mesa: idMesa } });
    await sequelize.query(
        'DELETE FROM restaurante.carta_producto_ingred WHERE id_ingrediente = :i',
        { replacements: { i: idIngrediente } },
    );
    await sequelize.query(
        'DELETE FROM restaurante.carta_ingrediente WHERE id_ingrediente = :i',
        { replacements: { i: idIngrediente } },
    );
    if (cajaEraDeLaSuite) {
        await sequelize.query('DELETE FROM restaurante.rest_caja WHERE id_caja = :c', { replacements: { c: idCaja } });
    }
    await sequelize.close();
});

/** Dos líneas del mismo producto: una normal y otra sin el ingrediente, como en el pedido real. */
const lineas = () => [
    { id_producto: idProducto, cantidad: 1, precio_unitario: precio },
    { id_producto: idProducto, cantidad: 1, precio_unitario: precio, exclusiones: [idIngrediente] },
];

describe('los ingredientes quitados llegan al negocio', () => {
    it('Despacho trae las exclusiones de cada línea (y solo de la que las tiene)', async () => {
        const orden = await pedidoService.crearOrden({
            idNegocio,
            idUsuario,
            idMesa: null,
            tipoPedido: 'LLEVAR',
            idDomiciliario: idUsuario,
            nota: 'test exclusiones despacho',
            items: lineas(),
        });
        ordenesCreadas.push(orden.id_orden);

        const lista = await pedidoService.getOrdenesDespacho({ idNegocio, idUsuario });
        const pedido = lista.find((p) => p.id_orden === orden.id_orden);
        expect(pedido).toBeDefined();

        const conSin = pedido.detalles.filter((d) => (d.exclusiones ?? []).length > 0);
        const sinSin = pedido.detalles.filter((d) => (d.exclusiones ?? []).length === 0);
        expect(conSin).toHaveLength(1);
        expect(sinSin).toHaveLength(1);
        expect(conSin[0].exclusiones[0].id_ingrediente).toBe(idIngrediente);
        expect(conSin[0].exclusiones[0].ingrediente.nombre).toBe('TEST-cebolla');
    });

    it('el tablero de Mesas trae «sin» por línea', async () => {
        const orden = await pedidoService.crearOrden({
            idNegocio,
            idUsuario,
            idMesa,
            tipoPedido: 'MESA',
            nota: 'test exclusiones mesa',
            items: lineas(),
        });
        ordenesCreadas.push(orden.id_orden);

        const tablero = await mesaService.getMesasDashboard(idNegocio);
        const mesa = tablero.find((m) => m.id_mesa === idMesa);
        const items = mesa.order.items;

        expect(items).toHaveLength(2);
        expect(items.map((i) => i.sin).sort((a, b) => a.length - b.length)).toEqual([[], ['TEST-cebolla']]);
    });
});
