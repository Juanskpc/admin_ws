/**
 * `exigirPertenenciaNegocio` — el middleware que separa a un inquilino de otro.
 *
 * ## Por qué esta prueba existe
 *
 * Los servicios de los verticales **no comprueban la pertenencia**: toman el `id_negocio` de la
 * petición y consultan con él. Medido el 2026-10-04 en `app_restaurante_api/services/`:
 * `pedidoService`, `cuentaService` e `inventarioService` tienen cero comprobaciones. Eso está
 * bien —es el middleware el que debe hacerlo, no cada servicio— pero significa que **toda** la
 * separación entre inquilinos cuelga de este archivo.
 *
 * Y nace en modo `observacion`, que audita y **deja pasar**. Comprobado contra la base de
 * desarrollo con un token real de un usuario que pertenece a [2,4,5,6,10]:
 *
 *   AUTHZ_MODO ausente (= producción hoy)   AUTHZ_MODO=bloqueo
 *   GET /reserva/citas?id_negocio=44 → 200  → 403
 *   GET /reserva/caja/historial?…=44 → 200  → 403
 *   GET /restaurante/inventario/…?=1 → 200  → 403
 *   GET /restaurante/pedidos/abiertas → 200  → 403
 *
 * O sea que hoy un token de cualquier inquilino lee las citas y el historial de caja de otro.
 *
 * Estas pruebas fijan las dos mitades: que en `bloqueo` se rechaza al ajeno, y que **al propio
 * no se le estorba** — que es la mitad por la que el modo lleva dos meses sin activarse.
 *
 * Ejecutar: npx jest __tests__/authz/pertenencia_negocio.test.js --forceExit
 */
'use strict';

// El modo se lee UNA VEZ al cargar el módulo (`const MODO = ...`), así que cada variante tiene
// que ponerse en el entorno antes del `require` y aislarse con `jest.resetModules()`. Es la
// razón de que aquí no haya un `require` arriba del archivo como en el resto de las suites.
jest.mock('../../app_core/helpers/auditHelper', () => ({
    registrarEvento: jest.fn(async () => undefined),
}));

const { crearPrincipal } = require('../../app_core/authz/principal');

/** Carga el middleware con un `AUTHZ_MODO` concreto. */
function cargarCon(modo) {
    jest.resetModules();
    const anterior = process.env.AUTHZ_MODO;
    if (modo === undefined) delete process.env.AUTHZ_MODO;
    else process.env.AUTHZ_MODO = modo;

    // `resolverPrincipalUsuario` iría a la base; se dobla para que la prueba no la necesite.
    jest.doMock('../../app_core/authz/principal', () => ({
        ...jest.requireActual('../../app_core/authz/principal'),
        resolverPrincipalUsuario: jest.fn(async () => principalDeLaPrueba),
    }));
    jest.doMock('../../app_core/helpers/auditHelper', () => ({
        registrarEvento: jest.fn(async () => undefined),
    }));

    const mod = require('../../app_core/middleware/authzNegocio');
    if (anterior === undefined) delete process.env.AUTHZ_MODO;
    else process.env.AUTHZ_MODO = anterior;
    return mod;
}

/** El usuario de la prueba: pertenece a 2, 4, 5, 6 y 10 — como el usuario 3 de la base de dev. */
let principalDeLaPrueba = crearPrincipal({
    tipo: 'usuario',
    idUsuario: 3,
    esSuperAdmin: false,
    negocios: new Map([2, 4, 5, 6, 10].map((id) => [id, ['ADMINISTRADOR']])),
});

function peticion({ query = {}, body = {}, params = {} } = {}) {
    return {
        usuario: { id_usuario: 3 },
        query, body, params,
        method: 'GET',
        originalUrl: '/reserva/citas?id_negocio=44',
    };
}

function respuesta() {
    const res = { codigo: null, cuerpo: null };
    res.status = (c) => { res.codigo = c; return res; };
    res.json = (b) => { res.cuerpo = b; return res; };
    return res;
}

