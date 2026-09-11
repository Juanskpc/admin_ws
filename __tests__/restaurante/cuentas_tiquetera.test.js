/**
 * Tiqueteras y fiado: que la plata no se cuente dos veces.
 *
 * Este módulo rompe una equivalencia en la que descansa todo lo demás: hasta ahora «pedido =
 * venta = plata en el cajón». Con una tiquetera el dinero entra un día y la comida sale otro,
 * y si eso se anota mal el fallo **no da error**: al cajero le falta plata en el cuadre todos
 * los días y nadie sabe por qué.
 *
 * Por eso lo que se prueba aquí no son los CRUD, es la contabilidad:
 *
 *   1. Vender una tiquetera mete plata en la caja y **no** es una venta de comida.
 *   2. Comer con la tiquetera **sí** es una venta de ese día y **no** mueve el arqueo.
 *   3. El saldo sale de sumar el libro, siempre, y no se puede gastar lo que no hay.
 *   4. Anular un pedido pagado con la cuenta le devuelve al cliente lo suyo.
 *   5. El fiado tiene un tope (el cupo) y se respeta.
 *
 * Necesita `npm run migrate:restaurante-cuentas`.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const cuentaService = require('../../app_restaurante_api/services/cuentaService');
const cajaService = require('../../app_restaurante_api/services/cajaService');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');

const sequelize = Models.sequelize;

/**
 * Margen amplio a propósito.
 *
 * Estas pruebas encadenan muchas consultas (abonar, crear la orden, cobrarla, releer el saldo) y
 * los 5 s por defecto de jest solo alcanzan contra la base LOCAL. Contra la compartida del VPS
 * cada consulta cuesta ~138 ms de túnel (medido, ver CLAUDE.md) y dos de ellas se pasaban — por
 * el transporte, no por el producto. Subirlo las deja válidas en las dos bases, que es lo que se
 * quiere de una prueba de contabilidad: que se pueda correr donde estén los datos.
 */
jest.setTimeout(60_000);

/**
 * El negocio NO se fija a mano.
 *
 * La base local y la compartida del VPS no tienen los mismos datos sembrados: en una el
 * «Restaurante Demo» tiene carta y en la otra está vacío. Una prueba que clave `id_negocio = 1`
 * pasa en una base y falla en la otra por un motivo que no tiene nada que ver con lo que prueba.
 * Se elige el primer restaurante que tenga lo que hace falta: carta, formas de pago y un usuario.
 */
let ID_NEGOCIO;

let idUsuario;
let idProducto;
let precioProducto;
let idMetodoEfectivo;
let idMetodoCuenta;
let idCaja;
/** Cómo estaba el interruptor de cuentas antes de la prueba, para dejarlo igual. */
let flagOriginal = false;
const cuentasCreadas = [];

/** Enciende o apaga las cuentas del negocio, con su forma de pago. */
async function encenderCuentas(activar) {
    await sequelize.query(
        `UPDATE general.gener_negocio SET permite_cuentas_cliente = :v WHERE id_negocio = :n`,
        { replacements: { v: activar, n: ID_NEGOCIO } },
    );
    await sequelize.query(
        `UPDATE restaurante.rest_metodo_pago SET estado = :e
          WHERE id_negocio = :n AND es_cuenta = true`,
        { replacements: { e: activar ? 'A' : 'I', n: ID_NEGOCIO } },
    );
}
const ordenesCreadas = [];

/** Ingresos menos egresos del turno: lo que el arqueo espera encontrar en el cajón. */
async function netoDeCaja(idCajaTurno) {
    const [fila] = await sequelize.query(
        `SELECT COALESCE(SUM(CASE WHEN tipo = 'INGRESO' THEN monto ELSE -monto END), 0)::numeric AS neto
           FROM restaurante.rest_movimiento_caja WHERE id_caja = :idCaja`,
        { replacements: { idCaja: idCajaTurno }, type: sequelize.QueryTypes.SELECT },
    );
    return Number(fila.neto);
}

