/**
 * Barrios con precio de domicilio: CRUD del administrador, lectura pública y `resolverBarrio`.
 *
 * Entra por los CONTROLADORES (lo que la pantalla ejercita) y deja la base como estaba.
 * Lo que importa de verdad: el valor lo manda el servidor y un barrio de OTRO negocio no se
 * puede ni leer, ni editar, ni usar.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const Barrios = require('../../app_restaurante_api/controllers/barrioController');
const Publico = require('../../app_restaurante_api/controllers/publicoController');
const BarrioService = require('../../app_restaurante_api/services/barrioService');

const sequelize = Models.sequelize;

let idNegocio;
let idOtroNegocio;
let idUsuario;
let flagOriginal;

function resFalso() {
    const capturado = { statusCode: 200, cuerpo: null };
    return {
        capturado,
        status(code) { capturado.statusCode = code; return this; },
        json(payload) { capturado.cuerpo = payload; return this; },
    };
}

async function llamar(handler, { body = {}, query = {}, params = {} } = {}) {
    const res = resFalso();
    await handler({ body, query, params, usuario: { id_usuario: idUsuario } }, res);
    return res.capturado;
}

beforeAll(async () => {
    const [negocio] = await sequelize.query(
        `SELECT id_negocio, permite_pago_domicilio FROM general.gener_negocio
          WHERE nombre = 'Restaurante Demo';`,
        { type: sequelize.QueryTypes.SELECT },
    );
    idNegocio = negocio.id_negocio;
    flagOriginal = negocio.permite_pago_domicilio;

    const [usuario] = await sequelize.query(
        `SELECT id_usuario FROM general.gener_negocio_usuario
          WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 1;`,
        { replacements: { n: idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
    idUsuario = usuario.id_usuario;

    // Un negocio al que ESE usuario no pertenece: según la base, el primer usuario del demo
    // puede estar asignado a varios.
    const [otro] = await sequelize.query(
        `SELECT n.id_negocio FROM general.gener_negocio n
          WHERE n.id_negocio <> :n
            AND NOT EXISTS (SELECT 1 FROM general.gener_negocio_usuario nu
                             WHERE nu.id_negocio = n.id_negocio AND nu.id_usuario = :u)
          ORDER BY n.id_negocio LIMIT 1;`,
        { replacements: { n: idNegocio, u: idUsuario }, type: sequelize.QueryTypes.SELECT },
    );
    idOtroNegocio = otro.id_negocio;
});

afterAll(async () => {
    await sequelize.query(
        `DELETE FROM restaurante.rest_barrio_domicilio WHERE nombre LIKE 'TEST-%';`,
    );
    await sequelize.query(
        `UPDATE general.gener_negocio SET permite_pago_domicilio = :f WHERE id_negocio = :n;`,
        { replacements: { f: flagOriginal, n: idNegocio } },
    );
    await sequelize.close();
});

describe('barrios de domicilio', () => {
    let creado;

    it('crea, lista, edita y elimina un barrio', async () => {
        const c = await llamar(Barrios.crear, {
            body: { id_negocio: idNegocio, nombre: '  TEST-Centro  ', valor: 4500 },
        });
        expect(c.statusCode).toBe(201);
        creado = c.cuerpo.data;
        expect(creado).toMatchObject({ nombre: 'TEST-Centro', valor: 4500 });

        const l = await llamar(Barrios.listar, { query: { id_negocio: idNegocio } });
        expect(l.cuerpo.data.some((b) => b.id_barrio === creado.id_barrio)).toBe(true);

        const e = await llamar(Barrios.editar, {
            params: { id: creado.id_barrio }, body: { id_negocio: idNegocio, valor: 5000 },
        });
        expect(e.statusCode).toBe(200);
        expect(e.cuerpo.data.valor).toBe(5000);

        const d = await llamar(Barrios.eliminar, {
            params: { id: creado.id_barrio }, query: { id_negocio: idNegocio },
        });
        expect(d.statusCode).toBe(200);
        const despues = await llamar(Barrios.listar, { query: { id_negocio: idNegocio } });
        expect(despues.cuerpo.data.some((b) => b.id_barrio === creado.id_barrio)).toBe(false);
    });

    it('rechaza un nombre repetido entre los activos (409)', async () => {
        await llamar(Barrios.crear, { body: { id_negocio: idNegocio, nombre: 'TEST-Norte', valor: 3000 } });
        const dup = await llamar(Barrios.crear, {
            body: { id_negocio: idNegocio, nombre: 'test-norte', valor: 3500 },
        });
        expect(dup.statusCode).toBe(409);
    });

    it('un usuario no puede tocar los barrios de OTRO negocio', async () => {
        const c = await llamar(Barrios.crear, {
            body: { id_negocio: idOtroNegocio, nombre: 'TEST-Ajeno', valor: 1000 },
        });
        expect(c.statusCode).toBe(403);
    });

    it('resolverBarrio relee el valor de la base y rechaza barrios ajenos o borrados', async () => {
        const c = await llamar(Barrios.crear, { body: { id_negocio: idNegocio, nombre: 'TEST-Sur', valor: 6000 } });
        const id = c.cuerpo.data.id_barrio;

        await expect(BarrioService.resolverBarrio({ idNegocio, idBarrio: id }))
            .resolves.toMatchObject({ valor: 6000 });
        await expect(BarrioService.resolverBarrio({ idNegocio: idOtroNegocio, idBarrio: id }))
            .rejects.toMatchObject({ code: 'ZONA_INVALIDA', statusCode: 400 });

        await llamar(Barrios.eliminar, { params: { id }, query: { id_negocio: idNegocio } });
        await expect(BarrioService.resolverBarrio({ idNegocio, idBarrio: id }))
            .rejects.toMatchObject({ code: 'ZONA_INVALIDA' });
    });

    it('la lectura pública solo lleva id, nombre y valor, y depende de permite_pago_domicilio', async () => {
        await llamar(Barrios.crear, { body: { id_negocio: idNegocio, nombre: 'TEST-Oeste', valor: 2000 } });

        await sequelize.query(
            `UPDATE general.gener_negocio SET permite_pago_domicilio = false WHERE id_negocio = :n;`,
            { replacements: { n: idNegocio } },
        );
        expect(await BarrioService.listarPublico(idNegocio)).toEqual({ habilitado: false, barrios: [] });

        await sequelize.query(
            `UPDATE general.gener_negocio SET permite_pago_domicilio = true WHERE id_negocio = :n;`,
            { replacements: { n: idNegocio } },
        );
        const pub = await BarrioService.listarPublico(idNegocio);
        expect(pub.habilitado).toBe(true);
        const oeste = pub.barrios.find((b) => b.nombre === 'TEST-Oeste');
        expect(Object.keys(oeste).sort()).toEqual(['id_barrio', 'nombre', 'valor']);
        expect(typeof Publico.getBarrios).toBe('function');
    });
});