async function correr(mod, req) {
    const res = respuesta();
    let paso = false;
    await mod.exigirPertenenciaNegocio(req, res, () => { paso = true; });
    return { paso, res };
}

describe('modo bloqueo', () => {
    test('un negocio ajeno se rechaza con 403, venga en query, body o params', async () => {
        const mod = cargarCon('bloqueo');

        for (const fuente of [{ query: { id_negocio: 44 } }, { body: { id_negocio: 44 } }, { params: { id_negocio: '44' } }]) {
            const { paso, res } = await correr(mod, peticion(fuente));
            expect(paso).toBe(false);
            expect(res.codigo).toBe(403);
        }
    });

    // La mitad que importa para poder activarlo: el trabajo normal no se toca. Barrido en dev
    // sobre 58 endpoints de restaurante y reserva, cero rechazos indebidos.
    test('un negocio propio pasa', async () => {
        const mod = cargarCon('bloqueo');

        for (const id of [2, 4, 5, 6, 10]) {
            const { paso, res } = await correr(mod, peticion({ query: { id_negocio: id } }));
            expect(paso).toBe(true);
            expect(res.codigo).toBeNull();
        }
    });

    test('una petición sin id_negocio pasa: no hay nada que comprobar', async () => {
        const mod = cargarCon('bloqueo');
        const { paso } = await correr(mod, peticion());
        expect(paso).toBe(true);
    });

    test('el super administrador pasa sobre cualquier negocio: su alcance es la plataforma', async () => {
        const original = principalDeLaPrueba;
        principalDeLaPrueba = crearPrincipal({ tipo: 'usuario', idUsuario: 1, esSuperAdmin: true });
        const mod = cargarCon('bloqueo');

        const { paso } = await correr(mod, peticion({ query: { id_negocio: 44 } }));
        expect(paso).toBe(true);

        principalDeLaPrueba = original;
    });
});

describe('modo observación — lo que corre en producción hoy', () => {
    // Esta prueba documenta el agujero, no lo aprueba. Si algún día alguien la ve fallar porque
    // el ajeno empezó a bloquearse, es que se activó `bloqueo`: se borra este describe entero.
    test('sin AUTHZ_MODO, un negocio ajeno PASA (solo se audita)', async () => {
        const mod = cargarCon(undefined);
        expect(mod.MODO_BLOQUEO).toBe(false);

        const { paso, res } = await correr(mod, peticion({ query: { id_negocio: 44 } }));
        expect(paso).toBe(true);
        expect(res.codigo).toBeNull();
    });
});

describe('extraerIdNegocio', () => {
    test('lo encuentra en params, query y body, y acepta idNegocio en camelCase', () => {
        const { extraerIdNegocio } = cargarCon('bloqueo');

        expect(extraerIdNegocio({ query: { id_negocio: '7' } })).toBe(7);
        expect(extraerIdNegocio({ body: { idNegocio: 7 } })).toBe(7);
        expect(extraerIdNegocio({ params: { id_negocio: 7 } })).toBe(7);
    });

    test('un valor que no es un entero positivo se ignora, no se adivina', () => {
        const { extraerIdNegocio } = cargarCon('bloqueo');

        for (const valor of ['', '  ', 'abc', '0', '-3', '1.5', null, undefined]) {
            expect(extraerIdNegocio({ query: { id_negocio: valor } })).toBeNull();
        }
    });

    // Hueco conocido y documentado en el propio middleware: una ruta donde el negocio es `:id`
    // —y no `:id_negocio`— queda fuera de la comprobación. Hoy esas rutas se protegen a mano en
    // su controlador (`resolveAccesoNegocio` en restaurante, `requireSuperAdmin` en admin), que
    // está verificado, pero activar `bloqueo` NO las cubre y conviene no creer que sí.
    test('NO mira un `:id` suelto: esas rutas se protegen en su controlador', () => {
        const { extraerIdNegocio } = cargarCon('bloqueo');
        expect(extraerIdNegocio({ params: { id: '44' } })).toBeNull();
    });
});
