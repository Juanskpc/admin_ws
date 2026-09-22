/**
 * `puede_avisar_listo` en `getOrdenesDespacho` — qué tipos de pedido ofrecen el botón de aviso.
 *
 * Hasta el 2026-09-22 solo LLEVAR lo tenía: un domicilio no lo necesitaba porque lo que le
 * llega es el domiciliario. Ahora también DOMICILIO lo tiene, con su propia plantilla
 * («va en camino» en vez de «puedes recogerlo» — ver `avisoPedido.plantillaParaTipo`).
 *
 * Corre contra la base de verdad y necesita `Restaurante Demo` con el asistente forzado.
 */
'use strict';

require('dotenv').config();
process.env.FEATURES_FORZADAS = 'asistente_ia';

const Models = require('../../app_core/models/conection');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const usuarioAsistenteDao = require('../../app_core/dao/usuarioAsistenteDao');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuarioAsistente;

const ordenesCreadas = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

async function crearOrdenDelBot(numero, tipoPedido) {
    // `id_domiciliario` se pone también en LLEVAR y en MESA, aunque no signifique nada ahí:
    // es lo único que hace que `getOrdenesDespacho` enseñe la orden sin importar si el usuario
    // del asistente tiene o no el permiso "ver todos" — este test no quiere depender de eso.
    const orden = await unaFila(
        `INSERT INTO restaurante.pedid_orden
            (id_negocio, id_usuario, numero_orden, tipo_pedido, estado, contacto_nombre,
             contacto_telefono, id_domiciliario, total)
         VALUES (:n, :u, :num, :tipo, 'ABIERTA', 'BOT Cliente Aviso', '+573000000099', :u, 15000)
         RETURNING id_orden;`,
        { n: idNegocio, u: idUsuarioAsistente, num: numero, tipo: tipoPedido },
    );
    ordenesCreadas.push(orden.id_orden);
    return orden.id_orden;
}

beforeAll(async () => {
    idNegocio = (await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`,
    ))?.id_negocio;
    idUsuarioAsistente = await usuarioAsistenteDao.resolverOCrear(idNegocio);
});

afterAll(async () => {
    for (const idOrden of ordenesCreadas) {
        await sequelize.query('DELETE FROM restaurante.pedid_orden WHERE id_orden = :o;', {
            replacements: { o: idOrden },
        });
    }
    await sequelize.close();
});

describe('puede_avisar_listo', () => {
    it('LLEVAR: sí puede avisar', async () => {
        await crearOrdenDelBot('QA-AVISO-LLEVAR', 'LLEVAR');
        const ordenes = await pedidoService.getOrdenesDespacho({ idNegocio, idUsuario: idUsuarioAsistente });
        const fila = ordenes.find((o) => o.numero_orden === 'QA-AVISO-LLEVAR');
        expect(fila.puede_avisar_listo).toBe(true);
    });

    it('DOMICILIO: también puede avisar, con la plantilla de "va en camino"', async () => {
        await crearOrdenDelBot('QA-AVISO-DOMICILIO', 'DOMICILIO');
        const ordenes = await pedidoService.getOrdenesDespacho({ idNegocio, idUsuario: idUsuarioAsistente });
        const fila = ordenes.find((o) => o.numero_orden === 'QA-AVISO-DOMICILIO');
        expect(fila.puede_avisar_listo).toBe(true);
    });

    it('MESA: no puede avisar — no hay a quién', async () => {
        await crearOrdenDelBot('QA-AVISO-MESA', 'MESA');
        const ordenes = await pedidoService.getOrdenesDespacho({ idNegocio, idUsuario: idUsuarioAsistente });
        // MESA ni siquiera aparece en despacho (filtra LLEVAR/DOMICILIO), así que lo correcto
        // es que no esté en la lista — no que esté con el flag en falso.
        const fila = ordenes.find((o) => o.numero_orden === 'QA-AVISO-MESA');
        expect(fila).toBeUndefined();
    });
});
