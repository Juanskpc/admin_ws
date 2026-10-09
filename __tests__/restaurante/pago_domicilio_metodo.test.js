/**
 * De qué forma de pago sale el pago al domiciliario.
 *
 * El caso real (El Callejero, 2026-10): un pedido de 20.000 + 7.000 de domicilio cobrado por
 * transferencia. El cliente paga 27.000 al banco y el negocio le entrega al domiciliario
 * 7.000 EN EFECTIVO. El cuadre del turno decía otra cosa: el EGRESO del domicilio se ataba
 * solo al pedido, así que el desglose lo restaba de la MISMA forma de pago con la que pagó el
 * cliente y dejaba «Transferencia 20.000» con el cajón intacto. El negocio no podía cuadrar:
 * en el banco había 27.000 y en el cajón faltaban 7.000.
 *
 * Lo que estas pruebas sostienen:
 *  - con `gener_negocio.id_metodo_pago_domicilio` elegido, el egreso resta de ESA forma de
 *    pago y el ingreso suma completo a la del pedido;
 *  - sin elegir nada (NULL), el comportamiento es el de antes — nadie cambia por la migración;
 *  - el neto del turno es el mismo en los dos casos: esto reparte, no crea ni destruye plata.
 *
 * Corre contra la base de verdad: la regla vive en una consulta SQL de atribución, y con
 * dobles no se prueba lo único que importa. Necesita `Restaurante Demo` con carta y al menos
 * dos formas de pago (`node scripts/seed_dev_local.js`).
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const cajaService = require('../../app_restaurante_api/services/cajaService');

const sequelize = Models.sequelize;

const VALOR_DOMICILIO = 7000;

let idNegocio;
let idUsuario;
let idProducto;
let precio;
let idMetodoVenta;     // con el que paga el cliente (p. ej. Transferencia)
let idMetodoDomicilio; // de donde sale el pago al domiciliario (p. ej. Efectivo)
let idCaja;
let flagsOriginales;

const ordenesCreadas = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

/** De dónde sale el pago al domiciliario en este negocio, para el resto de la prueba. */
async function fijarMetodoDomicilio(idMetodo) {
    await sequelize.query(
        `UPDATE general.gener_negocio SET id_metodo_pago_domicilio = :m WHERE id_negocio = :n;`,
        { replacements: { m: idMetodo ?? null, n: idNegocio } },
    );
}

async function crearPedidoConDomicilio() {
    const orden = await pedidoService.crearOrden({
        idNegocio,
        idUsuario,
        idMesa: null,
        nota: 'test metodo domicilio',
        tipoPedido: 'DOMICILIO',
        contactoNombre: 'Cliente Test',
        direccionDomicilio: 'Calle de prueba 1',
        items: [{ id_producto: idProducto, cantidad: 1, precio_unitario: precio, exclusiones: [] }],
        valorDomicilio: VALOR_DOMICILIO,
    });
    ordenesCreadas.push(orden.id_orden);
    return orden;
}

/** Los movimientos que un pedido dejó en la caja, en orden de registro. */
function movimientosDe(idOrden) {
    return sequelize.query(
        `SELECT tipo, monto::numeric AS monto, id_metodo_pago
           FROM restaurante.rest_movimiento_caja
          WHERE id_orden = :o ORDER BY id_movimiento;`,
        { replacements: { o: idOrden }, type: sequelize.QueryTypes.SELECT },
    );
}

const totalDe = (desglose, idMetodo) =>
    Number(desglose.find((d) => Number(d.id_metodo_pago) === Number(idMetodo))?.total ?? 0);