/** Lo que los informes contarían como ventas de las órdenes de esta prueba. */
async function ventasDeOrdenes(ids) {
    if (!ids.length) return 0;
    const [fila] = await sequelize.query(
        `SELECT COALESCE(SUM(total), 0)::numeric AS ventas
           FROM restaurante.pedid_orden
          WHERE id_orden IN (:ids) AND estado <> 'ANULADA'`,
        { replacements: { ids }, type: sequelize.QueryTypes.SELECT },
    );
    return Number(fila.ventas);
}

/** Filas de permiso creadas para poder anular un pedido dentro de una prueba. */
let permisosTemporales = [];

async function concederSubnivelAnular() {
    const roles = await sequelize.query(
        `SELECT DISTINCT ur.id_rol FROM general.gener_usuario_rol ur
          WHERE ur.id_usuario = :u AND ur.id_negocio = :n AND ur.estado = 'A'`,
        { replacements: { u: idUsuario, n: ID_NEGOCIO }, type: sequelize.QueryTypes.SELECT },
    );
    const [nivel] = await sequelize.query(
        `SELECT nv.id_nivel FROM general.gener_nivel nv
           JOIN general.gener_negocio n ON n.id_negocio = :n
          WHERE nv.id_tipo_negocio = n.id_tipo_negocio AND nv.url = 'caja_eliminar_pedido'
          LIMIT 1`,
        { replacements: { n: ID_NEGOCIO }, type: sequelize.QueryTypes.SELECT },
    );
    if (!nivel) return;

    permisosTemporales = [];
    for (const { id_rol } of roles) {
        await sequelize.query(
            `INSERT INTO general.gener_nivel_negocio
                 (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
             VALUES (:n, :r, :nv, true, 'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (id_negocio, id_rol, id_nivel) DO UPDATE SET puede_ver = true`,
            { replacements: { n: ID_NEGOCIO, r: id_rol, nv: nivel.id_nivel } },
        );
        permisosTemporales.push({ id_rol, id_nivel: nivel.id_nivel });
    }
}

async function retirarSubnivelAnular() {
    for (const p of permisosTemporales) {
        await sequelize.query(
            `DELETE FROM general.gener_nivel_negocio
              WHERE id_negocio = :n AND id_rol = :r AND id_nivel = :nv`,
            { replacements: { n: ID_NEGOCIO, r: p.id_rol, nv: p.id_nivel } },
        );
    }
    permisosTemporales = [];
}

async function crearCuenta(nombre, extra = {}) {
    const cuenta = await cuentaService.crearCuenta({
        idNegocio: ID_NEGOCIO,
        nombre,
        ...extra,
    });
    cuentasCreadas.push(cuenta.id_cuenta);
    return cuenta;
}

async function crearOrdenDe(cantidad = 1) {
    const orden = await pedidoService.crearOrden({
        idNegocio: ID_NEGOCIO,
        idUsuario,
        idMesa: null,
        tipoPedido: 'LLEVAR',
        items: [{
            id_producto: idProducto,
            cantidad,
            precio_unitario: precioProducto,
            subtotal: precioProducto * cantidad,
        }],
        permitirStockNegativo: true,
    });
    ordenesCreadas.push(orden.id_orden);
    return orden;
}

