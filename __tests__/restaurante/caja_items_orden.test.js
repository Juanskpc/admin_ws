/**
 * Los productos que se despliegan bajo una fila de Caja.
 *
 * La fila de caja dice cuánto entró; el acordeón dice de qué. Lo que hay que sostener son
 * dos cosas distintas:
 *
 *  1. Que el desglose sea el del pedido: sus líneas, en el orden en que se tomaron, con la
 *     cantidad, el precio y los ingredientes que el cliente pidió quitar.
 *  2. Que el pedido sea de QUIEN pregunta. La ruta recibe un id de orden suelto, así que el
 *     `id_negocio` va en el WHERE: sin eso, iterar ids leería los pedidos de otro inquilino,
 *     que es exactamente la fuga que cerró F2.
 *
 * Corre contra la base de verdad, como el resto de suites de este repo, y necesita
 * `Restaurante Demo` con carta (`node scripts/seed_dev_local.js`).
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const cajaService = require('../../app_restaurante_api/services/cajaService');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuario;
let productos = [];
let idIngrediente = null;
let idProductoConIngrediente = null;
let precioConIngrediente = 0;
let idCaja;
let cajaEraDeLaSuite = false;

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

async function crearPedido(items) {
    const orden = await pedidoService.crearOrden({
        idNegocio,
        idUsuario,
        idMesa: null,
        mesa: 'TEST-ITEMS',
        nota: 'test items de caja',
        tipoPedido: 'LLEVAR',
        items,
    });
    ordenesCreadas.push(orden.id_orden);
    return orden;
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

    productos = await sequelize.query(
        `SELECT id_producto, nombre, precio FROM restaurante.carta_producto
          WHERE id_negocio = :n AND estado = 'A' AND precio > 0
          ORDER BY id_producto LIMIT 2;`,
        { replacements: { n: idNegocio }, type: sequelize.QueryTypes.SELECT },
    );

    // El ingrediente para la prueba de exclusiones lo crea la propia suite y lo borra
    // al final. La carta sembrada no siempre trae ingredientes —en la base local no
    // los tiene— y depender de ellos convertía este test en uno que se saltaba solo,
    // sin comprobar nada y sin decirlo.
    idIngrediente = (await unaFila(
        `INSERT INTO restaurante.carta_ingrediente (id_negocio, nombre, unidad_medida, estado)
         VALUES (:n, 'TEST-ingrediente-caja', 'g', 'A')
         RETURNING id_ingrediente;`,
        { n: idNegocio },
    ))?.id_ingrediente ?? null;

    idProductoConIngrediente = productos[0]?.id_producto ?? null;
    precioConIngrediente = Number(productos[0]?.precio ?? 0);

    await sequelize.query(
        `INSERT INTO restaurante.carta_producto_ingred
             (id_producto, id_ingrediente, es_removible, estado)
         VALUES (:p, :i, true, 'A');`,
        { replacements: { p: idProductoConIngrediente, i: idIngrediente } },
    );

    // Tomar un pedido exige turno abierto. Si ya hay uno se reutiliza y se deja como
    // estaba: cerrar el turno de otro es un efecto que esta suite no debe tener.
    const abierta = await unaFila(
        `SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`,
        { n: idNegocio },
    );
    if (abierta) {
        idCaja = abierta.id_caja;
    } else {
        idCaja = (await cajaService.abrirCaja({
            idNegocio, idUsuario, montoApertura: 0, observaciones: 'test items de caja',
        })).id_caja;
        cajaEraDeLaSuite = true;
    }
});

afterAll(async () => {
    for (const idOrden of ordenesCreadas) await borrarOrden(idOrden);
    if (idIngrediente) {
        await sequelize.query(
            'DELETE FROM restaurante.carta_producto_ingred WHERE id_ingrediente = :i;',
            { replacements: { i: idIngrediente } },
        );
        await sequelize.query(
            'DELETE FROM restaurante.carta_ingrediente WHERE id_ingrediente = :i;',
            { replacements: { i: idIngrediente } },
        );
    }
    if (cajaEraDeLaSuite) {
        await sequelize.query(
            `UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_caja = :c AND estado = 'A';`,
            { replacements: { c: idCaja } },
        );
    }
    await sequelize.close();
});

describe('productos del pedido detrás de una fila de caja', () => {
    it('devuelve las líneas del pedido con cantidad, precio y totales', async () => {
        const [a, b] = productos;
        const orden = await crearPedido([
            { id_producto: a.id_producto, cantidad: 2, precio_unitario: Number(a.precio), exclusiones: [] },
            { id_producto: b.id_producto, cantidad: 1, precio_unitario: Number(b.precio), exclusiones: [] },
        ]);

        const detalle = await cajaService.getItemsOrden({
            idOrden: orden.id_orden, idNegocio,
        });

        expect(detalle.numero_orden).toBe(orden.numero_orden);
        expect(detalle.items).toHaveLength(2);

        const [primero, segundo] = detalle.items;
        expect(primero.nombre).toBe(a.nombre);
        expect(primero.cantidad).toBe(2);
        expect(primero.precio_unitario).toBe(Number(a.precio));
        expect(primero.subtotal).toBe(Number(a.precio) * 2);
        expect(segundo.nombre).toBe(b.nombre);

        // El desglose tiene que cuadrar con la fila de caja, o el acordeón contradice
        // al listado que lo contiene.
        const suma = detalle.items.reduce((t, i) => t + i.subtotal, 0);
        expect(suma).toBe(detalle.subtotal);
        expect(detalle.total).toBe(Number(orden.total));
    });

    it('lista los ingredientes que el cliente pidió quitar', async () => {
        expect(idIngrediente).not.toBeNull();

        const orden = await crearPedido([{
            id_producto: idProductoConIngrediente,
            cantidad: 1,
            precio_unitario: precioConIngrediente,
            exclusiones: [idIngrediente],
        }]);

        const detalle = await cajaService.getItemsOrden({
            idOrden: orden.id_orden, idNegocio,
        });

        expect(detalle.items[0].sin).toHaveLength(1);
        expect(typeof detalle.items[0].sin[0]).toBe('string');
    });

    it('no devuelve el pedido de otro negocio', async () => {
        const [a] = productos;
        const orden = await crearPedido([
            { id_producto: a.id_producto, cantidad: 1, precio_unitario: Number(a.precio), exclusiones: [] },
        ]);

        const ajeno = await cajaService.getItemsOrden({
            idOrden: orden.id_orden,
            idNegocio: idNegocio + 9999,
        });

        expect(ajeno).toBeNull();
    });

    it('un id de pedido que no existe devuelve null, no un error', async () => {
        const detalle = await cajaService.getItemsOrden({ idOrden: 999999999, idNegocio });
        expect(detalle).toBeNull();
    });
});
