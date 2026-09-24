/**
 * Límite de usuarios por negocio (`exigirCupoDeUsuario`).
 *
 * El tope = usuarios incluidos en el plan + lo ASIGNADO de «Usuario adicional». Estas pruebas
 * fijan lo que, si se rompe, no da error: o deja entrar gente de más sin que nadie se entere, o
 * —peor— le quita el trabajo a un negocio que ya iba por encima del tope.
 *
 *   - debajo del cupo pasa; en el cupo da 409 LIMITE_USUARIOS;
 *   - un negocio que YA está por encima conserva a todos sus usuarios y puede editarlos, pero no
 *     puede añadir a nadie;
 *   - lo asignado sin cobrar SÍ da cupo (así se regalan usuarios);
 *   - reactivar a un inactivo también ocupa sitio;
 *   - los usuarios con rol global (super admin) no cuentan;
 *   - el primer usuario de un negocio nunca falla.
 *
 * Todo ocurre dentro de UNA transacción que se deshace al terminar: no queda nada en la base ni se
 * borra nada. El cupo (`getLimitesNegocio`) se simula, porque la base local no tiene el esquema
 * de cobranza; la SUMA de asignados frente a cobrados se comprueba aparte sobre su consulta.
 *
 * Requiere la BD local. Correr con:  DB_PORT=5432 npx jest __tests__/negocios/cupo_usuarios.test.js --forceExit
 */
require('dotenv').config();

jest.mock('../../app_core/helpers/limitesNegocio', () => ({ getLimitesNegocio: jest.fn() }));

const fs = require('fs');
const path = require('path');
const Models = require('../../app_core/models/conection');
const { getLimitesNegocio } = require('../../app_core/helpers/limitesNegocio');
const { exigirCupoDeUsuario, getUsoUsuarios } = require('../../app_core/helpers/cupoUsuarios');

const sequelize = Models.sequelize;

let t;
let idNegocio;
let idRolGlobal;
let n = 0;

/** El cupo que devolvería `getLimitesNegocio`: `null` = sin plan vigente. */
function conTope(total) {
    getLimitesNegocio.mockResolvedValue(
        total === null ? null : { plan: 'Plan de prueba', usuarios: { incluidos: total, adicionales: 0, total } },
    );
}

async function crearUsuario({ estado = 'A', vinculo = 'A', rolGlobal = false } = {}) {
    n += 1;
    const u = await Models.GenerUsuario.create({
        primer_nombre: 'TEST-CUPO',
        primer_apellido: `P${n}`,
        num_identificacion: `9800${Date.now() % 100000}${n}`,
        email: null,
        password: 'Prueba123',
        estado,
    }, { transaction: t });
    if (vinculo) {
        await Models.GenerNegocioUsuario.create(
            { id_usuario: u.id_usuario, id_negocio: idNegocio, estado: vinculo }, { transaction: t },
        );
    }
    if (rolGlobal) {
        await Models.GenerUsuarioRol.create(
            { id_usuario: u.id_usuario, id_rol: idRolGlobal, id_negocio: null, estado: 'A' }, { transaction: t },
        );
    }
    return u;
}

const llenar = async (cuantos) => { for (let i = 0; i < cuantos; i += 1) await crearUsuario(); };
const exigir = (extra = {}) => exigirCupoDeUsuario(idNegocio, { transaction: t, ...extra });

beforeAll(async () => {
    const [[rol]] = await sequelize.query(
        `SELECT r.id_rol FROM general.gener_rol r WHERE r.id_tipo_negocio IS NULL AND r.estado = 'A' LIMIT 1;`,
    );
    idRolGlobal = rol?.id_rol;
});

beforeEach(async () => {
    t = await sequelize.transaction();
    const negocio = await Models.GenerNegocio.create(
        { nombre: 'TEST-CUPO negocio', id_tipo_negocio: 1, estado: 'A' }, { transaction: t },
    );
    idNegocio = negocio.id_negocio;
    getLimitesNegocio.mockReset();
});

afterEach(async () => { await t.rollback(); });

afterAll(async () => { await sequelize.close(); });

