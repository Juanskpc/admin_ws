/**
 * Confirmar los pedidos que toma el asistente de WhatsApp.
 *
 * Un pedido del bot nace «sin confirmar» (`pendiente_confirmar` en Despacho) hasta que una
 * persona del negocio lo da por visto con `POST /despacho/:id/confirmar`. Cubre:
 *   · la bandera derivada en `getOrdenesDespacho`;
 *   · que confirmar sea idempotente (dos tablets a la vez) y conserve el PRIMER instante;
 *   · que un pedido tomado por una persona no se pueda «confirmar»;
 *   · que crear un pedido con `deAsistente` emita el tema `whatsapp` solo si la transacción
 *     confirma (el dry-run del Policy Gate no debe hacer sonar nada).
 *
 * Corre contra la base de verdad y necesita `Restaurante Demo` con el asistente forzado.
 */
'use strict';

require('dotenv').config();
process.env.FEATURES_FORZADAS = 'asistente_ia';

const Models = require('../../app_core/models/conection');
const realtime = require('../../app_core/realtime');
const puntoCajaService = require('../../app_restaurante_api/services/puntoCajaService');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const usuarioAsistenteDao = require('../../app_core/dao/usuarioAsistenteDao');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuarioAsistente;
let idUsuarioPersona;
let habiaCajaAbierta;
let idCategoriaPrueba;
let idProductoPrueba;

const ordenesCreadas = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

async function crearOrden(numero, idUsuario, confirmadoEn = null) {
    const { id_punto_caja: idPunto } = await puntoCajaService.resolverPuntoCaja({ idNegocio });
    const orden = await unaFila(
        `INSERT INTO restaurante.pedid_orden
            (id_negocio, id_punto_caja, id_usuario, numero_orden, tipo_pedido, estado, contacto_nombre,
             contacto_telefono, id_domiciliario, total, confirmado_en)
         VALUES (:n, :p, :u, :num, 'LLEVAR', 'ABIERTA', 'BOT Cliente Confirmar', '+573000000098', :u, 15000, :c)
         RETURNING id_orden;`,
        { n: idNegocio, p: idPunto, u: idUsuario, num: numero, c: confirmadoEn },
    );
    ordenesCreadas.push(orden.id_orden);
    return orden.id_orden;
}

async function delDespacho(idOrden) {
    // `id_domiciliario` = autor, para que se vea sin importar el permiso «ver todos».
    const lista = await pedidoService.getOrdenesDespacho({ idNegocio, idUsuario: idUsuarioAsistente });
    return lista.find((o) => o.id_orden === idOrden);
}

beforeAll(async () => {
    idNegocio = (await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`,
    ))?.id_negocio;
    idUsuarioAsistente = await usuarioAsistenteDao.resolverOCrear(idNegocio);
    habiaCajaAbierta = Boolean(await unaFila(
        `SELECT 1 AS x FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A';`, { n: idNegocio },
    ));
    // Producto propio: Restaurante Demo puede no tener carta, y el test no debe depender de eso.
    idCategoriaPrueba = (await unaFila(
        `INSERT INTO restaurante.carta_categoria (id_negocio, nombre) VALUES (:n, 'TEST confirmacion') RETURNING id_categoria;`,
        { n: idNegocio },
    )).id_categoria;
    idProductoPrueba = (await unaFila(
        `INSERT INTO restaurante.carta_producto (id_negocio, id_categoria, nombre, precio)
         VALUES (:n, :c, 'TEST plato', 15000) RETURNING id_producto;`,
        { n: idNegocio, c: idCategoriaPrueba },
    )).id_producto;
    idUsuarioPersona = (await unaFila(
        `SELECT nu.id_usuario FROM general.gener_negocio_usuario nu
           JOIN general.gener_usuario u ON u.id_usuario = nu.id_usuario
          WHERE nu.id_negocio = :n AND nu.estado = 'A' AND ${usuarioAsistenteDao.sqlSinAsistente('u')}
          LIMIT 1;`,
        { n: idNegocio },
    )).id_usuario;
});

afterAll(async () => {
    for (const idOrden of ordenesCreadas) {
        await sequelize.query('DELETE FROM restaurante.pedid_detalle WHERE id_orden = :o;', { replacements: { o: idOrden } });
        await sequelize.query('DELETE FROM restaurante.pedid_orden WHERE id_orden = :o;', {
            replacements: { o: idOrden },
        });
    }
    await sequelize.query('DELETE FROM restaurante.carta_producto WHERE id_producto = :p;', { replacements: { p: idProductoPrueba } });
    await sequelize.query('DELETE FROM restaurante.carta_categoria WHERE id_categoria = :c;', { replacements: { c: idCategoriaPrueba } });
    // Los tests de la señal abren la caja si no lo estaba; se deja como se encontró.
    if (!habiaCajaAbierta) {
        await sequelize.query(`UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_negocio = :n AND estado = 'A';`, {
            replacements: { n: idNegocio },
        });
    }
    await sequelize.close();
});

describe('pendiente_confirmar en Despacho', () => {
    it('un pedido del bot sin confirmar sale como pendiente', async () => {
        const id = await crearOrden('ORD-9901', idUsuarioAsistente);
        const orden = await delDespacho(id);
        expect(orden.de_whatsapp).toBe(true);
        expect(orden.pendiente_confirmar).toBe(true);
    });

    it('uno del bot ya confirmado deja de estar pendiente', async () => {
        const id = await crearOrden('ORD-9902', idUsuarioAsistente, new Date());
        const orden = await delDespacho(id);
        expect(orden.pendiente_confirmar).toBe(false);
    });

    it('uno tomado por una persona nunca es pendiente, aunque no tenga marca', async () => {
        const id = await crearOrden('ORD-9903', idUsuarioPersona);
        const orden = (await pedidoService.getOrdenesDespacho({ idNegocio, idUsuario: idUsuarioPersona }))
            .find((o) => o.id_orden === id);
        expect(orden.de_whatsapp).toBe(false);
        expect(orden.pendiente_confirmar).toBe(false);
    });
});

