/**
 * Un pedido puede cobrarse en CERO, pero solo si un descuento se comió su valor.
 *
 * El caso que lo pidió es la cena de los empleados: el restaurante la registra como pedido
 * —para que descuente inventario y salga en el informe de consumo— y la descuenta entera
 * porque no la cobra. Antes eso era imposible: `registrarMovimiento` exigía monto > 0 y el
 * cobro moría con «El monto debe ser mayor a cero», así que la única salida era no tomar el
 * pedido, y entonces ni el inventario ni el informe se enteraban de esa comida.
 *
 * Lo que hay que sostener no es «se permite el cero», que sería demasiado: es «se permite el
 * cero **cuando viene de un descuento**». Un pedido vacío, o uno con los precios en cero, sigue
 * teniendo que rebotar — si no, un error de captura entra a caja como si fuera una venta.
 *
 * Corre contra la base de verdad, como el resto de suites de este repo: la regla vive en el
 * cruce entre la orden guardada y el movimiento de caja, y con dobles no se prueba ese cruce.
 * Necesita `Restaurante Demo` con carta y formas de pago (`node scripts/seed_dev_local.js`).
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
let idMetodoPago;
let idCaja;
let descuentoOriginal;

const ordenesCreadas = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

/** Un pedido de un solo producto, con el descuento que se le indique. */
async function crearPedido(descuento) {
    const orden = await pedidoService.crearOrden({
        idNegocio,
        idUsuario,
        idMesa: null,
        mesa: 'TEST-CERO',
        nota: 'test cobro en cero',
        tipoPedido: 'LLEVAR',
        items: [{ id_producto: idProducto, cantidad: 1, precio_unitario: precio, exclusiones: [] }],
        descuento,
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
        `SELECT id_negocio, permite_descuento FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`,
    );
    idNegocio = negocio?.id_negocio;
    descuentoOriginal = negocio?.permite_descuento;

    // El descuento es opt-in por negocio. Se enciende para la suite y se deja como estaba.
    await sequelize.query(
        `UPDATE general.gener_negocio SET permite_descuento = true WHERE id_negocio = :n;`,
        { replacements: { n: idNegocio } },
    );

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

    idMetodoPago = (await unaFila(
        `SELECT id_metodo_pago FROM restaurante.rest_metodo_pago
          WHERE id_negocio = :n AND estado = 'A' ORDER BY id_metodo_pago LIMIT 1;`,
        { n: idNegocio },
    ))?.id_metodo_pago;

    const abierta = await unaFila(
        `SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`,
        { n: idNegocio },
    );
    idCaja = abierta
        ? abierta.id_caja
        : (await cajaService.abrirCaja({
            idNegocio, idUsuario, montoApertura: 0, observaciones: 'test cobro en cero',
        })).id_caja;
});

afterAll(async () => {
    for (const idOrden of ordenesCreadas) await borrarOrden(idOrden);
    await sequelize.query(
        `DELETE FROM restaurante.rest_movimiento_caja WHERE id_caja = :c AND concepto LIKE 'test%';`,
        { replacements: { c: idCaja } },
    );
    await sequelize.query(
        `UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_caja = :c AND estado = 'A';`,
        { replacements: { c: idCaja } },
    );
    await sequelize.query(
        `UPDATE general.gener_negocio SET permite_descuento = :v WHERE id_negocio = :n;`,
        { replacements: { v: descuentoOriginal, n: idNegocio } },
    );
    await sequelize.close();
});

