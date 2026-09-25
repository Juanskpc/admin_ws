/**
 * Restaurante → crear usuario respeta el tope de usuarios del plan (+ complementos).
 *
 * `restaurante_app` crea usuarios por la API del admin (`POST /admin/usuarios/admin`); el chequeo es
 * `exigirCupoDeUsuario`, el mismo de toda vía que crea, vincula o reactiva a alguien en un negocio.
 * Aquí se prueba de punta a punta por el CONTROLADOR (lo que ve el navegador): con el negocio en su
 * tope, crear responde 409 `LIMITE_USUARIOS` con lo que el front necesita para explicarlo
 * (`data: { total, usados }`) y NO deja el usuario a medias.
 *
 * El tope se simula (`getLimitesNegocio`): no depende del plan que tenga la base local. Todo lo que
 * llega a escribirse se deshace (la creación falla dentro de su transacción).
 *
 * Requiere la BD local: DB_PORT=5432 npx jest __tests__/restaurante/usuario_cupo.test.js --forceExit
 */
'use strict';

require('dotenv').config();

jest.mock('../../app_core/helpers/limitesNegocio', () => ({ getLimitesNegocio: jest.fn() }));

const Models = require('../../app_core/models/conection');
const { getLimitesNegocio } = require('../../app_core/helpers/limitesNegocio');
const { contarUsuarios } = require('../../app_core/helpers/cupoUsuarios');
const UsuarioAdminController = require('../../app_admin_api/controllers/usuarioAdminController');

const sequelize = Models.sequelize;
let idNegocio;
let idRol;

async function fila(sql, r = {}) {
    return (await sequelize.query(sql, { replacements: r, type: sequelize.QueryTypes.SELECT }))[0] ?? null;
}

function llamar(body) {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    return UsuarioAdminController.createUsuario({ body, usuario: { id_usuario: 1 }, query: {} }, res).then(() => res);
}

beforeAll(async () => {
    idNegocio = (await fila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`)).id_negocio;
    idRol = (await fila(
        `SELECT id_rol FROM general.gener_rol r
          WHERE r.estado = 'A' AND r.id_tipo_negocio = (SELECT id_tipo_negocio FROM general.gener_negocio WHERE id_negocio = :n)
          ORDER BY id_rol LIMIT 1;`, { n: idNegocio },
    )).id_rol;
});

afterAll(async () => { await sequelize.close(); });

const datos = (sufijo) => ({
    primer_nombre: 'Test', primer_apellido: 'Cupo', num_identificacion: `TEST-CUPO-${sufijo}`,
    email: `test-cupo-${sufijo}@example.com`, password: 'Abcdef12*', id_rol: idRol, id_negocio: idNegocio,
});

describe('crear un usuario de restaurante con el negocio en su tope', () => {
    it('responde 409 LIMITE_USUARIOS con el tope y los usados, y no deja al usuario creado', async () => {
        const usados = await contarUsuarios(idNegocio);
        expect(usados).toBeGreaterThan(0); // con cero usuarios el primero nunca falla
        getLimitesNegocio.mockResolvedValue({ plan: 'Plan Básico', usuarios: { incluidos: usados, adicionales: 0, total: usados } });

        const sufijo = Date.now();
        const res = await llamar(datos(sufijo));

        expect(res.status).toHaveBeenCalledWith(409);
        const cuerpo = res.json.mock.calls[0][0];
        expect(cuerpo).toMatchObject({ success: false, code: 'LIMITE_USUARIOS', data: { total: usados, usados } });
        expect(cuerpo.message).toMatch(/permite .* usuario/);
        expect(await fila(`SELECT 1 AS ok FROM general.gener_usuario WHERE num_identificacion = :n`, { n: `TEST-CUPO-${sufijo}` })).toBeNull();
    });
});
