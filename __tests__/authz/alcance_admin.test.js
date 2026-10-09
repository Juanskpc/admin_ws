/**
 * Alcance de las rutas de administración de usuarios y roles (auditoría 2026-10-04).
 *
 * Estas rutas estuvieron sin ninguna comprobación de autorización: cualquier token válido
 * listaba a los usuarios de toda la plataforma, editaba al super administrador y reescribía la
 * matriz de permisos de un rol ajeno. El arreglo es alcance por negocio —no `requireSuperAdmin`,
 * que habría roto la vista «Personal» de `negocio_app`—, así que estas pruebas afirman las dos
 * mitades: **que el inquilino sigue pudiendo con los suyos** y **que no puede con los demás**.
 *
 * Sin base de datos: se dobla el DAO. Lo que se prueba es la decisión de autorización, no la
 * consulta.
 *
 * Ejecutar: npx jest __tests__/authz/alcance_admin.test.js --forceExit
 */
'use strict';

jest.mock('../../app_core/dao/usuarioAdminDao', () => ({
    getUsuarios: jest.fn(async () => []),
    getUsuarioById: jest.fn(async () => null),
    getRolesActivos: jest.fn(async () => [
        { id_rol: 2, descripcion: 'ADMINISTRADOR' },
        { id_rol: 9, descripcion: 'SUPER ADMINISTRADOR' },
        { id_rol: 5, descripcion: 'MESERO' },
    ]),
    getPermisosEfectivosUsuario: jest.fn(async () => ({ modulos: [] })),
    getPermisosMatrizRol: jest.fn(async () => ({ modulos: [] })),
    savePermisosRol: jest.fn(async () => undefined),
    findUsuarioDuplicado: jest.fn(async () => null),
    createUsuario: jest.fn(async () => 123),
    isAdminRoleName: (n) => /ADMINISTRADOR/i.test(n || ''),
}));
jest.mock('../../app_core/helpers/funcionesAdicionales', () => ({
    initTransaction: jest.fn(async () => ({ commit: jest.fn(), rollback: jest.fn() })),
}));
jest.mock('../../app_core/helpers/auditHelper', () => ({ registrarEvento: jest.fn(async () => undefined) }));

const Dao = require('../../app_core/dao/usuarioAdminDao');
const Controlador = require('../../app_admin_api/controllers/usuarioAdminController');
const { crearPrincipal } = require('../../app_core/authz/principal');

/** El principal que `exigirPertenenciaNegocio` deja en `req` en producción. */
function principalDe({ idUsuario = 1, superAdmin = false, negocios = [] } = {}) {
    return crearPrincipal({
        tipo: 'usuario',
        idUsuario,
        esSuperAdmin: superAdmin,
        negocios: new Map(negocios.map((id) => [Number(id), ['ADMINISTRADOR']])),
    });
}

function respuestaFalsa() {
    const res = { codigo: null, cuerpo: null };
    res.status = (c) => { res.codigo = c; return res; };
    res.json = (b) => { res.cuerpo = b; return res; };
    return res;
}

async function llamar(fn, { principal, params = {}, query = {}, body = {} }) {
    const res = respuestaFalsa();
    await fn({ principal, params, query, body, usuario: { id_usuario: principal.id_usuario } }, res);
    return res;
}

const DUENO_DEL_6 = () => principalDe({ idUsuario: 7, negocios: [6] });
const SUPER = () => principalDe({ idUsuario: 1, superAdmin: true, negocios: [] });

beforeEach(() => jest.clearAllMocks());

describe('listar usuarios', () => {
    test('al inquilino se le acota la consulta a sus negocios', async () => {
        await llamar(Controlador.listUsuarios, { principal: DUENO_DEL_6(), query: {} });

        expect(Dao.getUsuarios).toHaveBeenCalledWith(expect.objectContaining({ idsNegocio: [6] }));
    });

    test('pedir el id_negocio de otro no abre nada: el alcance sigue siendo el suyo', async () => {
        await llamar(Controlador.listUsuarios, {
            principal: DUENO_DEL_6(),
            query: { id_negocio: '13' },
        });

        expect(Dao.getUsuarios).toHaveBeenCalledWith(
            expect.objectContaining({ idNegocio: 13, idsNegocio: [6] })
        );
    });

    test('al super administrador no se le acota (idsNegocio null)', async () => {
        await llamar(Controlador.listUsuarios, { principal: SUPER(), query: {} });

        expect(Dao.getUsuarios).toHaveBeenCalledWith(expect.objectContaining({ idsNegocio: null }));
    });

    test('sin principal se niega, no se adivina', async () => {
        const res = respuestaFalsa();
        await Controlador.listUsuarios({ query: {}, params: {}, body: {} }, res);

        expect(Dao.getUsuarios).toHaveBeenCalledWith(expect.objectContaining({ idsNegocio: [] }));
    });
});