describe('pedido cobrado en cero por descuento', () => {
    it('el descuento puede igualar el valor del pedido y dejar el total en cero', async () => {
        const orden = await crearPedido(precio);

        expect(Number(orden.subtotal)).toBe(precio);
        expect(Number(orden.descuento)).toBe(precio);
        expect(Number(orden.total)).toBe(0);
    });

    it('se puede cerrar la orden aunque el total sea cero', async () => {
        const orden = await crearPedido(precio);

        const cerrada = await pedidoService.cerrarOrden(orden.id_orden, {
            idUsuario, idMetodoPago,
        });

        expect(cerrada.estado).toBe('CERRADA');
        expect(Number(cerrada.total)).toBe(0);
        expect(cerrada.id_caja).toBe(idCaja);
    });

    it('también se puede cobrar desde despacho, sin cerrar la orden', async () => {
        const orden = await crearPedido(precio);

        const pagada = await pedidoService.marcarPagado(orden.id_orden, { idMetodoPago });

        expect(pagada.estado_pago).toBe('pagado');
        expect(pagada.id_caja).toBe(idCaja);
    });

    // El movimiento de cero no mueve el arqueo, pero deja el pedido en el listado del turno.
    // Saltárselo lo haría desaparecer de la caja, que es justo donde el negocio quiere ver las
    // cenas que regaló.
    it('deja un INGRESO de cero en la caja, para que el pedido no desaparezca del turno', async () => {
        const orden = await crearPedido(precio);
        await pedidoService.cerrarOrden(orden.id_orden, { idUsuario, idMetodoPago });

        const movimientos = await sequelize.query(
            `SELECT tipo, monto FROM restaurante.rest_movimiento_caja WHERE id_orden = :o;`,
            { replacements: { o: orden.id_orden }, type: sequelize.QueryTypes.SELECT },
        );

        expect(movimientos).toHaveLength(1);
        expect(movimientos[0].tipo).toBe('INGRESO');
        expect(Number(movimientos[0].monto)).toBe(0);
    });

    it('se puede anular después: reversar un cero da un cero', async () => {
        const orden = await crearPedido(precio);
        await pedidoService.cerrarOrden(orden.id_orden, { idUsuario, idMetodoPago });

        // `anularOrdenCobrada` exige un subnivel concedido uno por uno, así que aquí se
        // ejercita el reverso del movimiento, que es lo que este cambio tocó.
        const [mov] = await sequelize.query(
            `SELECT id_movimiento, tipo, monto FROM restaurante.rest_movimiento_caja WHERE id_orden = :o;`,
            { replacements: { o: orden.id_orden }, type: sequelize.QueryTypes.SELECT },
        );

        await expect(cajaService.registrarMovimiento({
            idCaja,
            tipo: 'EGRESO',
            monto: mov.monto,
            concepto: `test anulación ${orden.numero_orden}`,
            idUsuario,
            idOrden: orden.id_orden,
            idMovimientoAnula: mov.id_movimiento,
            permitirCero: Number(mov.monto) === 0,
        })).resolves.toBeDefined();
    });
});

describe('lo que sigue estando prohibido', () => {
    it('un pedido en cero SIN descuento no se puede cobrar', async () => {
        const orden = await crearPedido(0);
        // Se fuerza el caso feo: precios a cero y ningún descuento. Es la forma en que un
        // error de captura llegaría a caja disfrazado de venta.
        await sequelize.query(
            `UPDATE restaurante.pedid_orden SET subtotal = 0, total = 0, descuento = 0 WHERE id_orden = :o;`,
            { replacements: { o: orden.id_orden } },
        );
        await sequelize.query(
            `UPDATE restaurante.pedid_detalle SET precio_unitario = 0, subtotal = 0 WHERE id_orden = :o;`,
            { replacements: { o: orden.id_orden } },
        );

        await expect(
            pedidoService.cerrarOrden(orden.id_orden, { idUsuario, idMetodoPago }),
        ).rejects.toMatchObject({ code: 'COBRO_CERO_SIN_DESCUENTO', statusCode: 422 });
    });

    it('un movimiento manual de cero pesos se sigue rechazando', async () => {
        await expect(cajaService.registrarMovimiento({
            idCaja,
            tipo: 'INGRESO',
            monto: 0,
            concepto: 'test manual en cero',
            idUsuario,
        })).rejects.toMatchObject({ statusCode: 422 });
    });

    it('un monto negativo se sigue rechazando, con o sin permiso de cero', async () => {
        for (const permitirCero of [false, true]) {
            await expect(cajaService.registrarMovimiento({
                idCaja,
                tipo: 'INGRESO',
                monto: -500,
                concepto: 'test negativo',
                idUsuario,
                permitirCero,
            })).rejects.toMatchObject({ statusCode: 422 });
        }
    });
});

describe('el pedido normal no cambia', () => {
    it('sin descuento se cobra igual que siempre', async () => {
        const orden = await crearPedido(0);

        const cerrada = await pedidoService.cerrarOrden(orden.id_orden, { idUsuario, idMetodoPago });

        expect(Number(cerrada.total)).toBe(precio);
        expect(cerrada.estado).toBe('CERRADA');
    });

    it('con descuento parcial el total baja pero no llega a cero', async () => {
        const rebaja = Math.round(precio / 2);
        const orden = await crearPedido(rebaja);

        const cerrada = await pedidoService.cerrarOrden(orden.id_orden, { idUsuario, idMetodoPago });

        expect(Number(cerrada.descuento)).toBe(rebaja);
        expect(Number(cerrada.total)).toBe(precio - rebaja);
    });
});
