/**
 * Editar los ingredientes de un pedido ya guardado (POS → Despacho / Mesas).
 *
 * Cambiar lo que se quita de una línea cambia su clave (producto + exclusiones + nota), y el POS lo
 * traduce a `quitar-items` (la línea vieja) + `agregar-items` (la nueva). Estas pruebas recorren
 * esa traducción contra la base de verdad y comprueban que:
 *  - la línea vieja se va CON sus exclusiones (sin filas huérfanas en `pedid_detalle_exclu`);
 *  - la nueva llega con las suyas;
 *  - una línea «con todo» del mismo producto no se toca;
 *  - el total queda cuadrado con lo que quedó en el pedido.
 *
 * Corre contra la base local con `Restaurante Demo` y carta (`seed_dev_local.js`).
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const cajaService = require('../../app_restaurante_api/services/cajaService');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuario;
let idProducto;
let precio;
let ingA;
let ingB;
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

async function nuevoIngrediente(nombre) {
    const id = (await unaFila(
        `INSERT INTO restaurante.carta_ingrediente (id_negocio, nombre, unidad_medida, estado)
         VALUES (:n, :nom, 'g', 'A') RETURNING id_ingrediente;`,
        { n: idNegocio, nom: nombre },
    )).id_ingrediente;
    await sequelize.query(
        `INSERT INTO restaurante.carta_producto_ingred (id_producto, id_ingrediente, es_removible, estado)
         VALUES (:p, :i, true, 'A');`,
        { replacements: { p: idProducto, i: id } },
    );
    return id;
}

/** Lo que hay guardado: una fila por línea, con sus ids quitados ordenados. */
async function lineas(idOrden) {
    const filas = await sequelize.query(
        `SELECT d.id_detalle, d.cantidad, d.subtotal, d.nota,
                COALESCE(array_agg(x.id_ingrediente ORDER BY x.id_ingrediente)
                         FILTER (WHERE x.id_ingrediente IS NOT NULL), '{}') AS sin
           FROM restaurante.pedid_detalle d
      LEFT JOIN restaurante.pedid_detalle_exclu x ON x.id_detalle = d.id_detalle
          WHERE d.id_orden = :o
       GROUP BY d.id_detalle ORDER BY d.id_detalle;`,
        { replacements: { o: idOrden }, type: sequelize.QueryTypes.SELECT },
    );
    return filas.map((f) => ({
        cantidad: Number(f.cantidad),
        subtotal: Number(f.subtotal),
        nota: f.nota,
        sin: f.sin,
    }));
}

async function huerfanas() {
    return Number((await unaFila(
        `SELECT count(*) AS n FROM restaurante.pedid_detalle_exclu x
          WHERE NOT EXISTS (SELECT 1 FROM restaurante.pedid_detalle d WHERE d.id_detalle = x.id_detalle)
            AND x.id_ingrediente IN (:a, :b);`,
        { a: ingA, b: ingB },
    )).n);
}

async function pedidoNuevo(items) {
    const orden = await pedidoService.crearOrden({
        idNegocio,
        idUsuario,
        idMesa: null,
        tipoPedido: 'LLEVAR',
        idDomiciliario: idUsuario,
        nota: 'test edición exclusiones',
        items,
    });
    ordenesCreadas.push(orden.id_orden);
    return orden.id_orden;
}