const sumaDesglose = (desglose) => desglose.reduce((acc, d) => acc + Number(d.total ?? 0), 0);

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
        `SELECT id_negocio, permite_pago_domicilio, id_metodo_pago_domicilio
           FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`,
    );
    idNegocio = negocio?.id_negocio;
    flagsOriginales = {
        permite_pago_domicilio: negocio?.permite_pago_domicilio,
        id_metodo_pago_domicilio: negocio?.id_metodo_pago_domicilio ?? null,
    };

    // El cobro del domicilio es opt-in. Se enciende para la suite y se deja como estaba.
    await sequelize.query(
        `UPDATE general.gener_negocio SET permite_pago_domicilio = true WHERE id_negocio = :n;`,
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

    // Dos formas de pago distintas y que muevan el cajón: la de cuentas de cliente no sirve
    // ni para cobrar el pedido ni para pagar el domicilio.
    const metodos = await sequelize.query(
        `SELECT id_metodo_pago FROM restaurante.rest_metodo_pago
          WHERE id_negocio = :n AND estado = 'A' AND NOT es_cuenta
          ORDER BY id_metodo_pago LIMIT 2;`,
        { replacements: { n: idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
    idMetodoVenta = metodos[0]?.id_metodo_pago;
    idMetodoDomicilio = metodos[1]?.id_metodo_pago;

    const abierta = await unaFila(
        `SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`,
        { n: idNegocio },
    );
    idCaja = abierta
        ? abierta.id_caja
        : (await cajaService.abrirCaja({
            idNegocio, idUsuario, montoApertura: 0, observaciones: 'test metodo domicilio',
        })).id_caja;
});

afterAll(async () => {
    for (const idOrden of ordenesCreadas) await borrarOrden(idOrden);
    await sequelize.query(
        `UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_caja = :c AND estado = 'A';`,
        { replacements: { c: idCaja } },
    );
    await sequelize.query(
        `UPDATE general.gener_negocio
            SET permite_pago_domicilio = :f, id_metodo_pago_domicilio = :m
          WHERE id_negocio = :n;`,
        {
            replacements: {
                f: flagsOriginales.permite_pago_domicilio,
                m: flagsOriginales.id_metodo_pago_domicilio,
                n: idNegocio,
            },
        },
    );
    await sequelize.close();
});

describe('el negocio eligió de dónde sale el pago al domiciliario', () => {
    it('el egreso lleva esa forma de pago, no la del pedido', async () => {
        expect(idMetodoDomicilio).toBeDefined();
        await fijarMetodoDomicilio(idMetodoDomicilio);

        const orden = await crearPedidoConDomicilio();
        await pedidoService.cerrarOrden(orden.id_orden, { idUsuario, idMetodoPago: idMetodoVenta });

        const movs = await movimientosDe(orden.id_orden);
        expect(movs.map((m) => m.tipo)).toEqual(['INGRESO', 'EGRESO']);

        // El ingreso sigue sin forma de pago propia: la manda la orden, que es la única
        // verdad sobre con qué pagó el cliente.
        expect(movs[0].id_metodo_pago).toBeNull();
        expect(Number(movs[1].monto)).toBeCloseTo(VALOR_DOMICILIO, 2);
        expect(Number(movs[1].id_metodo_pago)).toBe(Number(idMetodoDomicilio));
    });

    it('el turno suma el total a la forma de pago del pedido y resta el domicilio de la elegida', async () => {
        await fijarMetodoDomicilio(idMetodoDomicilio);

        const antes = await cajaService.getDesglosePorMetodo(idCaja);

        const orden = await crearPedidoConDomicilio();
        const total = Number(orden.total);
        await pedidoService.cerrarOrden(orden.id_orden, { idUsuario, idMetodoPago: idMetodoVenta });

        const despues = await cajaService.getDesglosePorMetodo(idCaja);

        // Esto es lo que el negocio no podía ver antes: en el banco entró TODO (27.000) y del
        // cajón salieron los 7.000 del domiciliario.
        expect(totalDe(despues, idMetodoVenta) - totalDe(antes, idMetodoVenta))
            .toBeCloseTo(total, 2);
        expect(totalDe(despues, idMetodoDomicilio) - totalDe(antes, idMetodoDomicilio))
            .toBeCloseTo(-VALOR_DOMICILIO, 2);

        // Repartir no es crear: el neto del turno es la venta sin el domicilio, igual que antes.
        expect(sumaDesglose(despues) - sumaDesglose(antes))
            .toBeCloseTo(total - VALOR_DOMICILIO, 2);
    });
});

describe('sin elegir nada (NULL) nada cambia', () => {
    it('el egreso no lleva forma de pago y se resta de la del pedido, como siempre', async () => {
        await fijarMetodoDomicilio(null);

        const antes = await cajaService.getDesglosePorMetodo(idCaja);

        const orden = await crearPedidoConDomicilio();
        const total = Number(orden.total);
        await pedidoService.cerrarOrden(orden.id_orden, { idUsuario, idMetodoPago: idMetodoVenta });

        const movs = await movimientosDe(orden.id_orden);
        expect(movs.map((m) => m.id_metodo_pago)).toEqual([null, null]);

        const despues = await cajaService.getDesglosePorMetodo(idCaja);
        expect(totalDe(despues, idMetodoVenta) - totalDe(antes, idMetodoVenta))
            .toBeCloseTo(total - VALOR_DOMICILIO, 2);
        expect(totalDe(despues, idMetodoDomicilio) - totalDe(antes, idMetodoDomicilio))
            .toBeCloseTo(0, 2);
    });
});

describe('una configuración rancia no puede impedir un cobro', () => {
    it('si la forma de pago elegida ya no está activa, el egreso vuelve al comportamiento anterior', async () => {
        await fijarMetodoDomicilio(idMetodoDomicilio);
        await sequelize.query(
            `UPDATE restaurante.rest_metodo_pago SET estado = 'I' WHERE id_metodo_pago = :m;`,
            { replacements: { m: idMetodoDomicilio } },
        );

        try {
            const orden = await crearPedidoConDomicilio();
            await pedidoService.cerrarOrden(orden.id_orden, { idUsuario, idMetodoPago: idMetodoVenta });

            const movs = await movimientosDe(orden.id_orden);
            expect(movs.map((m) => m.tipo)).toEqual(['INGRESO', 'EGRESO']);
            expect(movs[1].id_metodo_pago).toBeNull();
        } finally {
            await sequelize.query(
                `UPDATE restaurante.rest_metodo_pago SET estado = 'A' WHERE id_metodo_pago = :m;`,
                { replacements: { m: idMetodoDomicilio } },
            );
        }
    });
});
