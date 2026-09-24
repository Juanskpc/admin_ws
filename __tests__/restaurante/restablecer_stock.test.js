/**
 * «Restablecer a 0» en Inventario: el stock queda en 0 como un AJUSTE con historia (evento de
 * auditoría con usuario, cantidad anterior y motivo), no como un UPDATE mudo.
 *
 * Corre contra la base de verdad y necesita `Restaurante Demo` y `Restaurante Rival`
 * (`node scripts/seed_dev_local.js`).
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const InventarioService = require('../../app_restaurante_api/services/inventarioService');
const InventarioController = require('../../app_restaurante_api/controllers/inventarioController');

const sequelize = Models.sequelize;
const NOMBRE = 'TEST-restablecer-a-cero';

let idNegocio;
let idOtroNegocio;
let idUsuario;
let controlaOriginal;
const creados = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

async function crearInsumo(negocio, stock) {
    const ing = await Models.CartaIngrediente.create({
        id_negocio: negocio, nombre: `${NOMBRE}-${Date.now()}-${creados.length}`, unidad_medida: 'g',
        stock_actual: stock, stock_minimo: 0, stock_maximo: 0, estado: 'A',
    });
    creados.push(ing.id_ingrediente);
    return ing.id_ingrediente;
}

const stockDe = async (id) => Number((await unaFila(
    'SELECT stock_actual FROM restaurante.carta_ingrediente WHERE id_ingrediente = :i', { i: id }
)).stock_actual);

const eventos = (id) => sequelize.query(
    `SELECT id_usuario, id_negocio, detalle FROM auditoria.audit_evento
      WHERE modulo = 'inventario' AND accion = 'stock_restablecido_a_cero'
        AND (detalle->>'id_ingrediente')::int = :i ORDER BY 1`,
    { replacements: { i: id }, type: sequelize.QueryTypes.SELECT },
);

beforeAll(async () => {
    idNegocio = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`)).id_negocio;
    idOtroNegocio = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Rival';`)).id_negocio;
    idUsuario = (await unaFila(
        `SELECT id_usuario FROM general.gener_negocio_usuario WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 1;`,
        { n: idNegocio },
    )).id_usuario;
    controlaOriginal = (await unaFila(
        'SELECT controla_inventario FROM general.gener_negocio WHERE id_negocio = :n', { n: idNegocio }
    )).controla_inventario;
});

afterAll(async () => {
    await sequelize.query('UPDATE general.gener_negocio SET controla_inventario = :v WHERE id_negocio = :n', {
        replacements: { v: controlaOriginal, n: idNegocio },
    });
    for (const id of creados) {
        await sequelize.query('DELETE FROM restaurante.carta_ingrediente WHERE id_ingrediente = :i', { replacements: { i: id } });
    }
    await sequelize.close();
});

describe('restablecerStockACero', () => {
    it('deja el stock en 0 y escribe el evento con usuario, cantidad anterior y motivo', async () => {
        const id = await crearInsumo(idNegocio, 250);
        const r = await InventarioService.restablecerStockACero(idNegocio, id, { idUsuario });

        expect(r).toMatchObject({ cambio: true, stock_anterior: 250, stock_actual: 0 });
        expect(await stockDe(id)).toBe(0);

        const ev = await eventos(id);
        expect(ev).toHaveLength(1);
        expect(ev[0].id_usuario).toBe(idUsuario);
        expect(ev[0].id_negocio).toBe(idNegocio);
        expect(ev[0].detalle).toMatchObject({ stock_anterior: 250, stock_nuevo: 0, delta: -250, motivo: 'Restablecido a 0' });
    });

    it('si ya está en 0 no hace nada: ni cambio ni evento', async () => {
        const id = await crearInsumo(idNegocio, 0);
        const r = await InventarioService.restablecerStockACero(idNegocio, id, { idUsuario });
        expect(r.cambio).toBe(false);
        expect(await eventos(id)).toHaveLength(0);
    });

    it('un insumo de OTRO negocio no existe: 404 tipado y no se toca', async () => {
        const id = await crearInsumo(idOtroNegocio, 40);
        await expect(InventarioService.restablecerStockACero(idNegocio, id, { idUsuario }))
            .rejects.toMatchObject({ code: 'INGREDIENTE_NO_ENCONTRADO', statusCode: 404 });
        expect(await stockDe(id)).toBe(40);
        expect(await eventos(id)).toHaveLength(0);
    });

    it('con el control de inventario apagado funciona igual (es una corrección manual)', async () => {
        await sequelize.query('UPDATE general.gener_negocio SET controla_inventario = false WHERE id_negocio = :n', { replacements: { n: idNegocio } });
        const id = await crearInsumo(idNegocio, 15);
        const r = await InventarioService.restablecerStockACero(idNegocio, id, { idUsuario });
        expect(r.cambio).toBe(true);
        expect(await stockDe(id)).toBe(0);
    });

    it('si el evento no se puede escribir, el stock NO cambia (misma transacción)', async () => {
        const id = await crearInsumo(idNegocio, 33);
        const Audit = require('../../app_core/helpers/auditHelper');
        const espia = jest.spyOn(Audit, 'registrarEvento').mockRejectedValueOnce(new Error('boom'));
        await expect(InventarioService.restablecerStockACero(idNegocio, id, { idUsuario })).rejects.toThrow('boom');
        espia.mockRestore();
        expect(await stockDe(id)).toBe(33);
    });
});

describe('controlador: permiso', () => {
    function llamar(body, params, idUsuarioReq) {
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
        return InventarioController.restablecerStockACero(
            { body, params, usuario: { id_usuario: idUsuarioReq }, query: {} }, res,
        ).then(() => res);
    }

    it('quien no tiene el permiso de ajuste recibe 403 y nada cambia', async () => {
        const id = await crearInsumo(idNegocio, 20);
        const res = await llamar({ id_negocio: idNegocio }, { id: String(id) }, 999999999);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(await stockDe(id)).toBe(20);
    });

    it('el administrador del negocio sí puede', async () => {
        const id = await crearInsumo(idNegocio, 20);
        const res = await llamar({ id_negocio: idNegocio }, { id: String(id) }, idUsuario);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(await stockDe(id)).toBe(0);
    });
});