beforeAll(async () => {
    const [negocio] = await sequelize.query(
        `SELECT n.id_negocio
           FROM general.gener_negocio n
          WHERE n.estado = 'A'
            AND n.id_tipo_negocio = (
                SELECT id_tipo_negocio FROM general.gener_tipo_negocio
                 WHERE estado = 'A' AND UPPER(nombre) LIKE '%RESTAURANTE%'
                 ORDER BY id_tipo_negocio LIMIT 1
            )
            AND EXISTS (SELECT 1 FROM restaurante.carta_producto p
                         WHERE p.id_negocio = n.id_negocio AND p.estado = 'A')
            AND EXISTS (SELECT 1 FROM restaurante.rest_metodo_pago m
                         WHERE m.id_negocio = n.id_negocio AND m.estado = 'A' AND NOT m.es_cuenta)
            -- Sin exigir que esté activa: las cuentas son opt-in y la prueba las enciende.
            AND EXISTS (SELECT 1 FROM restaurante.rest_metodo_pago m
                         WHERE m.id_negocio = n.id_negocio AND m.es_cuenta)
            AND EXISTS (SELECT 1 FROM general.gener_usuario_rol ur
                         WHERE ur.id_negocio = n.id_negocio AND ur.estado = 'A')
          ORDER BY n.id_negocio
          LIMIT 1`,
        { type: sequelize.QueryTypes.SELECT },
    );
    if (!negocio) {
        throw new Error(
            'No hay ningún restaurante con carta, formas de pago y usuarios en esta base. ' +
            'Ejecuta las migraciones y el seed antes (ver docs/desarrollo-local.md).',
        );
    }
    ID_NEGOCIO = Number(negocio.id_negocio);

    const [usuario] = await sequelize.query(
        `SELECT ur.id_usuario FROM general.gener_usuario_rol ur
          WHERE ur.id_negocio = :n AND ur.estado = 'A' LIMIT 1`,
        { replacements: { n: ID_NEGOCIO }, type: sequelize.QueryTypes.SELECT },
    );
    idUsuario = usuario.id_usuario;

    const [producto] = await sequelize.query(
        `SELECT id_producto, precio::numeric AS precio FROM restaurante.carta_producto
          WHERE id_negocio = :n AND estado = 'A' ORDER BY id_producto LIMIT 1`,
        { replacements: { n: ID_NEGOCIO }, type: sequelize.QueryTypes.SELECT },
    );
    idProducto = producto.id_producto;
    precioProducto = Number(producto.precio);

    // Las cuentas de cliente son opt-in por negocio: nacen apagadas para no aparecerle a
    // nadie que no las pidió. La prueba las enciende y lo deja como estaba al terminar —
    // encenderlas es además lo que activa su forma de pago.
    [{ permite_cuentas_cliente: flagOriginal }] = await sequelize.query(
        `SELECT permite_cuentas_cliente FROM general.gener_negocio WHERE id_negocio = :n`,
        { replacements: { n: ID_NEGOCIO }, type: sequelize.QueryTypes.SELECT },
    );
    await encenderCuentas(true);

    const metodoCuenta = await cuentaService.getMetodoPagoCuenta(ID_NEGOCIO);
    idMetodoCuenta = metodoCuenta.id_metodo_pago;

    const [efectivo] = await sequelize.query(
        `SELECT id_metodo_pago FROM restaurante.rest_metodo_pago
          WHERE id_negocio = :n AND estado = 'A' AND es_cuenta = false ORDER BY id_metodo_pago LIMIT 1`,
        { replacements: { n: ID_NEGOCIO }, type: sequelize.QueryTypes.SELECT },
    );
    idMetodoEfectivo = efectivo.id_metodo_pago;

    // Turno propio para la prueba: el arqueo se mide sobre él.
    const abierta = await cajaService.getCajaAbierta(ID_NEGOCIO);
    if (abierta) {
        idCaja = abierta.id_caja;
    } else {
        const caja = await cajaService.abrirCaja({
            idNegocio: ID_NEGOCIO, idUsuario, montoApertura: 0, observaciones: 'test tiquetera',
        });
        idCaja = caja.id_caja;
    }
});

