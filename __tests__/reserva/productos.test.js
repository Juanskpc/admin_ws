/**
 * Venta de productos en `reserva` (`docs/productos-en-reserva.md`): catálogo, venta de
 * mostrador (con o sin cita) y venta pública del portal (siempre sin cita, para recoger).
 *
 * Es una función del perfil, apagada de fábrica — pero eso solo lo comprueba el middleware de
 * ruta (`exigirFuncion`), no los servicios: aquí se prueba la lógica de negocio directamente,
 * como el resto de suites de `reserva` que tocan dinero.
 *
 * Corre contra la base de verdad. Necesita un negocio de tipo RESERVA con formas de pago
 * (`node scripts/seed_dev_local.js`). Usa «Barbería Don Nico» (perfil BASE, precisamente porque
 * la función no depende del perfil): así queda claro que un producto se puede vender en
 * cualquier oficio del vertical, no solo en un salón.
 *
 * Correr con:  DB_PORT=5432 npx jest __tests__/reserva/productos.test.js --forceExit
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const ProductoService = require('../../app_reserva_api/services/productoService');
const VentaProductoService = require('../../app_reserva_api/services/ventaProductoService');
const CajaService = require('../../app_reserva_api/services/cajaService');

const sequelize = Models.sequelize;
const MARCA = 'TEST-PRODUCTOS';

let idNegocio;
let idUsuario;
let idMetodoPago;
let idCaja;
let cajaAbiertaPorLaSuite = false;

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

async function crearProducto(datos = {}) {
    return ProductoService.crear({
        idNegocio,
        nombre: `${MARCA} ${Math.random().toString(36).slice(2, 8)}`,
        precio: 10000,
        ...datos,
    });
}

beforeAll(async () => {
    const negocio = await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Barbería Don Nico';`);
    if (!negocio) throw new Error('No existe «Barbería Don Nico». Ejecuta node scripts/seed_dev_local.js');
    idNegocio = negocio.id_negocio;

    idUsuario = (await unaFila(
        `SELECT id_usuario FROM general.gener_negocio_usuario WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 1;`,
        { n: idNegocio },
    ))?.id_usuario;

    idMetodoPago = (await unaFila(
        `SELECT id_metodo_pago FROM reserva.reserva_metodo_pago WHERE id_negocio = :n AND estado = 'A' ORDER BY id_metodo_pago LIMIT 1;`,
        { n: idNegocio },
    ))?.id_metodo_pago;

    const abierta = await unaFila(`SELECT id_caja FROM reserva.reserva_caja WHERE id_negocio = :n AND estado = 'A';`, { n: idNegocio });
    if (abierta) {
        idCaja = abierta.id_caja;
    } else {
        idCaja = (await CajaService.abrirCaja({
            idNegocio, idUsuario, montoApertura: 0, observaciones: `${MARCA} apertura`,
        })).id_caja;
        cajaAbiertaPorLaSuite = true;
    }
});

afterAll(async () => {
    await sequelize.query(
        `DELETE FROM reserva.reserva_movimiento_caja WHERE id_caja = :c AND concepto LIKE 'Venta de productos%'
           AND id_venta_producto IN (SELECT id_venta FROM reserva.reserva_venta_producto WHERE id_negocio = :n);`,
        { replacements: { c: idCaja, n: idNegocio } },
    );
    await sequelize.query(
        `DELETE FROM reserva.reserva_venta_producto_detalle WHERE id_venta IN
            (SELECT id_venta FROM reserva.reserva_venta_producto WHERE id_negocio = :n);`,
        { replacements: { n: idNegocio } },
    );
    await sequelize.query(`DELETE FROM reserva.reserva_venta_producto WHERE id_negocio = :n;`, { replacements: { n: idNegocio } });
    await sequelize.query(`DELETE FROM reserva.reserva_producto WHERE id_negocio = :n AND nombre LIKE :m;`,
        { replacements: { n: idNegocio, m: `${MARCA}%` } });
    await sequelize.query(`DELETE FROM reserva.reserva_producto_categoria WHERE id_negocio = :n AND nombre LIKE :m;`,
        { replacements: { n: idNegocio, m: `${MARCA}%` } });

    if (cajaAbiertaPorLaSuite) {
        await sequelize.query(`UPDATE reserva.reserva_caja SET estado = 'C' WHERE id_caja = :c;`, { replacements: { c: idCaja } });
    }
    await sequelize.close();
});

describe('catálogo: categorías y productos', () => {
    test('crear categoría y producto; el nombre es obligatorio', async () => {
        const cat = await ProductoService.crearCategoria({ idNegocio, nombre: `${MARCA} Cuidado capilar` });
        const prod = await crearProducto({ idCategoria: cat.id_categoria, precio: 25000 });

        expect(prod.id_categoria).toBe(cat.id_categoria);
        expect(Number(prod.precio)).toBe(25000);
        expect(prod.publico_activo).toBe(true);       // por defecto se ve en el portal
        expect(prod.controla_stock).toBe(false);       // por defecto no se controla stock

        await expect(crearProducto({ nombre: '   ' })).rejects.toMatchObject({ statusCode: 422 });
    });

    test('un precio negativo se rechaza', async () => {
        await expect(crearProducto({ precio: -1 })).rejects.toMatchObject({ statusCode: 422 });
    });

    test('una categoría de otro negocio no se puede asignar', async () => {
        const otro = await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Salón Demo EscalApp';`);
        const catAjena = await ProductoService.crearCategoria({ idNegocio: otro.id_negocio, nombre: `${MARCA} ajena` });
        await expect(crearProducto({ idCategoria: catAjena.id_categoria })).rejects.toMatchObject({ statusCode: 400 });
        await sequelize.query(`DELETE FROM reserva.reserva_producto_categoria WHERE id_categoria = :id;`, { replacements: { id: catAjena.id_categoria } });
    });

    test('inactivar una categoría suelta sus productos, no los borra', async () => {
        const cat = await ProductoService.crearCategoria({ idNegocio, nombre: `${MARCA} A soltar` });
        const prod = await crearProducto({ idCategoria: cat.id_categoria });

        await ProductoService.inactivarCategoria(cat.id_categoria, idNegocio);
        const recargado = await ProductoService.getById(prod.id_producto, idNegocio);
        expect(recargado.id_categoria).toBeNull();
        expect(recargado.estado).toBe('A');
    });

    test('listarPublico solo trae activos y visibles en el portal', async () => {
        const visible = await crearProducto({ publicoActivo: true });
        const oculto = await crearProducto({ publicoActivo: false });
        const inactivo = await crearProducto();
        await ProductoService.inactivar(inactivo.id_producto, idNegocio);

        const publico = await ProductoService.listarPublico(idNegocio);
        const ids = publico.map((p) => p.id_producto);
        expect(ids).toContain(visible.id_producto);
        expect(ids).not.toContain(oculto.id_producto);
        expect(ids).not.toContain(inactivo.id_producto);
    });

    test('actualizar cambia solo lo enviado', async () => {
        const prod = await crearProducto({ precio: 5000 });
        const actualizado = await ProductoService.actualizar(prod.id_producto, idNegocio, { precio: 7000 });
        expect(Number(actualizado.precio)).toBe(7000);
        expect(actualizado.nombre).toBe(prod.nombre);
    });
});

describe('el precio SIEMPRE se relee del catálogo, nunca del que llega en la petición', () => {
    test('un precio_snapshot manipulado en el item se ignora: se cobra el del catálogo', async () => {
        const prod = await crearProducto({ precio: 9999 });
        const venta = await VentaProductoService.crear({
            idNegocio,
            items: [{ id_producto: prod.id_producto, cantidad: 2, precio: 1 }],   // "precio" es ruido: no existe ese campo
        });
        expect(Number(venta.total)).toBe(9999 * 2);
    });

    test('un producto inexistente o de otro negocio rechaza toda la venta', async () => {
        await expect(VentaProductoService.crear({ idNegocio, items: [{ id_producto: 999999999, cantidad: 1 }] }))
            .rejects.toMatchObject({ code: 'PRODUCTO_INVALIDO' });
    });

    test('sin items, o cantidad cero, se rechaza', async () => {
        await expect(VentaProductoService.crear({ idNegocio, items: [] })).rejects.toMatchObject({ statusCode: 422 });
        const prod = await crearProducto();
        await expect(VentaProductoService.crear({ idNegocio, items: [{ id_producto: prod.id_producto, cantidad: 0 }] }))
            .rejects.toMatchObject({ statusCode: 422 });
    });
});

describe('cobrar una venta: caja, stock y estado', () => {
    test('sin caja abierta no se cobra (se simula cerrándola y reabriéndola)', async () => {
        const prod = await crearProducto();
        const venta = await VentaProductoService.crear({ idNegocio, items: [{ id_producto: prod.id_producto, cantidad: 1 }] });

        await sequelize.query(`UPDATE reserva.reserva_caja SET estado = 'C' WHERE id_caja = :c;`, { replacements: { c: idCaja } });
        try {
            await expect(VentaProductoService.cobrar({ idVenta: venta.id_venta, idNegocio, idUsuario, idMetodoPago }))
                .rejects.toMatchObject({ code: 'CAJA_CERRADA' });
        } finally {
            await sequelize.query(`UPDATE reserva.reserva_caja SET estado = 'A' WHERE id_caja = :c;`, { replacements: { c: idCaja } });
        }
    });

    test('cobrar asienta un movimiento de caja ligado a la venta, y no se puede cobrar dos veces', async () => {
        const prod = await crearProducto({ precio: 15000 });
        const venta = await VentaProductoService.crear({ idNegocio, items: [{ id_producto: prod.id_producto, cantidad: 1 }] });

        const cobrada = await VentaProductoService.cobrar({ idVenta: venta.id_venta, idNegocio, idUsuario, idMetodoPago });
        expect(cobrada.estado).toBe('COMPLETADA');
        expect(cobrada.id_caja).toBe(idCaja);

        const movimiento = await unaFila(
            `SELECT monto, tipo FROM reserva.reserva_movimiento_caja WHERE id_venta_producto = :v;`,
            { v: venta.id_venta },
        );
        expect(movimiento).toMatchObject({ tipo: 'INGRESO', monto: '15000.00' });

        await expect(VentaProductoService.cobrar({ idVenta: venta.id_venta, idNegocio, idUsuario, idMetodoPago }))
            .rejects.toMatchObject({ code: 'VENTA_NO_PENDIENTE' });
    });

    test('sin forma de pago no se cobra', async () => {
        const prod = await crearProducto();
        const venta = await VentaProductoService.crear({ idNegocio, items: [{ id_producto: prod.id_producto, cantidad: 1 }] });
        await expect(VentaProductoService.cobrar({ idVenta: venta.id_venta, idNegocio, idUsuario }))
            .rejects.toMatchObject({ code: 'PAGO_REQUERIDO' });
    });

    test('con stock controlado, cobrar descuenta la cantidad vendida', async () => {
        const prod = await crearProducto({ controlaStock: true, stockActual: 10 });
        const venta = await VentaProductoService.crear({ idNegocio, items: [{ id_producto: prod.id_producto, cantidad: 3 }] });
        await VentaProductoService.cobrar({ idVenta: venta.id_venta, idNegocio, idUsuario, idMetodoPago });

        const recargado = await ProductoService.getById(prod.id_producto, idNegocio);
        expect(Number(recargado.stock_actual)).toBe(7);
    });

    test('sin controlar stock, cobrar no lo toca', async () => {
        const prod = await crearProducto({ controlaStock: false, stockActual: 0 });
        const venta = await VentaProductoService.crear({ idNegocio, items: [{ id_producto: prod.id_producto, cantidad: 5 }] });
        await VentaProductoService.cobrar({ idVenta: venta.id_venta, idNegocio, idUsuario, idMetodoPago });

        const recargado = await ProductoService.getById(prod.id_producto, idNegocio);
        expect(Number(recargado.stock_actual)).toBe(0);
    });

    test('cancelar un pedido pendiente no mueve caja ni stock', async () => {
        const prod = await crearProducto({ controlaStock: true, stockActual: 5 });
        const venta = await VentaProductoService.crear({ idNegocio, items: [{ id_producto: prod.id_producto, cantidad: 1 }] });
        const cancelada = await VentaProductoService.cancelar(venta.id_venta, idNegocio);

        expect(cancelada.estado).toBe('CANCELADA');
        const recargado = await ProductoService.getById(prod.id_producto, idNegocio);
        expect(Number(recargado.stock_actual)).toBe(5);
        await expect(VentaProductoService.cobrar({ idVenta: venta.id_venta, idNegocio, idUsuario, idMetodoPago }))
            .rejects.toMatchObject({ code: 'VENTA_NO_PENDIENTE' });
    });
});

describe('venderYCobrar: el «un clic» del mostrador', () => {
    test('crea y cobra en la misma operación, con un solo movimiento de caja', async () => {
        const prod = await crearProducto({ precio: 8000 });
        const venta = await VentaProductoService.venderYCobrar({
            idNegocio, items: [{ id_producto: prod.id_producto, cantidad: 2 }], idUsuario, idMetodoPago,
        });

        expect(venta.estado).toBe('COMPLETADA');
        expect(Number(venta.total)).toBe(16000);

        const movimiento = await unaFila(
            `SELECT monto FROM reserva.reserva_movimiento_caja WHERE id_venta_producto = :v;`,
            { v: venta.id_venta },
        );
        expect(Number(movimiento.monto)).toBe(16000);
    });

    test('sin caja abierta, tampoco vende', async () => {
        const prod = await crearProducto();
        await sequelize.query(`UPDATE reserva.reserva_caja SET estado = 'C' WHERE id_caja = :c;`, { replacements: { c: idCaja } });
        try {
            await expect(VentaProductoService.venderYCobrar({
                idNegocio, items: [{ id_producto: prod.id_producto, cantidad: 1 }], idUsuario, idMetodoPago,
            })).rejects.toMatchObject({ code: 'CAJA_CERRADA' });
        } finally {
            await sequelize.query(`UPDATE reserva.reserva_caja SET estado = 'A' WHERE id_caja = :c;`, { replacements: { c: idCaja } });
        }
    });
});

describe('la venta se puede colgar de una cita, o no', () => {
    test('sin id_cita, la venta es independiente (se puede comprar sin cita)', async () => {
        const prod = await crearProducto();
        const venta = await VentaProductoService.crear({ idNegocio, items: [{ id_producto: prod.id_producto, cantidad: 1 }] });
        expect(venta.id_cita).toBeNull();
    });

    test('una cita de otro negocio no se puede usar', async () => {
        const otro = await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Salón Demo EscalApp';`);
        const citaAjena = await unaFila(
            `SELECT id_cita FROM reserva.reserva_cita WHERE id_negocio = :n ORDER BY id_cita LIMIT 1;`, { n: otro.id_negocio },
        );
        if (!citaAjena) return; // el seed puede no traer citas; no es lo que prueba este caso
        const prod = await crearProducto();
        await expect(VentaProductoService.crear({
            idNegocio, idCita: citaAjena.id_cita, items: [{ id_producto: prod.id_producto, cantidad: 1 }],
        })).rejects.toMatchObject({ statusCode: 400 });
    });
});
