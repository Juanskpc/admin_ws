/**
 * Editar a un usuario desde UN negocio no puede tocar sus roles ni vínculos en los DEMÁS.
 *
 * Hasta 2026-09-23 `syncUsuarioRolActivo` y `syncUsuarioNegocioActivo` inactivaban todo lo del
 * usuario antes de activar lo del negocio editado. Asignarle cajas al super admin desde un
 * restaurante (PUT /usuarios/admin/:id) lo dejó sin su rol SUPER ADMINISTRADOR y sin sus otros
 * doce negocios, sin un solo error. Lo mismo le pasaba a un dueño que adquiría un segundo negocio.
 *
 * Todo corre dentro de una transacción que se deshace al final: no deja rastro en la base.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const {
    syncUsuarioRolActivo,
    syncUsuarioNegocioActivo,
} = require('../../app_core/dao/usuarioAdminDao');

const sequelize = Models.sequelize;

let t;
let idUsuario;
let negA;
let negB;
let rolA;
let rolA2;
let rolB;
let rolGlobal;

async function uno(sql, repl = {}) {
    const [rows] = await sequelize.query(sql, { replacements: repl, transaction: t });
    return rows[0];
}

async function estadoRol(idNegocio, idRol) {
    const r = await uno(
        `SELECT estado FROM general.gener_usuario_rol
          WHERE id_usuario = :u AND id_rol = :r AND id_negocio IS NOT DISTINCT FROM :n`,
        { u: idUsuario, r: idRol, n: idNegocio }
    );
    return r?.estado ?? null;
}

async function estadoVinculo(idNegocio) {
    const r = await uno(
        `SELECT estado FROM general.gener_negocio_usuario WHERE id_usuario = :u AND id_negocio = :n`,
        { u: idUsuario, n: idNegocio }
    );
    return r?.estado ?? null;
}

beforeAll(async () => {
    t = await sequelize.transaction();

    const negocios = await sequelize.query(
        `SELECT id_negocio FROM general.gener_negocio ORDER BY id_negocio LIMIT 2`,
        { type: sequelize.QueryTypes.SELECT, transaction: t }
    );
    const roles = await sequelize.query(
        `SELECT id_rol FROM general.gener_rol ORDER BY id_rol LIMIT 4`,
        { type: sequelize.QueryTypes.SELECT, transaction: t }
    );
    if (negocios.length < 2 || roles.length < 4) throw new Error('La base no tiene negocios/roles');
    [negA, negB] = negocios.map((n) => n.id_negocio);
    [rolGlobal, rolA, rolA2, rolB] = roles.map((r) => r.id_rol);

    const u = await Models.GenerUsuario.create(
        {
            primer_nombre: 'Prueba',
            primer_apellido: 'SyncRoles',
            num_identificacion: `SYNC${Date.now()}`,
            email: `sync${Date.now()}@test.local`,
            password: 'x',
            estado: 'A',
        },
        { transaction: t }
    );
    idUsuario = u.id_usuario;

    const rol = (id_rol, id_negocio) =>
        Models.GenerUsuarioRol.create({ id_usuario: idUsuario, id_rol, id_negocio, estado: 'A' }, { transaction: t });
    await rol(rolGlobal, null);
    await rol(rolA, negA);
    await rol(rolB, negB);
    for (const n of [negA, negB]) {
        await Models.GenerNegocioUsuario.create(
            { id_usuario: idUsuario, id_negocio: n, estado: 'A' },
            { transaction: t }
        );
    }
});

afterAll(async () => {
    if (t) await t.rollback();
    await sequelize.close();
});

test('cambiar el rol en el negocio A deja intactos el rol global y el del negocio B', async () => {
    await syncUsuarioNegocioActivo(idUsuario, negA, t);
    await syncUsuarioRolActivo(idUsuario, rolA2, negA, t);

    expect(await estadoRol(negA, rolA2)).toBe('A');
    expect(await estadoRol(negA, rolA)).toBe('I'); // un rol activo por negocio
    expect(await estadoRol(negB, rolB)).toBe('A');
    expect(await estadoRol(null, rolGlobal)).toBe('A');

    expect(await estadoVinculo(negA)).toBe('A');
    expect(await estadoVinculo(negB)).toBe('A');
});

test('reasignar el mismo rol no lo inactiva', async () => {
    await syncUsuarioRolActivo(idUsuario, rolA2, negA, t);
    expect(await estadoRol(negA, rolA2)).toBe('A');
});
