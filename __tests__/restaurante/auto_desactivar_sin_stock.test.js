/**
 * Un producto sin stock para preparar uno más deja de OFRECERSE en el menú público (carta
 * digital + asistente de WhatsApp), pero `disponible` — el interruptor manual que el negocio ve
 * en Productos — nunca se toca.
 *
 * ## El fallo que esto evita (y el que reemplaza)
 *
 * Hasta el 2026-09-21 `consumirIngredientesPorItems` apagaba `disponible` en cualquier producto
 * cuya receta ya no alcanzara, para que el bot dejara de ofrecerlo. Pero `disponible` es EL MISMO
 * valor que lee `cartaAdminController` para pintar Productos: un insumo agotado en la cocina
 * aparecía ahí como si el negocio lo hubiera apagado a mano. Un cliente real reportó sus
 * productos "deshabilitados" el 2026-09-22 sin que nadie hubiera tocado nada — era justo esto.
 *
 * Ahora la falta de stock se calcula EN VIVO, sin guardar nada:
 * `cartaService.alcanzaStockPara` (usada por `getCartaPublica`, `getCartaPublicaCompleta`,
 * `getCategoriasPublicas`, `getProductosPublicosByCategoria` y `buscarProductos` en modo
 * público) decide en el momento en que se arma el menú si la receta alcanza con el stock actual.
 * `disponible` sigue siendo puramente manual.
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
const cartaService = require('../../app_restaurante_api/services/cartaService');

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

async function apareceEnMenuPublico(idProducto, idCategoriaProducto = idCategoria) {
    const productos = await cartaService.getProductosPublicosByCategoria(idNegocio, idCategoriaProducto);
    return productos.some((p) => p.id_producto === idProducto);
}

async function apareceEnBuscador(idProducto, termino) {
    const productos = await cartaService.buscarProductos(idNegocio, termino);
    return productos.some((p) => p.id_producto === idProducto);
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

describe('sin stock: desaparece del menú público, nunca de Productos', () => {
    it('si después del pedido todavía alcanza para uno más, nadie desaparece', async () => {
        await ponerStock(idIngrediente, PORCION * 2);
        await ponerDisponible(idProductoA, true);
        await ponerDisponible(idProductoB, true);

        await crearPedido(idProductoA, 1); // queda exactamente PORCION: alcanza para uno más

        expect(await apareceEnMenuPublico(idProductoA)).toBe(true);
        expect(await apareceEnMenuPublico(idProductoB)).toBe(true);
    });

    it('desaparece del menú también el que comparte el insumo, aunque no estuviera en el pedido', async () => {
        await ponerStock(idIngrediente, PORCION * 2);
        await ponerDisponible(idProductoA, true);
        await ponerDisponible(idProductoB, true);

        await crearPedido(idProductoA, 2); // se lleva TODO el stock

        expect(await apareceEnMenuPublico(idProductoA)).toBe(false);
        expect(await apareceEnMenuPublico(idProductoB)).toBe(false); // nunca se pidió, y desaparece igual

        // Pero en Productos —lo que ve el negocio— sigue apareciendo "disponible": nadie lo apagó.
        expect(await disponibleDe(idProductoA)).toBe(true);
        expect(await disponibleDe(idProductoB)).toBe(true);
    });

    it('el buscador del bot tampoco lo ofrece mientras no haya stock', async () => {
        await ponerStock(idIngrediente, PORCION * 2);
        await ponerDisponible(idProductoA, true);

        await crearPedido(idProductoA, 2); // se lleva todo el stock

        expect(await apareceEnBuscador(idProductoA, 'TEST-producto-A')).toBe(false);
        expect(await disponibleDe(idProductoA)).toBe(true); // sigue "disponible" en Productos
    });

    it('con stock de sobra, nadie se toca', async () => {
        await ponerStock(idIngrediente, PORCION * 10);
        await ponerDisponible(idProductoA, true);
        await ponerDisponible(idProductoB, true);

        await crearPedido(idProductoA, 1);

        expect(await apareceEnMenuPublico(idProductoA)).toBe(true);
        expect(await apareceEnMenuPublico(idProductoB)).toBe(true);
    });

    it('un producto con un insumo APARTE no se ve afectado por lo que le pase a otro', async () => {
        await ponerStock(idIngrediente, PORCION); // se va a agotar
        await ponerDisponible(idProductoA, true);
        await ponerDisponible(idProductoAparte, true);

        await crearPedido(idProductoA, 1);

        expect(await apareceEnMenuPublico(idProductoA)).toBe(false);
        expect(await apareceEnMenuPublico(idProductoAparte)).toBe(true);
    });

    it('se reabastece y vuelve a aparecer solo: ya no es un apagado de una sola vía', async () => {
        await ponerStock(idIngrediente, PORCION);
        await ponerDisponible(idProductoA, true);
        await crearPedido(idProductoA, 1);
        expect(await apareceEnMenuPublico(idProductoA)).toBe(false);

        // Se reabastece de sobra: como ya no se guarda nada, la siguiente consulta al menú
        // público lo vuelve a ofrecer sin que nadie lo "reactive" a mano.
        await ponerStock(idIngrediente, PORCION * 10);

        expect(await apareceEnMenuPublico(idProductoA)).toBe(true);
    });

    it('uno que el negocio apagó a mano sigue sin aparecer aunque haya stock de sobra', async () => {
        await ponerStock(idIngrediente, PORCION * 10);
        await ponerDisponible(idProductoB, false); // apagado a mano, con stock de sobra

        await crearPedido(idProductoA, 1);

        expect(await apareceEnMenuPublico(idProductoB)).toBe(false);
        expect(await disponibleDe(idProductoB)).toBe(false); // seguía apagado desde antes, no por esto
    });

    it('con controla_inventario apagado, nadie desaparece del menú público', async () => {
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

            expect(await apareceEnMenuPublico(idProductoA)).toBe(true);
        } finally {
            await sequelize.query(
                `UPDATE general.gener_negocio SET controla_inventario = :v WHERE id_negocio = :n;`,
                { replacements: { v: original, n: idNegocio } },
            );
        }
    });
});
