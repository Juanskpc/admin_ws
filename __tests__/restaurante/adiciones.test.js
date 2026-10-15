/**
 * Adiciones / toppings / extras ligados a un producto (2026-10-15).
 *
 * Recorre la función de punta a punta contra la base de verdad:
 *  - apagada (`permite_adiciones = false`) un pedido con adiciones se rechaza;
 *  - una adición se crea como producto (`es_adicion`) y, sin categoría, cae en la del término;
 *  - el plato ofrece sus adiciones y el listado de administración las trae;
 *  - al pedir, la adición es una línea que cuelga del plato, con la cantidad TOTAL y el precio de
 *    la base (no el que mande el navegador), y descuenta su insumo del inventario;
 *  - una adición que el plato no ofrece, o agotada, no entra;
 *  - quitar unidades del plato arrastra sus adiciones;
 *  - la carta pública saca las adiciones de la lista y las pone dentro de cada producto;
 *  - un producto que deja de ser adición deja de ofrecerse.
 *
 * Corre contra la base local con `Restaurante Demo` y carta (`seed_dev_local.js`).
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const cajaService = require('../../app_restaurante_api/services/cajaService');
const cartaAdminService = require('../../app_restaurante_api/services/cartaAdminService');
const cartaService = require('../../app_restaurante_api/services/cartaService');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuario;
let idPlato;
let precioPlato;
let idQueso;
let idTocineta;
let idSuelta; // adición que el plato NO ofrece
let idInsumo;
let idCaja;
let cajaEraDeLaSuite = false;
let negocioAntes;
const ordenesCreadas = [];
const productosCreados = [];
const categoriasCreadas = [];

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
        'DELETE FROM restaurante.pedid_detalle WHERE id_orden = :o AND id_detalle_padre IS NOT NULL',
        'DELETE FROM restaurante.pedid_detalle WHERE id_orden = :o',
        'DELETE FROM restaurante.pedid_orden WHERE id_orden = :o',
    ]) {
        await sequelize.query(sql, { replacements: { o: idOrden } });
    }
}

async function lineas(idOrden) {
    const filas = await sequelize.query(
        `SELECT d.id_detalle, d.id_producto, d.cantidad, d.precio_unitario, d.subtotal, d.id_detalle_padre
           FROM restaurante.pedid_detalle d WHERE d.id_orden = :o ORDER BY d.id_detalle;`,
        { replacements: { o: idOrden }, type: sequelize.QueryTypes.SELECT }
    );
    return filas.map((f) => ({
        id_detalle: f.id_detalle,
        id_producto: f.id_producto,
        cantidad: Number(f.cantidad),
        precio_unitario: Number(f.precio_unitario),
        subtotal: Number(f.subtotal),
        id_detalle_padre: f.id_detalle_padre,
    }));
}

async function pedir(items) {
    const orden = await pedidoService.crearOrden({
        idNegocio,
        idUsuario,
        idMesa: null,
        tipoPedido: 'LLEVAR',
        idDomiciliario: idUsuario,
        nota: 'test adiciones',
        items,
    });
    ordenesCreadas.push(orden.id_orden);
    return orden;
}

async function fijarNegocio(campos) {
    await Models.GenerNegocio.update(campos, { where: { id_negocio: idNegocio } });
}

beforeAll(async () => {
    idNegocio = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`))
        .id_negocio;
    idUsuario = (await unaFila(
        `SELECT id_usuario FROM general.gener_negocio_usuario
          WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 1;`,
        { n: idNegocio }
    )).id_usuario;
    negocioAntes = await unaFila(
        `SELECT permite_adiciones, termino_adiciones, controla_inventario
           FROM general.gener_negocio WHERE id_negocio = :n;`,
        { n: idNegocio }
    );

    const plato = await unaFila(
        `SELECT p.id_producto, p.precio FROM restaurante.carta_producto p
           JOIN restaurante.carta_categoria c ON c.id_categoria = p.id_categoria
          WHERE p.id_negocio = :n AND p.estado = 'A' AND p.precio > 0 AND p.disponible
            AND p.visible AND c.visible AND c.estado = 'A' AND NOT p.es_adicion
            AND NOT EXISTS (SELECT 1 FROM restaurante.carta_producto_ingred i
                             WHERE i.id_producto = p.id_producto AND i.estado = 'A' AND i.porcion > 0)
          ORDER BY p.id_producto LIMIT 1;`,
        { n: idNegocio }
    );
    idPlato = plato.id_producto;
    precioPlato = Number(plato.precio);

    idInsumo = (await unaFila(
        `INSERT INTO restaurante.carta_ingrediente (id_negocio, nombre, unidad_medida, stock_actual, estado)
         VALUES (:n, 'TEST-adicion-queso', 'g', 1000, 'A') RETURNING id_ingrediente;`,
        { n: idNegocio }
    )).id_ingrediente;

    const abierta = await unaFila(
        `SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`,
        { n: idNegocio }
    );
    if (abierta) {
        idCaja = abierta.id_caja;
    } else {
        idCaja = (await cajaService.abrirCaja({
            idNegocio, idUsuario, montoApertura: 0, observaciones: 'test adiciones',
        })).id_caja;
        cajaEraDeLaSuite = true;
    }
});

afterAll(async () => {
    for (const id of ordenesCreadas) await borrarOrden(id);
    await sequelize.query(
        'DELETE FROM restaurante.carta_producto_adicion WHERE id_producto IN (:ids) OR id_adicion IN (:ids)',
        { replacements: { ids: [idPlato, ...productosCreados] } }
    );
    if (productosCreados.length) {
        await sequelize.query('DELETE FROM restaurante.carta_producto_ingred WHERE id_producto IN (:ids)', {
            replacements: { ids: productosCreados },
        });
        await sequelize.query('DELETE FROM restaurante.carta_producto WHERE id_producto IN (:ids)', {
            replacements: { ids: productosCreados },
        });
    }
    for (const c of categoriasCreadas) {
        await sequelize.query(
            `DELETE FROM restaurante.carta_categoria c WHERE c.id_categoria = :c
               AND NOT EXISTS (SELECT 1 FROM restaurante.carta_producto p WHERE p.id_categoria = c.id_categoria)`,
            { replacements: { c } }
        );
    }
    await sequelize.query('DELETE FROM restaurante.carta_ingrediente WHERE id_ingrediente = :i', {
        replacements: { i: idInsumo },
    });
    await fijarNegocio({
        permite_adiciones: negocioAntes.permite_adiciones,
        termino_adiciones: negocioAntes.termino_adiciones,
        controla_inventario: negocioAntes.controla_inventario,
    });
    if (cajaEraDeLaSuite) {
        await sequelize.query('DELETE FROM restaurante.rest_caja WHERE id_caja = :c', { replacements: { c: idCaja } });
    }
    await sequelize.close();
});

describe('adiciones', () => {
    test('se crean como productos; sin categoría caen en la del término del negocio', async () => {
        await fijarNegocio({ permite_adiciones: true, termino_adiciones: 'TOPPING', controla_inventario: true });
        const antes = await unaFila(
            `SELECT id_categoria FROM restaurante.carta_categoria
              WHERE id_negocio = :n AND estado = 'A' AND lower(nombre) = 'toppings' LIMIT 1;`,
            { n: idNegocio }
        );

        const queso = await cartaAdminService.crearProducto({
            id_negocio: idNegocio,
            nombre: 'TEST queso extra',
            precio: 3000,
            es_adicion: true,
            ingredientes: [{ id_ingrediente: idInsumo, porcion: 50 }],
        });
        idQueso = queso.id_producto;
        productosCreados.push(idQueso);
        if (!antes) categoriasCreadas.push(queso.id_categoria);

        const categoria = await Models.CartaCategoria.findByPk(queso.id_categoria);
        expect(categoria.nombre).toBe('Toppings');
        expect(queso.es_adicion).toBe(true);

        const tocineta = await cartaAdminService.crearProducto({
            id_negocio: idNegocio, nombre: 'TEST tocineta', precio: 4000, es_adicion: true,
        });
        idTocineta = tocineta.id_producto;
        productosCreados.push(idTocineta);
        expect(tocineta.id_categoria).toBe(queso.id_categoria); // reutiliza la misma

        const suelta = await cartaAdminService.crearProducto({
            id_negocio: idNegocio, nombre: 'TEST adición suelta', precio: 1000, es_adicion: true,
        });
        idSuelta = suelta.id_producto;
        productosCreados.push(idSuelta);
    });

    test('el plato ofrece sus adiciones y el listado de administración las trae en orden', async () => {
        await cartaAdminService.editarProducto(idPlato, { adiciones: [idTocineta, idQueso] });
        const productos = await cartaAdminService.getProductosAdmin(idNegocio);
        const plato = productos.find((p) => p.id_producto === idPlato).toJSON();
        expect(plato.adiciones.map((a) => a.id_adicion)).toEqual([idTocineta, idQueso]);
        expect(productos.find((p) => p.id_producto === idQueso).es_adicion).toBe(true);
    });

    test('una adición no puede ofrecer adiciones, y no se liga lo que no es adición', async () => {
        await expect(
            cartaAdminService.editarProducto(idPlato, { adiciones: [idPlato + 0, 999999999] })
        ).rejects.toMatchObject({ code: 'ADICION_INVALIDA' });
    });

    test('al pedir, la adición cuelga del plato con cantidad total y precio de la base', async () => {
        const stockAntes = Number((await unaFila(
            'SELECT stock_actual FROM restaurante.carta_ingrediente WHERE id_ingrediente = :i', { i: idInsumo }
        )).stock_actual);

        const orden = await pedir([{
            id_producto: idPlato,
            cantidad: 2,
            precio_unitario: precioPlato,
            // El navegador manda un precio falso: se ignora.
            adiciones: [{ id_producto: idQueso, cantidad: 1, precio_unitario: 1 }, { id_producto: idTocineta }],
        }]);

        const ls = await lineas(orden.id_orden);
        const plato = ls.find((l) => l.id_producto === idPlato);
        const queso = ls.find((l) => l.id_producto === idQueso);
        const tocineta = ls.find((l) => l.id_producto === idTocineta);
        expect(plato.id_detalle_padre).toBeNull();
        expect(queso).toMatchObject({ cantidad: 2, precio_unitario: 3000, subtotal: 6000, id_detalle_padre: plato.id_detalle });
        expect(tocineta).toMatchObject({ cantidad: 2, subtotal: 8000, id_detalle_padre: plato.id_detalle });

        const guardada = await Models.PedidOrden.findByPk(orden.id_orden);
        expect(Number(guardada.subtotal)).toBe(precioPlato * 2 + 6000 + 8000);

        // 2 quesos × 50 g salen del insumo de la adición.
        const stockDespues = Number((await unaFila(
            'SELECT stock_actual FROM restaurante.carta_ingrediente WHERE id_ingrediente = :i', { i: idInsumo }
        )).stock_actual);
        expect(stockAntes - stockDespues).toBe(100);
    });

    test('las pantallas reciben cada adición justo debajo de su plato', async () => {
        const orden = await pedir([
            { id_producto: idPlato, cantidad: 1, precio_unitario: precioPlato, adiciones: [idQueso] },
            { id_producto: idPlato, cantidad: 1, precio_unitario: precioPlato, adiciones: [idTocineta] },
        ]);
        const secuencia = (detalles) =>
            detalles.map((d) => [Number(d.id_producto), d.id_detalle_padre == null ? 'plato' : 'adicion']);
        const esperada = [
            [idPlato, 'plato'], [idQueso, 'adicion'], [idPlato, 'plato'], [idTocineta, 'adicion'],
        ];

        const completa = (await pedidoService.getOrdenById(orden.id_orden)).toJSON();
        expect(secuencia(completa.detalles)).toEqual(esperada);

        const items = await cajaService.getItemsOrden({ idOrden: orden.id_orden, idNegocio });
        expect(items.items.map((d) => d.es_adicion)).toEqual([false, true, false, true]);

        // Es LLEVAR con domiciliario = el usuario: sale en su Despacho.
        const despacho = await pedidoService.getOrdenesDespacho({ idNegocio, idUsuario });
        const enDespacho = despacho.find((o) => o.id_orden === orden.id_orden);
        expect(enDespacho.detalles.map((d) => d.id_detalle_padre == null)).toEqual([true, false, true, false]);
    });

    test('una adición que el plato no ofrece no entra', async () => {
        await expect(
            pedir([{ id_producto: idPlato, cantidad: 1, precio_unitario: precioPlato, adiciones: [idSuelta] }])
        ).rejects.toMatchObject({ code: 'ADICION_INVALIDA', statusCode: 422 });
    });

    test('una adición agotada no entra', async () => {
        await Models.CartaProducto.update({ disponible: false }, { where: { id_producto: idTocineta } });
        try {
            await expect(
                pedir([{ id_producto: idPlato, cantidad: 1, precio_unitario: precioPlato, adiciones: [idTocineta] }])
            ).rejects.toMatchObject({ code: 'ADICION_AGOTADA' });
        } finally {
            await Models.CartaProducto.update({ disponible: true }, { where: { id_producto: idTocineta } });
        }
    });

    test('quitar unidades del plato arrastra sus adiciones', async () => {
        const orden = await pedir([
            { id_producto: idPlato, cantidad: 3, precio_unitario: precioPlato, adiciones: [{ id_producto: idQueso, cantidad: 2 }] },
            { id_producto: idPlato, cantidad: 1, precio_unitario: precioPlato },
        ]);

        // Quitar 1 del plato «con doble queso»: el queso baja de 6 a 4. El plato solo no se toca.
        await pedidoService.quitarItemsOrden({
            idOrden: orden.id_orden,
            idNegocio,
            items: [{ id_producto: idPlato, cantidad: 1, adiciones: [{ id_producto: idQueso, cantidad: 2 }] }],
        });
        let ls = await lineas(orden.id_orden);
        expect(ls.find((l) => l.id_producto === idQueso)).toMatchObject({ cantidad: 4, subtotal: 12000 });
        expect(ls.filter((l) => l.id_producto === idPlato).map((l) => l.cantidad).sort()).toEqual([1, 2]);

        // Quitar los 2 que quedan: el queso se va con ellos.
        await pedidoService.quitarItemsOrden({
            idOrden: orden.id_orden,
            idNegocio,
            items: [{ id_producto: idPlato, cantidad: 2, adiciones: [{ id_producto: idQueso, cantidad: 2 }] }],
        });
        ls = await lineas(orden.id_orden);
        expect(ls.map((l) => l.id_producto)).toEqual([idPlato]);
        const guardada = await Models.PedidOrden.findByPk(orden.id_orden);
        expect(Number(guardada.subtotal)).toBe(precioPlato);
    });

    test('la carta pública saca las adiciones de la lista y las pone en cada producto', async () => {
        const categorias = await cartaService.getCartaPublicaCompleta(idNegocio, { incluirAgotados: true });
        const productos = categorias.flatMap((c) => c.productos);
        expect(productos.some((p) => p.es_adicion)).toBe(false);
        const plato = productos.find((p) => p.id_producto === idPlato);
        expect(plato.adiciones.map((a) => a.id_producto)).toEqual([idTocineta, idQueso]);
        expect(plato.adiciones[1]).toMatchObject({ nombre: 'TEST queso extra', precio: 3000, disponible: true });
    });

    test('apagadas: un pedido con adiciones se rechaza y la carta vuelve a ser la de antes', async () => {
        await fijarNegocio({ permite_adiciones: false });
        await expect(
            pedir([{ id_producto: idPlato, cantidad: 1, precio_unitario: precioPlato, adiciones: [idQueso] }])
        ).rejects.toMatchObject({ code: 'ADICIONES_NO_HABILITADAS', statusCode: 403 });

        const categorias = await cartaService.getCartaPublicaCompleta(idNegocio, { incluirAgotados: true });
        const plato = categorias.flatMap((c) => c.productos).find((p) => p.id_producto === idPlato);
        expect(plato.adiciones).toBeUndefined();
        await fijarNegocio({ permite_adiciones: true });
    });

    test('un producto que deja de ser adición deja de ofrecerse', async () => {
        await cartaAdminService.editarProducto(idTocineta, { es_adicion: false });
        const ligada = await unaFila(
            `SELECT estado FROM restaurante.carta_producto_adicion WHERE id_producto = :p AND id_adicion = :a;`,
            { p: idPlato, a: idTocineta }
        );
        expect(ligada.estado).toBe('I');
    });
});