afterAll(async () => {
    if (ID_NEGOCIO) await encenderCuentas(flagOriginal);

    // Se limpia en orden inverso a las dependencias.
    if (ordenesCreadas.length) {
        await sequelize.query(
            `DELETE FROM restaurante.rest_cuenta_movimiento WHERE id_orden IN (:ids)`,
            { replacements: { ids: ordenesCreadas } },
        );
        await sequelize.query(
            `DELETE FROM restaurante.rest_movimiento_caja WHERE id_orden IN (:ids)`,
            { replacements: { ids: ordenesCreadas } },
        );
        await sequelize.query(`DELETE FROM restaurante.rest_pago_orden WHERE id_orden IN (:ids)`,
            { replacements: { ids: ordenesCreadas } });
        await sequelize.query(`DELETE FROM restaurante.pedid_detalle WHERE id_orden IN (:ids)`,
            { replacements: { ids: ordenesCreadas } });
        await sequelize.query(`DELETE FROM restaurante.pedid_orden WHERE id_orden IN (:ids)`,
            { replacements: { ids: ordenesCreadas } });
    }
    if (cuentasCreadas.length) {
        await sequelize.query(
            `DELETE FROM restaurante.rest_cuenta_movimiento WHERE id_cuenta IN (:ids)`,
            { replacements: { ids: cuentasCreadas } },
        );
        const personas = await sequelize.query(
            `SELECT id_persona_negocio FROM restaurante.rest_cuenta WHERE id_cuenta IN (:ids)`,
            { replacements: { ids: cuentasCreadas }, type: sequelize.QueryTypes.SELECT },
        );
        await sequelize.query(`DELETE FROM restaurante.rest_cuenta WHERE id_cuenta IN (:ids)`,
            { replacements: { ids: cuentasCreadas } });
        if (personas.length) {
            await sequelize.query(
                `DELETE FROM platform.persona_negocio WHERE id_persona_negocio IN (:ids)`,
                { replacements: { ids: personas.map((p) => p.id_persona_negocio) } },
            );
        }
    }
    if (idCaja) {
        await sequelize.query(
            `DELETE FROM restaurante.rest_movimiento_caja
              WHERE id_caja = :idCaja AND concepto LIKE '%tiquetera-test%'`,
            { replacements: { idCaja } },
        );
    }
});

describe('el módulo está apagado mientras el negocio no lo encienda', () => {
    /**
     * Es lo que permite desplegar esto sin que le aparezca a nadie que no lo pidió. Si algún
     * día alguien cambia el valor por defecto de la columna, esta prueba lo caza: un cliente
     * que no pidió tiqueteras se encontraría un menú nuevo y una forma de pago nueva en el
     * cobro, y el primero que la eligiera sin saber quedaría atascado.
     */
    test('apagado, la forma de pago de cuenta no existe para el cobro', async () => {
        await encenderCuentas(false);
        try {
            // El listado de formas de pago filtra por estado: el POS ni la ve.
            const visibles = await sequelize.query(
                `SELECT nombre FROM restaurante.rest_metodo_pago
                  WHERE id_negocio = :n AND estado = 'A' AND es_cuenta = true`,
                { replacements: { n: ID_NEGOCIO }, type: sequelize.QueryTypes.SELECT },
            );
            expect(visibles).toHaveLength(0);
            expect(await cuentaService.getMetodoPagoCuenta(ID_NEGOCIO)).toBeNull();
        } finally {
            await encenderCuentas(true);
        }
    });

    test('encenderlo la hace aparecer, y apagarlo NO borra los saldos', async () => {
        const cuenta = await crearCuenta('Cliente Apagado tiquetera-test');
        await cuentaService.registrarAbono({
            idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta, idUsuario,
            idMetodoPago: idMetodoEfectivo, monto: 30000, concepto: 'tiquetera-test apagado',
        });

        await encenderCuentas(false);
        await encenderCuentas(true);

        // Volver a encenderlo devuelve al cliente lo que tenía: apagar esconde, no borra.
        const despues = await cuentaService.getCuenta({ idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta });
        expect(despues.saldo).toBe(30000);
    });
});