beforeAll(async () => {
    idNegocio = (await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`,
    )).id_negocio;
    idUsuario = (await unaFila(
        `SELECT id_usuario FROM general.gener_negocio_usuario
          WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 1;`,
        { n: idNegocio },
    )).id_usuario;
    const producto = await unaFila(
        `SELECT id_producto, precio FROM restaurante.carta_producto
          WHERE id_negocio = :n AND estado = 'A' AND precio > 0 ORDER BY id_producto LIMIT 1;`,
        { n: idNegocio },
    );
    idProducto = producto.id_producto;
    precio = Number(producto.precio);
    ingA = await nuevoIngrediente('TEST-edit-cebolla');
    ingB = await nuevoIngrediente('TEST-edit-tomate');

    const abierta = await unaFila(
        `SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`,
        { n: idNegocio },
    );
    if (abierta) {
        idCaja = abierta.id_caja;
    } else {
        idCaja = (await cajaService.abrirCaja({
            idNegocio, idUsuario, montoApertura: 0, observaciones: 'test edición exclusiones',
        })).id_caja;
        cajaEraDeLaSuite = true;
    }
});

afterAll(async () => {
    for (const id of ordenesCreadas) await borrarOrden(id);
    for (const i of [ingA, ingB]) {
        await sequelize.query('DELETE FROM restaurante.carta_producto_ingred WHERE id_ingrediente = :i', { replacements: { i } });
        await sequelize.query('DELETE FROM restaurante.carta_ingrediente WHERE id_ingrediente = :i', { replacements: { i } });
    }
    if (cajaEraDeLaSuite) {
        await sequelize.query('DELETE FROM restaurante.rest_caja WHERE id_caja = :c', { replacements: { c: idCaja } });
    }
    await sequelize.close();
});

describe('editar los ingredientes de un pedido guardado', () => {
    it('cambiar «sin cebolla» por «sin tomate»: la línea vieja se va con sus exclusiones y la nueva llega con las suyas', async () => {
        const id = await pedidoNuevo([
            { id_producto: idProducto, cantidad: 1, precio_unitario: precio },
            { id_producto: idProducto, cantidad: 1, precio_unitario: precio, exclusiones: [ingA] },
        ]);

        // Lo que hace el POS: primero lo quitado, después lo agregado.
        await pedidoService.quitarItemsOrden({
            idOrden: id,
            idNegocio,
            items: [{ id_producto: idProducto, cantidad: 1, nota: null, exclusiones: [ingA] }],
        });
        await pedidoService.agregarItemsOrden({
            idOrden: id,
            idNegocio,
            items: [{ id_producto: idProducto, cantidad: 1, precio_unitario: precio, nota: null, exclusiones: [ingB] }],
        });

        const l = await lineas(id);
        expect(l.map((x) => x.sin)).toEqual([[], [ingB]]);
        expect(l.map((x) => x.cantidad)).toEqual([1, 1]);
        expect(await huerfanas()).toBe(0);

        const orden = await pedidoService.getOrdenById(id);
        expect(Number(orden.subtotal)).toBe(precio * 2);
    });

    it('quitar UNA de tres «sin cebolla» deja dos y conserva la exclusión', async () => {
        const id = await pedidoNuevo([
            { id_producto: idProducto, cantidad: 3, precio_unitario: precio, exclusiones: [ingA] },
        ]);
        await pedidoService.quitarItemsOrden({
            idOrden: id,
            idNegocio,
            items: [{ id_producto: idProducto, cantidad: 1, nota: null, exclusiones: [ingA] }],
        });
        const l = await lineas(id);
        expect(l).toHaveLength(1);
        expect(l[0].cantidad).toBe(2);
        expect(l[0].subtotal).toBe(precio * 2);
        expect(l[0].sin).toEqual([ingA]);
    });

    it('quitar la línea «con todo» no toca la que lleva «sin cebolla»', async () => {
        const id = await pedidoNuevo([
            { id_producto: idProducto, cantidad: 1, precio_unitario: precio },
            { id_producto: idProducto, cantidad: 1, precio_unitario: precio, exclusiones: [ingA] },
        ]);
        await pedidoService.quitarItemsOrden({
            idOrden: id,
            idNegocio,
            items: [{ id_producto: idProducto, cantidad: 1, nota: null, exclusiones: [] }],
        });
        const l = await lineas(id);
        expect(l).toHaveLength(1);
        expect(l[0].sin).toEqual([ingA]);
    });

    it('la línea que entró por WhatsApp a una mesa (nota «WhatsApp: …») se empareja por su nota', async () => {
        const id = await pedidoNuevo([
            {
                id_producto: idProducto,
                cantidad: 1,
                precio_unitario: precio,
                nota: 'WhatsApp: Ana',
                exclusiones: [ingA, ingB],
            },
        ]);
        await pedidoService.quitarItemsOrden({
            idOrden: id,
            idNegocio,
            items: [{ id_producto: idProducto, cantidad: 1, nota: 'WhatsApp: Ana', exclusiones: [ingB, ingA] }],
        });
        expect(await lineas(id)).toHaveLength(0);
        expect(await huerfanas()).toBe(0);
    });

    it('ids que llegan como texto («12») se emparejan igual que como número', async () => {
        const id = await pedidoNuevo([
            { id_producto: idProducto, cantidad: 1, precio_unitario: precio, exclusiones: [ingA] },
        ]);
        await pedidoService.quitarItemsOrden({
            idOrden: id,
            idNegocio,
            items: [{ id_producto: idProducto, cantidad: 1, nota: null, exclusiones: [String(ingA)] }],
        });
        expect(await lineas(id)).toHaveLength(0);
    });
});