describe('confirmarPedidoAsistente', () => {
    it('confirma, deja el instante y ya no está pendiente', async () => {
        const id = await crearOrden('ORD-9904', idUsuarioAsistente);
        const r = await pedidoService.confirmarPedidoAsistente({
            idNegocio, idOrden: id, idUsuario: idUsuarioPersona,
        });
        expect(r.ya_confirmado).toBe(false);
        expect(r.confirmado_en).toBeInstanceOf(Date);
        expect((await delDespacho(id)).pendiente_confirmar).toBe(false);
    });

    it('es idempotente y conserva el instante de la primera confirmación', async () => {
        const id = await crearOrden('ORD-9905', idUsuarioAsistente);
        const primera = await pedidoService.confirmarPedidoAsistente({
            idNegocio, idOrden: id, idUsuario: idUsuarioPersona,
        });
        const segunda = await pedidoService.confirmarPedidoAsistente({
            idNegocio, idOrden: id, idUsuario: idUsuarioPersona,
        });
        expect(segunda.ya_confirmado).toBe(true);
        expect(segunda.confirmado_en.getTime()).toBe(primera.confirmado_en.getTime());
    });

    it('rechaza un pedido que tomó una persona', async () => {
        const id = await crearOrden('ORD-9906', idUsuarioPersona);
        await expect(
            pedidoService.confirmarPedidoAsistente({ idNegocio, idOrden: id, idUsuario: idUsuarioPersona }),
        ).rejects.toMatchObject({ code: 'PEDIDO_NO_ES_DE_WHATSAPP', statusCode: 409 });
    });

    it('rechaza un pedido de otro negocio (404, no lo confirma)', async () => {
        const id = await crearOrden('ORD-9907', idUsuarioAsistente);
        await expect(
            pedidoService.confirmarPedidoAsistente({
                idNegocio: idNegocio + 100000, idOrden: id, idUsuario: idUsuarioPersona,
            }),
        ).rejects.toMatchObject({ code: 'PEDIDO_NO_ENCONTRADO', statusCode: 404 });
        expect((await delDespacho(id)).pendiente_confirmar).toBe(true);
    });

    it('rechaza uno que ya no está abierto', async () => {
        const id = await crearOrden('ORD-9908', idUsuarioAsistente);
        await sequelize.query(`UPDATE restaurante.pedid_orden SET estado = 'CANCELADA' WHERE id_orden = :o;`, {
            replacements: { o: id },
        });
        await expect(
            pedidoService.confirmarPedidoAsistente({ idNegocio, idOrden: id, idUsuario: idUsuarioPersona }),
        ).rejects.toMatchObject({ code: 'ORDEN_NO_ABIERTA', statusCode: 409 });
    });
});

describe('la señal «whatsapp» al crear un pedido del bot', () => {
    async function crearConTransaccion({ deAsistente, confirmar }) {
        const espia = jest.spyOn(realtime, 'emitir');
        const t = await sequelize.transaction();
        let idOrden = null;
        try {
            // La caja tiene que estar abierta para crear pedidos.
            const { id_punto_caja: idPunto } = await puntoCajaService.resolverPuntoCaja({ idNegocio });
            await sequelize.query(
                `INSERT INTO restaurante.rest_caja (id_negocio, id_punto_caja, id_usuario, monto_apertura, estado, fecha_apertura)
                 SELECT :n, :p, :u, 0, 'A', now()
                  WHERE NOT EXISTS (SELECT 1 FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A');`,
                { replacements: { n: idNegocio, p: idPunto, u: idUsuarioPersona }, transaction: t },
            );
            const orden = await pedidoService.crearOrden({
                idNegocio, idUsuario: idUsuarioAsistente, deAsistente,
                tipoPedido: 'LLEVAR', contactoNombre: 'BOT Señal', contactoTelefono: '+573000000097',
                items: [{ id_producto: idProductoPrueba, cantidad: 1, precio_unitario: 15000 }],
                permitirStockNegativo: true,
            }, { transaction: t });
            idOrden = orden.id_orden;
            if (confirmar) await t.commit(); else await t.rollback();
        } catch (err) {
            await t.rollback().catch(() => {});
            throw err;
        }
        const llamadas = espia.mock.calls.map(([aviso]) => aviso);
        espia.mockRestore();
        if (confirmar && idOrden) ordenesCreadas.push(idOrden);
        return llamadas;
    }

    it('con deAsistente y commit, el aviso lleva el tema whatsapp', async () => {
        const avisos = await crearConTransaccion({ deAsistente: true, confirmar: true });
        expect(avisos.some((a) => a.temas.includes('whatsapp'))).toBe(true);
    });

    it('un pedido normal del POS no lo lleva', async () => {
        const avisos = await crearConTransaccion({ deAsistente: false, confirmar: true });
        expect(avisos.some((a) => a.temas.includes('whatsapp'))).toBe(false);
    });

    it('si la transacción se deshace (dry-run del Gate) no avisa nada', async () => {
        const avisos = await crearConTransaccion({ deAsistente: true, confirmar: false });
        expect(avisos.length).toBe(0);
    });
});