describe('la plata no se cuenta dos veces', () => {
    test('vender una tiquetera mete plata en la caja pero NO es una venta de comida', async () => {
        const cuenta = await crearCuenta('Cliente Prepago tiquetera-test');
        const netoAntes = await netoDeCaja(idCaja);
        const ordenesAntes = await sequelize.query(
            `SELECT COUNT(*)::int AS n FROM restaurante.pedid_orden WHERE id_negocio = :n AND id_caja = :c`,
            { replacements: { n: ID_NEGOCIO, c: idCaja }, type: sequelize.QueryTypes.SELECT },
        );

        await cuentaService.registrarAbono({
            idNegocio: ID_NEGOCIO,
            idCuenta: cuenta.id_cuenta,
            idUsuario,
            idMetodoPago: idMetodoEfectivo,
            monto: 100000,
            concepto: 'tiquetera-test venta',
        });

        // Entró plata de verdad.
        expect(await netoDeCaja(idCaja)).toBeCloseTo(netoAntes + 100000, 2);

        // Y NO se creó ningún pedido: si lo creara, el informe del día mostraría una venta de
        // comida de $100.000 que nadie se comió.
        const ordenesDespues = await sequelize.query(
            `SELECT COUNT(*)::int AS n FROM restaurante.pedid_orden WHERE id_negocio = :n AND id_caja = :c`,
            { replacements: { n: ID_NEGOCIO, c: idCaja }, type: sequelize.QueryTypes.SELECT },
        );
        expect(ordenesDespues[0].n).toBe(ordenesAntes[0].n);

        const actualizada = await cuentaService.getCuenta({ idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta });
        expect(actualizada.saldo).toBe(100000);
    });

    test('comer con la tiquetera SÍ es venta del día y NO mueve el arqueo', async () => {
        const cuenta = await crearCuenta('Cliente Come tiquetera-test');
        await cuentaService.registrarAbono({
            idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta, idUsuario,
            idMetodoPago: idMetodoEfectivo, monto: 100000, concepto: 'tiquetera-test venta',
        });

        const netoAntes = await netoDeCaja(idCaja);
        const orden = await crearOrdenDe(1);

        await pedidoService.cerrarOrden(orden.id_orden, {
            idUsuario,
            idMetodoPago: idMetodoCuenta,
            idCuenta: cuenta.id_cuenta,
        });

        // El cajón no espera esa plata: ya entró cuando se vendió la tiquetera.
        expect(await netoDeCaja(idCaja)).toBeCloseTo(netoAntes, 2);

        // Pero la comida sí se vendió hoy.
        expect(await ventasDeOrdenes([orden.id_orden])).toBeCloseTo(precioProducto, 2);

        // Y al cliente se le descontó de su saldo.
        const despues = await cuentaService.getCuenta({ idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta });
        expect(despues.saldo).toBeCloseTo(100000 - precioProducto, 2);
    });

    test('el pedido pagado con la cuenta sigue apareciendo en el turno', async () => {
        const cuenta = await crearCuenta('Cliente Visible tiquetera-test');
        await cuentaService.registrarAbono({
            idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta, idUsuario,
            idMetodoPago: idMetodoEfectivo, monto: 100000, concepto: 'tiquetera-test venta',
        });
        const orden = await crearOrdenDe(1);
        await pedidoService.cerrarOrden(orden.id_orden, {
            idUsuario, idMetodoPago: idMetodoCuenta, idCuenta: cuenta.id_cuenta,
        });

        // Desaparecer del turno sería peor que descuadrar: el negocio no vería lo que sirvió.
        const movs = await sequelize.query(
            `SELECT tipo, monto::numeric AS monto FROM restaurante.rest_movimiento_caja
              WHERE id_orden = :idOrden ORDER BY id_movimiento`,
            { replacements: { idOrden: orden.id_orden }, type: sequelize.QueryTypes.SELECT },
        );
        expect(movs.map((m) => m.tipo)).toEqual(['INGRESO', 'EGRESO']);
        expect(Number(movs[0].monto)).toBeCloseTo(precioProducto, 2);
        expect(Number(movs[1].monto)).toBeCloseTo(precioProducto, 2);
    });
});