describe('exigirCupoDeUsuario', () => {
    test('debajo del cupo pasa', async () => {
        conTope(4);
        await llenar(3);
        await expect(exigir()).resolves.toBeUndefined();
    });

    test('en el cupo da 409 LIMITE_USUARIOS con un mensaje que propone qué hacer', async () => {
        conTope(4);
        await llenar(4);
        await expect(exigir()).rejects.toMatchObject({ code: 'LIMITE_USUARIOS', statusCode: 409 });
        await expect(exigir()).rejects.toThrow(/Usuario adicional.*cambia de plan/s);
    });

    test('un negocio que ya está POR ENCIMA conserva a todos, puede editarlos y no puede añadir', async () => {
        conTope(4);
        await llenar(9);

        // Nadie pierde nada: los 9 siguen contando como activos.
        expect((await getUsoUsuarios(idNegocio, { transaction: t })).usados).toBe(9);

        // Añadir a uno nuevo: 409.
        await expect(exigir()).rejects.toMatchObject({ code: 'LIMITE_USUARIOS' });

        // Editar a alguien que ya ocupa su sitio NO ocupa otro: nunca se bloquea.
        const existente = await crearUsuario();
        await expect(exigir({ idUsuario: existente.id_usuario })).resolves.toBeUndefined();
    });

    test('reactivar a un inactivo también ocupa sitio', async () => {
        conTope(4);
        await llenar(4);
        const inactivo = await crearUsuario({ estado: 'I', vinculo: 'A' });

        await expect(exigir({ idUsuario: inactivo.id_usuario, estadoFinal: 'A' }))
            .rejects.toMatchObject({ code: 'LIMITE_USUARIOS' });

        // Quedar inactivo no ocupa sitio: no se comprueba nada.
        await expect(exigir({ idUsuario: inactivo.id_usuario, estadoFinal: 'I' })).resolves.toBeUndefined();
    });

    test('los inactivos y los vínculos inactivos no cuentan', async () => {
        conTope(2);
        await llenar(1);
        await crearUsuario({ estado: 'I' });
        await crearUsuario({ vinculo: 'I' });
        await expect(exigir()).resolves.toBeUndefined();
    });

    test('un usuario con rol global (super admin) no cuenta contra el tope', async () => {
        conTope(2);
        await llenar(1);
        await crearUsuario({ rolGlobal: true });
        await expect(exigir()).resolves.toBeUndefined();
        expect((await getUsoUsuarios(idNegocio, { transaction: t })).usados).toBe(1);

        // Y meter a uno de rol global en un negocio lleno tampoco se bloquea.
        await llenar(1);
        const global = await crearUsuario({ vinculo: null, rolGlobal: true });
        await expect(exigir({ idUsuario: global.id_usuario })).resolves.toBeUndefined();
    });

    test('vincular a un usuario existente ocupa sitio; el que ya está vinculado no', async () => {
        conTope(2);
        await llenar(2);
        const otro = await crearUsuario({ vinculo: null });
        await expect(exigir({ idUsuario: otro.id_usuario })).rejects.toMatchObject({ code: 'LIMITE_USUARIOS' });
    });

    test('el primer usuario de un negocio NUNCA falla, aunque el tope sea absurdo', async () => {
        conTope(0);
        await expect(exigir()).resolves.toBeUndefined();
    });

    test('sin plan vigente o con plan sin tope no se limita', async () => {
        await llenar(20);
        conTope(null);
        await expect(exigir()).resolves.toBeUndefined();

        getLimitesNegocio.mockResolvedValue({ plan: 'Ilimitado', usuarios: { incluidos: null, adicionales: 0, total: null } });
        await expect(exigir()).resolves.toBeUndefined();
    });

    test('sin negocio o con estado final inactivo no se comprueba nada', async () => {
        conTope(0);
        await llenar(3);
        await expect(exigirCupoDeUsuario(null, { transaction: t })).resolves.toBeUndefined();
        await expect(exigir({ estadoFinal: 'I' })).resolves.toBeUndefined();
    });
});

describe('el cupo cuenta lo ASIGNADO, no lo cobrado', () => {
    // `getLimitesNegocio` es lo que decide el tope. Aquí no se puede ejecutar (la base local no
    // tiene cobranza), así que se fija en su consulta: si alguien la cambiara a `cantidad_facturable`,
    // los usuarios regalados dejarían de dar cupo y un cliente con cortesía se quedaría sin poder
    // añadir a nadie sin que ninguna prueba lo notara.
    test('limitesNegocio suma `cantidad` (asignados) y no `cantidad_facturable` (cobrados)', () => {
        const fuente = fs.readFileSync(path.join(__dirname, '../../app_core/helpers/limitesNegocio.js'), 'utf8');
        expect(fuente).toMatch(/SUM\(sc\.cantidad\)/);
        expect(fuente).not.toMatch(/SUM\(sc\.cantidad_facturable\)/);
    });
});