describe('tocar a un usuario de otro negocio', () => {
    const AJENO = {
        id_usuario: 40,
        estado: 'A',
        es_admin_principal: false,
        roles: [{ id_rol: 5, descripcion: 'MESERO', id_negocio: 13 }],
    };

    beforeEach(() => { Dao.getUsuarioById.mockResolvedValue(AJENO); });

    // 404 y no 403 a propósito: un 403 confirma que el id existe y de quién es, y convierte la
    // ruta en un enumerador de la plantilla de los demás inquilinos.
    test.each([
        ['suspenderlo', () => Controlador.setEstadoUsuario, { params: { id: '40' }, body: { estado: 'I' } }],
        ['eliminarlo', () => Controlador.deleteUsuario, { params: { id: '40' }, body: {} }],
        ['ver sus permisos', () => Controlador.getPermisosUsuario, { params: { id: '40' }, body: {} }],
    ])('%s responde 404, como si no existiera', async (_nombre, fn, extra) => {
        const res = await llamar(fn(), { principal: DUENO_DEL_6(), ...extra });

        expect(res.codigo).toBe(404);
        expect(res.cuerpo.message).toBe('Usuario no encontrado');
    });

    test('el super administrador sí puede: llega al DAO', async () => {
        await llamar(Controlador.getPermisosUsuario, { principal: SUPER(), params: { id: '40' } });

        expect(Dao.getPermisosEfectivosUsuario).toHaveBeenCalledWith(40);
    });
});

describe('escalada de privilegios', () => {
    test('un inquilino no puede crear un super administrador', async () => {
        const res = await llamar(Controlador.createUsuario, {
            principal: DUENO_DEL_6(),
            body: {
                primer_nombre: 'A', primer_apellido: 'B', num_identificacion: '1',
                email: 'a@b.co', password: 'Secreta123', id_rol: 9, id_negocio: 6,
            },
        });

        expect(res.codigo).toBe(403);
        expect(Dao.createUsuario).not.toHaveBeenCalled();
    });

    test('un inquilino no puede crear usuarios en el negocio de otro', async () => {
        const res = await llamar(Controlador.createUsuario, {
            principal: DUENO_DEL_6(),
            body: {
                primer_nombre: 'A', primer_apellido: 'B', num_identificacion: '1',
                email: 'a@b.co', password: 'Secreta123', id_rol: 5, id_negocio: 13,
            },
        });

        expect(res.codigo).toBe(403);
        expect(Dao.createUsuario).not.toHaveBeenCalled();
    });

    test('tampoco globales (sin id_negocio): ese ámbito es del super administrador', async () => {
        const res = await llamar(Controlador.createUsuario, {
            principal: DUENO_DEL_6(),
            body: {
                primer_nombre: 'A', primer_apellido: 'B', num_identificacion: '1',
                email: 'a@b.co', password: 'Secreta123', id_rol: 5,
            },
        });

        expect(res.codigo).toBe(403);
    });

    test('en su propio negocio y con un rol normal, sí crea', async () => {
        const res = await llamar(Controlador.createUsuario, {
            principal: DUENO_DEL_6(),
            body: {
                primer_nombre: 'A', primer_apellido: 'B', num_identificacion: '1',
                email: 'a@b.co', password: 'Secreta123', id_rol: 5, id_negocio: 6,
            },
        });

        expect(res.codigo).toBe(201);
        expect(Dao.createUsuario).toHaveBeenCalled();
    });

    test('ni aunque compartan negocio se puede tocar a un super administrador', async () => {
        Dao.getUsuarioById.mockResolvedValue({
            id_usuario: 2,
            estado: 'A',
            es_admin_principal: false,
            // Cuenta de soporte: miembro del negocio 6 Y super administrador.
            roles: [
                { id_rol: 9, descripcion: 'SUPER ADMINISTRADOR', id_negocio: null },
                { id_rol: 2, descripcion: 'ADMINISTRADOR', id_negocio: 6 },
            ],
        });

        const res = await llamar(Controlador.setEstadoUsuario, {
            principal: DUENO_DEL_6(),
            params: { id: '2' },
            body: { estado: 'I' },
        });

        expect(res.codigo).toBe(404);
    });
});

describe('matriz de permisos de un rol', () => {
    test('reescribir la de otro negocio se rechaza antes de tocar la base', async () => {
        const res = await llamar(Controlador.savePermisosRol, {
            principal: DUENO_DEL_6(),
            params: { id: '5' },
            body: { id_negocio: 13, modulos: [{ id_nivel: 1 }] },
        });

        expect(res.codigo).toBe(403);
        expect(Dao.savePermisosRol).not.toHaveBeenCalled();
    });

    test('sin id_negocio es la plantilla global: también se rechaza', async () => {
        const res = await llamar(Controlador.savePermisosRol, {
            principal: DUENO_DEL_6(),
            params: { id: '5' },
            body: { modulos: [{ id_nivel: 1 }] },
        });

        expect(res.codigo).toBe(403);
        expect(Dao.savePermisosRol).not.toHaveBeenCalled();
    });

    test('la del suyo sí se guarda — es lo que hace «Personal» en negocio_app', async () => {
        const res = await llamar(Controlador.savePermisosRol, {
            principal: DUENO_DEL_6(),
            params: { id: '5' },
            body: { id_negocio: 6, modulos: [{ id_nivel: 1 }] },
        });

        expect(res.codigo).toBe(200);
        expect(Dao.savePermisosRol).toHaveBeenCalled();
    });

    test('leer la de otro negocio tampoco', async () => {
        const res = await llamar(Controlador.getPermisosRol, {
            principal: DUENO_DEL_6(),
            params: { id: '5' },
            query: { id_negocio: '13' },
        });

        expect(res.codigo).toBe(403);
        expect(Dao.getPermisosMatrizRol).not.toHaveBeenCalled();
    });
});