describe('el saldo manda', () => {
    test('no se puede gastar lo que no hay', async () => {
        const cuenta = await crearCuenta('Cliente Pelado tiquetera-test');
        const orden = await crearOrdenDe(1);

        await expect(
            pedidoService.cerrarOrden(orden.id_orden, {
                idUsuario, idMetodoPago: idMetodoCuenta, idCuenta: cuenta.id_cuenta,
            }),
        ).rejects.toMatchObject({ code: 'CUENTA_SIN_SALDO' });
    });

    test('pagar con la cuenta sin decir de quién es se rechaza', async () => {
        const orden = await crearOrdenDe(1);
        await expect(
            pedidoService.cerrarOrden(orden.id_orden, { idUsuario, idMetodoPago: idMetodoCuenta }),
        ).rejects.toMatchObject({ code: 'CUENTA_REQUERIDA' });
    });

    test('el fiado llega hasta el cupo y ni un peso más', async () => {
        const cupo = precioProducto + 1000;
        const cuenta = await crearCuenta('Cliente Fiado tiquetera-test', { cupo });

        // Primer pedido: cabe en el cupo y deja el saldo en negativo (debe).
        const primera = await crearOrdenDe(1);
        await pedidoService.cerrarOrden(primera.id_orden, {
            idUsuario, idMetodoPago: idMetodoCuenta, idCuenta: cuenta.id_cuenta,
        });

        const despues = await cuentaService.getCuenta({ idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta });
        expect(despues.saldo).toBeCloseTo(-precioProducto, 2);

        // Segundo pedido: ya no cabe.
        const segunda = await crearOrdenDe(1);
        await expect(
            pedidoService.cerrarOrden(segunda.id_orden, {
                idUsuario, idMetodoPago: idMetodoCuenta, idCuenta: cuenta.id_cuenta,
            }),
        ).rejects.toMatchObject({ code: 'CUENTA_SIN_SALDO' });
    });

    test('pagar la deuda a fin de mes deja el saldo en cero', async () => {
        const cuenta = await crearCuenta('Cliente Paga tiquetera-test', { cupo: precioProducto * 3 });
        const orden = await crearOrdenDe(1);
        await pedidoService.cerrarOrden(orden.id_orden, {
            idUsuario, idMetodoPago: idMetodoCuenta, idCuenta: cuenta.id_cuenta,
        });

        const netoAntes = await netoDeCaja(idCaja);
        await cuentaService.registrarAbono({
            idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta, idUsuario,
            idMetodoPago: idMetodoEfectivo, monto: precioProducto, concepto: 'tiquetera-test pago mes',
        });

        // Ahora SÍ entra la plata al cajón, y no es una venta de hoy.
        expect(await netoDeCaja(idCaja)).toBeCloseTo(netoAntes + precioProducto, 2);
        const saldada = await cuentaService.getCuenta({ idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta });
        expect(saldada.saldo).toBeCloseTo(0, 2);
    });
});

