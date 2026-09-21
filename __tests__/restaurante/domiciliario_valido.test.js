/**
 * `id_domiciliario` solo pasaba por `isInt({ min: 1 })` en el controlador y por la FK a
 * `gener_usuario` en la base: comprueba que sea un entero positivo que exista EN ALGUNA PARTE
 * del sistema, nunca que sea domiciliario DE ESTE NEGOCIO. Un id de un empleado de otro
 * negocio, o de un usuario sin ningún rol de domiciliario, se colaba igual.
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
let idDomiciliarioValido;
let idUsuarioSinRol;

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

function pedir(idDomiciliario) {
    return pedidoService.crearOrden({
        idNegocio,
        idUsuario,
        idMesa: null,
        tipoPedido: 'DOMICILIO',
        contactoNombre: 'TEST domiciliario',
        contactoTelefono: '+573000000001',
        direccionDomicilio: 'Calle de prueba # 1-01',
        idDomiciliario,
        items: [{ id_producto: idProducto, cantidad: 1, precio_unitario: 10000 }],
    });
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

    // Cualquier OTRO usuario activo del sistema, sin ningún vínculo con este negocio: es
    // exactamente el caso que el fallo dejaba pasar — un id que existe, pero de cualquier
    // parte, no de aquí.
    idUsuarioSinRol = (await unaFila(
        `SELECT id_usuario FROM general.gener_usuario WHERE estado = 'A' AND id_usuario <> :u LIMIT 1;`,
        { u: idUsuario },
    ))?.id_usuario;

    idProducto = (await unaFila(
        `SELECT id_producto FROM restaurante.carta_producto
          WHERE id_negocio = :n AND estado = 'A' AND precio > 0 LIMIT 1;`,
        { n: idNegocio },
    ))?.id_producto;

    // Este negocio va por el camino del ROL (permite_domicilio_personal = false aquí): se le
    // da el rol DOMICILIARIO a un usuario para tener un candidato válido de verdad.
    const rolDom = await unaFila(
        `SELECT id_rol FROM general.gener_rol WHERE descripcion = 'DOMICILIARIO' AND id_tipo_negocio = 1;`,
    );
    idDomiciliarioValido = idUsuario;
    await sequelize.query(
        `INSERT INTO general.gener_usuario_rol (id_usuario, id_rol, id_negocio, estado)
         VALUES (:u, :r, :n, 'A')
         ON CONFLICT DO NOTHING;`,
        { replacements: { u: idDomiciliarioValido, r: rolDom.id_rol, n: idNegocio } },
    );

    const abierta = await unaFila(
        `SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`,
        { n: idNegocio },
    );
    if (abierta) {
        idCaja = abierta.id_caja;
    } else {
        idCaja = (await cajaService.abrirCaja({
            idNegocio, idUsuario, montoApertura: 0, observaciones: 'test domiciliario',
        })).id_caja;
        cajaEraDeLaSuite = true;
    }
});

afterAll(async () => {
    for (const idOrden of ordenesCreadas) await borrarOrden(idOrden);
    await sequelize.query(
        `DELETE FROM general.gener_usuario_rol
          WHERE id_usuario = :u AND id_negocio = :n
            AND id_rol = (SELECT id_rol FROM general.gener_rol WHERE descripcion = 'DOMICILIARIO' AND id_tipo_negocio = 1);`,
        { replacements: { u: idDomiciliarioValido, n: idNegocio } },
    );
    if (cajaEraDeLaSuite) {
        await sequelize.query(
            `UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_caja = :c AND estado = 'A';`,
            { replacements: { c: idCaja } },
        );
    }
    await sequelize.close();
});

describe('esDomiciliarioValido', () => {
    it('un usuario con el rol DOMICILIARIO de este negocio es válido', async () => {
        expect(
            await pedidoService.esDomiciliarioValido({
                idNegocio, idDomiciliario: idDomiciliarioValido, transaction: null,
            }),
        ).toBe(true);
    });

    it('un usuario que existe, pero sin ningún vínculo con este negocio, no es válido', async () => {
        expect(
            await pedidoService.esDomiciliarioValido({
                idNegocio, idDomiciliario: idUsuarioSinRol, transaction: null,
            }),
        ).toBe(false);
    });

    it('un id que no existe en ningún lado tampoco es válido', async () => {
        expect(
            await pedidoService.esDomiciliarioValido({
                idNegocio, idDomiciliario: 999999999, transaction: null,
            }),
        ).toBe(false);
    });
});

describe('crearOrden rechaza un domiciliario inválido', () => {
    it('con un id de domiciliario que no existe en ningún lado, no crea la orden', async () => {
        await expect(pedir(999999999)).rejects.toMatchObject({ code: 'DOMICILIARIO_INVALIDO' });
    });

    it('con el domiciliario correcto, sí la crea', async () => {
        const orden = await pedir(idDomiciliarioValido);
        ordenesCreadas.push(orden.id_orden);
        expect(orden.numero_orden).toBeTruthy();

        const fila = await unaFila(
            `SELECT id_domiciliario FROM restaurante.pedid_orden WHERE id_orden = :o;`,
            { o: orden.id_orden },
        );
        expect(fila.id_domiciliario).toBe(idDomiciliarioValido);
    });

    it('sin domiciliario (opcional) sigue funcionando igual que siempre', async () => {
        const orden = await pedir(null);
        ordenesCreadas.push(orden.id_orden);
        expect(orden.numero_orden).toBeTruthy();
    });
});
