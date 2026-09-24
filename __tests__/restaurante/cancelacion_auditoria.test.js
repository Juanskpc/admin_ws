/**
 * Un pedido cancelado dejaba `auditoria.audit_dato.id_usuario` en NULL (la columna «Usuario» de
 * Auditoría mostraba «—»), mientras el resto de modificaciones sí guardaban quién.
 *
 * Causa: `cancelarOrden` hacía `orden.update(...)` FUERA de una transacción, y las GUC de actor
 * (`app.id_usuario`) que lee `fn_audit()` solo se fijan al abrir una. El camino del bot tenía el
 * otro hueco: la transacción del Policy Gate se abre fuera de un request (no hay JWT).
 *
 * Aquí se comprueba que TODO camino que cancela deja el actor:
 *   - panel/Despacho con request (contexto ALS del middleware) y sin él (idUsuario explícito),
 *   - bot: el usuario asistente del negocio.
 *
 * Corre contra la base de verdad y necesita `Restaurante Demo` con carta
 * (`node scripts/seed_dev_local.js`).
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const cajaService = require('../../app_restaurante_api/services/cajaService');
const usuarioAsistenteDao = require('../../app_core/dao/usuarioAsistenteDao');
const { auditContext } = require('../../app_core/middleware/auditContext');

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

async function crearPedido(tipoPedido) {
    const orden = await pedidoService.crearOrden({
        idNegocio, idUsuario, idMesa: null, nota: 'test cancelacion auditoria', tipoPedido,
        items: [{ id_producto: idProducto, cantidad: 1, precio_unitario: 10000 }],
    });
    ordenesCreadas.push(orden.id_orden);
    return orden;
}

/** La fila de auditoría de la cancelación de esa orden. */
function auditoriaDeCancelacion(idOrden) {
    return unaFila(
        `SELECT id_usuario, id_negocio FROM auditoria.audit_dato
          WHERE esquema = 'restaurante' AND tabla = 'pedid_orden' AND operacion = 'U'
            AND pk_registro::text = :o AND datos_despues->>'estado' = 'CANCELADA'
          ORDER BY id_audit DESC LIMIT 1;`,
        { o: String(idOrden) },
    );
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
            idNegocio, idUsuario, montoApertura: 0, observaciones: 'test cancelacion auditoria',
        })).id_caja;
        cajaEraDeLaSuite = true;
    }
});

afterAll(async () => {
    for (const idOrden of ordenesCreadas) {
        await sequelize.query('DELETE FROM restaurante.pedid_detalle WHERE id_orden = :o', { replacements: { o: idOrden } });
        await sequelize.query('DELETE FROM restaurante.pedid_orden WHERE id_orden = :o', { replacements: { o: idOrden } });
    }
    if (cajaEraDeLaSuite) {
        await sequelize.query(
            `UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_caja = :c AND estado = 'A';`,
            { replacements: { c: idCaja } },
        );
    }
    await sequelize.close();
});

describe('la cancelación deja quién la hizo en auditoría', () => {
    it('panel con request: el usuario del JWT', async () => {
        const orden = await crearPedido('LLEVAR');
        await new Promise((resolve, reject) => {
            auditContext({ usuario: { id_usuario: idUsuario }, ip: '127.0.0.1' }, {}, () => {
                pedidoService.cancelarOrden(orden.id_orden, { idUsuario }).then(resolve, reject);
            });
        });

        const audit = await auditoriaDeCancelacion(orden.id_orden);
        expect(audit).not.toBeNull();
        expect(audit.id_usuario).toBe(idUsuario);
        expect(audit.id_negocio).toBe(idNegocio);
    });

    it('sin request (idUsuario explícito): también queda', async () => {
        const orden = await crearPedido('DOMICILIO');
        await pedidoService.cancelarOrden(orden.id_orden, { idUsuario });

        const audit = await auditoriaDeCancelacion(orden.id_orden);
        expect(audit.id_usuario).toBe(idUsuario);
    });

    it('bot (cancelarPorCliente dentro de la transacción del Gate): el usuario asistente', async () => {
        const orden = await crearPedido('DOMICILIO');
        const idAsistente = await usuarioAsistenteDao.resolverOCrear(idNegocio);

        await sequelize.transaction(async (t) => {
            await pedidoService.cancelarPorCliente(orden.id_orden, { idNegocio, transaction: t });
        });

        const audit = await auditoriaDeCancelacion(orden.id_orden);
        expect(audit.id_usuario).toBe(idAsistente);
        expect(audit.id_usuario).not.toBe(idUsuario);
    });

    it('un dry-run del bot (rollback) no deja nada cancelado', async () => {
        const orden = await crearPedido('DOMICILIO');
        const t = await sequelize.transaction();
        await pedidoService.cancelarPorCliente(orden.id_orden, { idNegocio, transaction: t });
        await t.rollback();

        const fila = await unaFila('SELECT estado FROM restaurante.pedid_orden WHERE id_orden = :o', { o: orden.id_orden });
        expect(fila.estado).toBe('ABIERTA');
    });
});
