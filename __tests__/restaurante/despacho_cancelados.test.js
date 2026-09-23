/**
 * Cancelar un pedido dejaba de verse en cuanto se cancelaba — bien para el empleado que lo
 * canceló él mismo desde Despacho, mal para uno que canceló EL CLIENTE por WhatsApp sin que
 * nadie del negocio hiciera nada: la orden se esfumaba sin dejar ningún rastro visible.
 *
 * Esta suite prueba las dos piezas que arreglan eso:
 *   1. `cancelado_por` distingue quién disparó la cancelación.
 *   2. `getOrdenesCanceladasRecientes` los saca de vuelta a la luz, acotado a HOY.
 *
 * Corre contra la base de verdad y necesita `Restaurante Demo` con carta
 * (`node scripts/seed_dev_local.js`).
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
let idCaja;
let cajaEraDeLaSuite = false;

const ordenesCreadas = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

async function borrarOrden(idOrden) {
    for (const sql of [
        'DELETE FROM restaurante.pedid_detalle WHERE id_orden = :o',
        'DELETE FROM restaurante.pedid_orden WHERE id_orden = :o',
    ]) {
        await sequelize.query(sql, { replacements: { o: idOrden } });
    }
}

async function crearPedido(tipoPedido) {
    const orden = await pedidoService.crearOrden({
        idNegocio,
        idUsuario,
        idMesa: null,
        mesa: tipoPedido === 'MESA' ? 'TEST-CANCEL' : undefined,
        nota: 'test cancelados',
        tipoPedido,
        items: [{ id_producto: idProducto, cantidad: 1, precio_unitario: 10000 }],
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

    idProducto = (await unaFila(
        `SELECT id_producto FROM restaurante.carta_producto
          WHERE id_negocio = :n AND estado = 'A' AND precio > 0 LIMIT 1;`,
        { n: idNegocio },
    ))?.id_producto;

    const abierta = await unaFila(
        `SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`,
        { n: idNegocio },
    );
    if (abierta) {
        idCaja = abierta.id_caja;
    } else {
        idCaja = (await cajaService.abrirCaja({
            idNegocio, idUsuario, montoApertura: 0, observaciones: 'test cancelados',
        })).id_caja;
        cajaEraDeLaSuite = true;
    }
});

afterAll(async () => {
    for (const idOrden of ordenesCreadas) await borrarOrden(idOrden);
    if (cajaEraDeLaSuite) {
        await sequelize.query(
            `UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_caja = :c AND estado = 'A';`,
            { replacements: { c: idCaja } },
        );
    }
    await sequelize.close();
});

describe('quién canceló queda escrito', () => {
    it('cancelarOrden (panel) marca cancelado_por = negocio', async () => {
        const orden = await crearPedido('LLEVAR');
        await pedidoService.cancelarOrden(orden.id_orden, { idUsuario });

        const fila = await unaFila(
            `SELECT estado, cancelado_por FROM restaurante.pedid_orden WHERE id_orden = :o;`,
            { o: orden.id_orden },
        );
        expect(fila.estado).toBe('CANCELADA');
        expect(fila.cancelado_por).toBe('negocio');
    });

    it('cancelarPorCliente (bot) marca cancelado_por = cliente', async () => {
        const orden = await crearPedido('DOMICILIO');
        await pedidoService.cancelarPorCliente(orden.id_orden, { idNegocio, transaction: null });

        const fila = await unaFila(
            `SELECT estado, cancelado_por FROM restaurante.pedid_orden WHERE id_orden = :o;`,
            { o: orden.id_orden },
        );
        expect(fila.estado).toBe('CANCELADA');
        expect(fila.cancelado_por).toBe('cliente');
    });
});

describe('getOrdenesCanceladasRecientes', () => {
    it('saca los cancelados de HOY, con quién los canceló', async () => {
        const orden = await crearPedido('DOMICILIO');
        await pedidoService.cancelarPorCliente(orden.id_orden, { idNegocio, transaction: null });

        const lista = await pedidoService.getOrdenesCanceladasRecientes({ idNegocio, idUsuario });
        const fila = lista.find((o) => o.id_orden === orden.id_orden);

        expect(fila).toBeDefined();
        expect(fila.cancelado_por).toBe('cliente');
        expect(fila.tipo_pedido).toBe('DOMICILIO');
    });

    it('uno de MESA no aparece: esto es para despacho, no para el salón', async () => {
        const orden = await crearPedido('MESA');
        await pedidoService.cancelarOrden(orden.id_orden, { idUsuario });

        const lista = await pedidoService.getOrdenesCanceladasRecientes({ idNegocio, idUsuario });
        expect(lista.some((o) => o.id_orden === orden.id_orden)).toBe(false);
    });

    it('uno cancelado AYER no aparece: esto avisa del turno, no es un historial', async () => {
        const orden = await crearPedido('LLEVAR');
        await pedidoService.cancelarOrden(orden.id_orden, { idUsuario });
        await sequelize.query(
            `UPDATE restaurante.pedid_orden
                SET fecha_cierre = now() - interval '1 day'
              WHERE id_orden = :o;`,
            { replacements: { o: orden.id_orden } },
        );

        const lista = await pedidoService.getOrdenesCanceladasRecientes({ idNegocio, idUsuario });
        expect(lista.some((o) => o.id_orden === orden.id_orden)).toBe(false);
    });

    it('uno todavía ABIERTO no aparece: esto es solo cancelados', async () => {
        const orden = await crearPedido('LLEVAR');

        const lista = await pedidoService.getOrdenesCanceladasRecientes({ idNegocio, idUsuario });
        expect(lista.some((o) => o.id_orden === orden.id_orden)).toBe(false);
    });
});
