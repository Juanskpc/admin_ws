/**
 * Suite de aislamiento multi-inquilino (F2 — ADR-002, ADR-010).
 *
 * Criterio de aceptación del plan: «un token de negocio A no puede leer ni escribir nada
 * de negocio B». Estos tests son la comprobación de ese criterio, y la razón por la que
 * existen es que el agujero fue real: antes de F2, el admin del negocio 3 leía las mesas
 * del negocio 1 con su propio token y el backend respondía `success: true`.
 *
 * Se ejercita el middleware directamente, no por HTTP: así se puede probar el modo
 * BLOQUEO sin levantar el servidor con otra configuración de entorno.
 *
 * Requiere la BD local con dos negocios y sus usuarios:
 *   node scripts/seed_dev_local.js
 *   psql ... -f scripts/fixtures/dev_segundo_negocio.sql
 *
 * Correr con:  npx jest __tests__/platform/aislamiento.test.js --runInBand
 */
require('dotenv').config();
const db = require('../../app_core/models/conection');
const { resolverPrincipalUsuario, crearPrincipal, TIPO } = require('../../app_core/authz/principal');
const { extraerIdNegocio } = require('../../app_core/middleware/authzNegocio');

const sequelize = db.sequelize;

const SUPER_ADMIN = '1000000001';
const ADMIN_DEMO = '1000000002';  // pertenece al negocio "Restaurante Demo"
const ADMIN_RIVAL = '1000000003'; // pertenece al negocio "Restaurante Rival"

let idSuperAdmin;
let idAdminDemo;
let idAdminRival;
let negocioDemo;
let negocioRival;

async function idUsuarioPor(numIdentificacion) {
    const [[fila]] = await sequelize.query(
        `SELECT id_usuario FROM general.gener_usuario WHERE num_identificacion = :n;`,
        { replacements: { n: numIdentificacion } }
    );
    return fila?.id_usuario ?? null;
}

async function idNegocioPor(nombre) {
    const [[fila]] = await sequelize.query(
        `SELECT id_negocio FROM general.gener_negocio WHERE nombre = :n;`,
        { replacements: { n: nombre } }
    );
    return fila?.id_negocio ?? null;
}

beforeAll(async () => {
    idSuperAdmin = await idUsuarioPor(SUPER_ADMIN);
    idAdminDemo = await idUsuarioPor(ADMIN_DEMO);
    idAdminRival = await idUsuarioPor(ADMIN_RIVAL);
    negocioDemo = await idNegocioPor('Restaurante Demo');
    negocioRival = await idNegocioPor('Restaurante Rival');

    if (!idAdminRival || !negocioRival) {
        throw new Error(
            'Faltan los datos de dos inquilinos. Ejecuta scripts/seed_dev_local.js y ' +
                'scripts/fixtures/dev_segundo_negocio.sql antes de esta suite.'
        );
    }
});

afterAll(async () => {
    await sequelize.close();
});

describe('Principal', () => {
    it('resuelve los negocios a los que pertenece un usuario', async () => {
        const p = await resolverPrincipalUsuario(idAdminDemo);
        expect(p.tipo).toBe(TIPO.USUARIO);
        expect(p.idsNegocio()).toEqual([negocioDemo]);
        expect(p.es_super_admin).toBe(false);
    });

    it('AISLAMIENTO: el admin de un negocio no puede operar sobre otro', async () => {
        const rival = await resolverPrincipalUsuario(idAdminRival);

        expect(rival.puedeOperarEn(negocioRival)).toBe(true);
        expect(rival.puedeOperarEn(negocioDemo)).toBe(false);
    });

    it('AISLAMIENTO: y al revés, para descartar que sea casualidad del orden', async () => {
        const demo = await resolverPrincipalUsuario(idAdminDemo);

        expect(demo.puedeOperarEn(negocioDemo)).toBe(true);
        expect(demo.puedeOperarEn(negocioRival)).toBe(false);
    });

    it('el super administrador sí opera sobre cualquier negocio (es intencional)', async () => {
        const p = await resolverPrincipalUsuario(idSuperAdmin);
        expect(p.es_super_admin).toBe(true);
        expect(p.puedeOperarEn(negocioDemo)).toBe(true);
        expect(p.puedeOperarEn(negocioRival)).toBe(true);
    });

    it('un negocio inexistente no se autoriza a nadie que no sea super admin', async () => {
        const p = await resolverPrincipalUsuario(idAdminDemo);
        expect(p.puedeOperarEn(999999)).toBe(false);
    });

    it('acepta el id como número o como cadena (llega de query y de params)', async () => {
        const p = await resolverPrincipalUsuario(idAdminDemo);
        expect(p.puedeOperarEn(String(negocioDemo))).toBe(true);
        expect(p.puedeOperarEn(String(negocioRival))).toBe(false);
    });

    it('expone los roles del usuario en su negocio, para que F4 los use', async () => {
        const p = await resolverPrincipalUsuario(idAdminDemo);
        expect(p.rolesEn(negocioDemo)).toContain('ADMINISTRADOR');
        expect(p.rolesEn(negocioRival)).toEqual([]);
    });

    it('un principal sin negocios no puede operar en ninguno', () => {
        const p = crearPrincipal({ tipo: TIPO.USUARIO, idUsuario: 999 });
        expect(p.puedeOperarEn(negocioDemo)).toBe(false);
        expect(p.idsNegocio()).toEqual([]);
    });
});

describe('extracción del id_negocio de la petición', () => {
    it.each([
        [{ params: { id_negocio: '7' } }, 7, 'params'],
        [{ query: { id_negocio: '7' } }, 7, 'query'],
        [{ body: { id_negocio: 7 } }, 7, 'body'],
        [{ query: { idNegocio: '7' } }, 7, 'camelCase'],
    ])('lo encuentra en %s → %s (%s)', (req, esperado) => {
        expect(extraerIdNegocio(req)).toBe(esperado);
    });

    it.each([
        [{}, 'petición vacía'],
        [{ query: {} }, 'sin la clave'],
        [{ query: { id_negocio: '' } }, 'cadena vacía'],
        [{ query: { id_negocio: 'abc' } }, 'no numérico'],
        [{ query: { id_negocio: '0' } }, 'cero'],
        [{ query: { id_negocio: '-3' } }, 'negativo'],
    ])('devuelve null cuando no hay un id usable: %s (%s)', (req) => {
        expect(extraerIdNegocio(req)).toBeNull();
    });

    it('prioriza params sobre query y body (la ruta manda sobre lo que se envía)', () => {
        expect(
            extraerIdNegocio({
                params: { id_negocio: '1' },
                query: { id_negocio: '2' },
                body: { id_negocio: '3' },
            })
        ).toBe(1);
    });
});