describe('tiquetes contados', () => {
    test('se compran 20, se come 1, quedan 19', async () => {
        const cuenta = await crearCuenta('Cliente Tiquetes tiquetera-test', { modo: 'TIQUETES' });
        await cuentaService.registrarAbono({
            idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta, idUsuario,
            idMetodoPago: idMetodoEfectivo,
            monto: precioProducto * 18, // el negocio hace descuento por el mes entero
            tiquetes: 20,
            idProducto,
            concepto: 'tiquetera-test 20 almuerzos',
        });

        const conTiquetes = await cuentaService.getCuenta({ idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta });
        expect(conTiquetes.tiquetes[0].disponibles).toBe(20);
        // El saldo en pesos es CERO: lo que tiene son tiquetes, y el dinero ya está en la caja.
        expect(conTiquetes.saldo).toBe(0);

        const netoAntes = await netoDeCaja(idCaja);
        const orden = await crearOrdenDe(1);
        await pedidoService.cerrarOrden(orden.id_orden, {
            idUsuario, idMetodoPago: idMetodoCuenta, idCuenta: cuenta.id_cuenta,
        });

        expect(await netoDeCaja(idCaja)).toBeCloseTo(netoAntes, 2);
        const despues = await cuentaService.getCuenta({ idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta });
        expect(despues.tiquetes[0].disponibles).toBe(19);
    });

    test('sin tiquetes no se puede comer, aunque la cuenta exista', async () => {
        const cuenta = await crearCuenta('Cliente SinTiquetes tiquetera-test', { modo: 'TIQUETES' });
        const orden = await crearOrdenDe(1);
        await expect(
            pedidoService.cerrarOrden(orden.id_orden, {
                idUsuario, idMetodoPago: idMetodoCuenta, idCuenta: cuenta.id_cuenta,
            }),
        ).rejects.toMatchObject({ code: 'CUENTA_SIN_SALDO' });
    });

    test('cambiar de modo con saldo vivo se rechaza: dejaría tiquetes varados', async () => {
        const cuenta = await crearCuenta('Cliente Cambia tiquetera-test', { modo: 'TIQUETES' });
        await cuentaService.registrarAbono({
            idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta, idUsuario,
            idMetodoPago: idMetodoEfectivo, monto: 50000, tiquetes: 5, idProducto,
            concepto: 'tiquetera-test 5',
        });

        await expect(
            cuentaService.actualizarCuenta({
                idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta, modo: 'DINERO',
            }),
        ).rejects.toMatchObject({ code: 'CUENTA_CON_SALDO' });
    });
});

describe('deshacer', () => {
    test('anular un pedido pagado con la cuenta le devuelve al cliente lo suyo', async () => {
        const cuenta = await crearCuenta('Cliente Anula tiquetera-test');
        await cuentaService.registrarAbono({
            idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta, idUsuario,
            idMetodoPago: idMetodoEfectivo, monto: 100000, concepto: 'tiquetera-test venta',
        });

        const orden = await crearOrdenDe(1);
        await pedidoService.cerrarOrden(orden.id_orden, {
            idUsuario, idMetodoPago: idMetodoCuenta, idCuenta: cuenta.id_cuenta,
        });

        const gastado = await cuentaService.getCuenta({ idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta });
        expect(gastado.saldo).toBeCloseTo(100000 - precioProducto, 2);

        // Anular un pedido cobrado exige el subnivel `caja_eliminar_pedido`, que no se hereda
        // por ser administrador. Se concede para esta prueba y se retira al terminar: lo que
        // se está probando es la devolución de la tiquetera, no el permiso.
        await concederSubnivelAnular();
        try {
            await cajaService.anularOrdenCobrada({
                idNegocio: ID_NEGOCIO, idOrden: orden.id_orden, idUsuario,
            });
        } finally {
            await retirarSubnivelAnular();
        }

        // Sin esto, anular el pedido le quitaba al cliente la comida Y el almuerzo pagado.
        const devuelto = await cuentaService.getCuenta({ idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta });
        expect(devuelto.saldo).toBeCloseTo(100000, 2);
    });

    test('un ajuste exige motivo escrito', async () => {
        const cuenta = await crearCuenta('Cliente Ajuste tiquetera-test');
        await expect(
            cuentaService.registrarAjuste({
                idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta, idUsuario,
                tipo: 'ABONO', monto: 10000, concepto: '   ',
            }),
        ).rejects.toMatchObject({ code: 'CONCEPTO_REQUERIDO' });
    });

    test('un abono no se puede pagar con la propia cuenta', async () => {
        const cuenta = await crearCuenta('Cliente Circular tiquetera-test');
        await expect(
            cuentaService.registrarAbono({
                idNegocio: ID_NEGOCIO, idCuenta: cuenta.id_cuenta, idUsuario,
                idMetodoPago: idMetodoCuenta, monto: 50000,
            }),
        ).rejects.toMatchObject({ code: 'METODO_PAGO_INVALIDO' });
    });
});
