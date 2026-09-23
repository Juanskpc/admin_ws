/**
 * Un producto que se queda sin insumo para hacer uno más se apaga SOLO.
 *
 * ## El fallo que esto evita
 *
 * Hasta ahora `disponible` era un interruptor puramente manual: el negocio lo apagaba a mano
 * desde la carta, y nada más lo tocaba. El bot seguía ofreciendo un producto cuyo ingrediente
 * ya se había agotado, el cliente lo pedía, y solo AL CONFIRMAR se enteraba de que no había —
 * la peor forma posible de decir que no hay algo: después de que ya lo pidió.
 *
 * `desactivarProductosSinStock` (dentro de `consumirIngredientesPorItems`) cierra esto: al
 * consumir el stock de un pedido, cualquier producto ACTIVO cuya receta ya no alcance para una
 * unidad más se apaga en la misma transacción, y `consultar_carta`/`buscar_producto` —que ya
 * filtran por `disponible`— dejan de ofrecerlo.
 *
 * Corre contra la base de verdad. El insumo, la receta y los dos productos de prueba los crea
 * y los borra la propia suite: depender de la carta sembrada haría que el test pasara o se
 * saltara según la base.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const cajaService = require('../../app_restaurante_api/services/cajaService');

const sequelize = Models.sequelize;

const PORCION = 100; // gramos que se lleva cada unidad de "A" o de "B"

let idNegocio;
let idUsuario;
let idCategoria;
let idIngrediente;
let idIngredienteAparte;
let idProductoA;
let idProductoB;
let idProductoAparte;
let idCaja;
let cajaEraDeLaSuite = false;

const ordenesCreadas = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

async function disponibleDe(idProducto) {
    const fila = await unaFila(
        `SELECT disponible FROM restaurante.carta_producto WHERE id_producto = :p;`,
        { p: idProducto },
    );
    return Boolean(fila?.disponible);
}

async function ponerStock(idIng, valor) {
    await sequelize.query(
        `UPDATE restaurante.carta_ingrediente SET stock_actual = :s WHERE id_ingrediente = :i;`,
        { replacements: { s: valor, i: idIng } },
    );
}

async function ponerDisponible(idProducto, valor) {
    await sequelize.query(
        `UPDATE restaurante.carta_producto SET disponible = :v WHERE id_producto = :p;`,
        { replacements: { v: valor, p: idProducto } },
    );
}

async function crearPedido(idProducto, cantidad = 1) {
    const producto = await unaFila(
        `SELECT precio FROM restaurante.carta_producto WHERE id_producto = :p;`, { p: idProducto },
    );
    const orden = await pedidoService.crearOrden({
        idNegocio,
        idUsuario,
        idMesa: null,
        mesa: 'TEST-AUTOAPAGADO',
        nota: 'test auto desactivar sin stock',
        tipoPedido: 'LLEVAR',
        items: [{ id_producto: idProducto, cantidad, precio_unitario: Number(producto.precio), exclusiones: [] }],
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
        `SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`,
    );
    idNegocio = negocio?.id_negocio;

    idUsuario = (await unaFila(
        `SELECT id_usuario FROM general.gener_negocio_usuario
          WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 1;`,
        { n: idNegocio },
    ))?.id_usuario;

    idCategoria = (await unaFila(
        `SELECT id_categoria FROM restaurante.carta_categoria WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`,
        { n: idNegocio },
    ))?.id_categoria;

    // Un insumo COMPARTIDO entre dos productos, y otro aparte que no le importa a nadie más.
    idIngrediente = (await unaFila(
        `INSERT INTO restaurante.carta_ingrediente (id_negocio, nombre, unidad_medida, stock_actual, estado)
         VALUES (:n, 'TEST-insumo-compartido', 'g', :s, 'A') RETURNING id_ingrediente;`,
        { n: idNegocio, s: PORCION * 2 },
    ))?.id_ingrediente;

    idIngredienteAparte = (await unaFila(
        `INSERT INTO restaurante.carta_ingrediente (id_negocio, nombre, unidad_medida, stock_actual, estado)
         VALUES (:n, 'TEST-insumo-aparte', 'g', 500, 'A') RETURNING id_ingrediente;`,
        { n: idNegocio },
    ))?.id_ingrediente;

    // "A" y "B" comparten el insumo compartido. "Aparte" usa el suyo propio y no debe verse
    // afectado por nada de lo que le pase al de A/B.
    idProductoA = (await unaFila(
        `INSERT INTO restaurante.carta_producto (id_negocio, id_categoria, nombre, precio, disponible, visible, estado)
         VALUES (:n, :c, 'TEST-producto-A', 15000, true, true, 'A') RETURNING id_producto;`,
        { n: idNegocio, c: idCategoria },
    ))?.id_producto;

    idProductoB = (await unaFila(
        `INSERT INTO restaurante.carta_producto (id_negocio, id_categoria, nombre, precio, disponible, visible, estado)
         VALUES (:n, :c, 'TEST-producto-B', 18000, true, true, 'A') RETURNING id_producto;`,
        { n: idNegocio, c: idCategoria },
    ))?.id_producto;

    idProductoAparte = (await unaFila(
        `INSERT INTO restaurante.carta_producto (id_negocio, id_categoria, nombre, precio, disponible, visible, estado)
         VALUES (:n, :c, 'TEST-producto-aparte', 9000, true, true, 'A') RETURNING id_producto;`,
        { n: idNegocio, c: idCategoria },
    ))?.id_producto;

    for (const idProducto of [idProductoA, idProductoB]) {
        await sequelize.query(
            `INSERT INTO restaurante.carta_producto_ingred
                 (id_producto, id_ingrediente, porcion, unidad_medida, es_removible, estado)
             VALUES (:p, :i, :porcion, 'g', false, 'A');`,
            { replacements: { p: idProducto, i: idIngrediente, porcion: PORCION } },
        );
    }
    await sequelize.query(
        `INSERT INTO restaurante.carta_producto_ingred
             (id_producto, id_ingrediente, porcion, unidad_medida, es_removible, estado)
         VALUES (:p, :i, 50, 'g', false, 'A');`,
        { replacements: { p: idProductoAparte, i: idIngredienteAparte } },
    );

    const abierta = await unaFila(
        `SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`,
        { n: idNegocio },
    );
    if (abierta) {
        idCaja = abierta.id_caja;
    } else {
        idCaja = (await cajaService.abrirCaja({
            idNegocio, idUsuario, montoApertura: 0, observaciones: 'test auto desactivar sin stock',
        })).id_caja;
        cajaEraDeLaSuite = true;
    }
});

afterAll(async () => {
    for (const idOrden of ordenesCreadas) await borrarOrden(idOrden);
    await sequelize.query(
        'DELETE FROM restaurante.carta_producto_ingred WHERE id_ingrediente IN (:i1, :i2);',
        { replacements: { i1: idIngrediente, i2: idIngredienteAparte } },
    );
    await sequelize.query(
        'DELETE FROM restaurante.carta_producto WHERE id_producto IN (:a, :b, :c);',
        { replacements: { a: idProductoA, b: idProductoB, c: idProductoAparte } },
    );
    await sequelize.query(
        'DELETE FROM restaurante.carta_ingrediente WHERE id_ingrediente IN (:i1, :i2);',
        { replacements: { i1: idIngrediente, i2: idIngredienteAparte } },
    );
    if (cajaEraDeLaSuite) {
        await sequelize.query(
            `UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_caja = :c AND estado = 'A';`,
            { replacements: { c: idCaja } },
        );
    }
    await sequelize.close();
});

describe('desactivarProductosSinStock', () => {
    it('si después del pedido todavía alcanza para uno más, nadie se apaga', async () => {
        await ponerStock(idIngrediente, PORCION * 2);
        await ponerDisponible(idProductoA, true);
        await ponerDisponible(idProductoB, true);

        await crearPedido(idProductoA, 1); // queda exactamente PORCION: alcanza para uno más

        expect(await disponibleDe(idProductoA)).toBe(true);
        expect(await disponibleDe(idProductoB)).toBe(true);
    });

    it('apaga también al que comparte el insumo, aunque no estuviera en el pedido', async () => {
        await ponerStock(idIngrediente, PORCION * 2);
        await ponerDisponible(idProductoA, true);
        await ponerDisponible(idProductoB, true);

        await crearPedido(idProductoA, 2); // se lleva TODO el stock

        expect(await disponibleDe(idProductoA)).toBe(false);
        expect(await disponibleDe(idProductoB)).toBe(false); // nunca se pidió, y se apaga igual
    });

    it('con stock de sobra, nadie se toca', async () => {
        await ponerStock(idIngrediente, PORCION * 10);
        await ponerDisponible(idProductoA, true);
        await ponerDisponible(idProductoB, true);

        await crearPedido(idProductoA, 1);

        expect(await disponibleDe(idProductoA)).toBe(true);
        expect(await disponibleDe(idProductoB)).toBe(true);
    });

    it('un producto con un insumo APARTE no se ve afectado por lo que le pase a otro', async () => {
        await ponerStock(idIngrediente, PORCION); // se va a agotar
        await ponerDisponible(idProductoA, true);
        await ponerDisponible(idProductoAparte, true);

        await crearPedido(idProductoA, 1);

        expect(await disponibleDe(idProductoA)).toBe(false);
        expect(await disponibleDe(idProductoAparte)).toBe(true);
    });

    it('no vuelve a encender solo: reabastecer no reactiva lo que se apagó', async () => {
        await ponerStock(idIngrediente, PORCION);
        await ponerDisponible(idProductoA, true);
        await crearPedido(idProductoA, 1);
        expect(await disponibleDe(idProductoA)).toBe(false);

        // Se reabastece de sobra, pero nadie ha vuelto a comprar nada.
        await ponerStock(idIngrediente, PORCION * 10);

        expect(await disponibleDe(idProductoA)).toBe(false);
    });

    it('uno que el negocio ya había apagado a mano, por otra razón, no se toca ni se audita distinto', async () => {
        await ponerStock(idIngrediente, PORCION * 10);
        await ponerDisponible(idProductoB, false); // apagado a mano, con stock de sobra

        await crearPedido(idProductoA, 1);

        // Sigue apagado — y lo estaba desde antes, no por esto: no hay nada que verificar
        // aparte de que la consulta no lo "reactivó" por accidente al filtrar por disponible=true.
        expect(await disponibleDe(idProductoB)).toBe(false);
    });

    it('con controla_inventario apagado, no se apaga nada', async () => {
        const negocio = await unaFila(
            `SELECT controla_inventario FROM general.gener_negocio WHERE id_negocio = :n;`, { n: idNegocio },
        );
        const original = negocio.controla_inventario;
        await sequelize.query(
            `UPDATE general.gener_negocio SET controla_inventario = false WHERE id_negocio = :n;`,
            { replacements: { n: idNegocio } },
        );
        try {
            await ponerStock(idIngrediente, PORCION);
            await ponerDisponible(idProductoA, true);

            await crearPedido(idProductoA, 5); // muchísimo más de lo que hay

            expect(await disponibleDe(idProductoA)).toBe(true);
        } finally {
            await sequelize.query(
                `UPDATE general.gener_negocio SET controla_inventario = :v WHERE id_negocio = :n;`,
                { replacements: { v: original, n: idNegocio } },
            );
        }
    });
});
