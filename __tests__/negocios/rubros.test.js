/**
 * Rubros: el oficio del cliente y el módulo que lo atiende son cosas distintas.
 *
 * Una heladería y una pizzería son oficios distintos y **el mismo software**. Una barbería y un
 * spa, lo mismo con el otro. Lo que se guarda son las dos cosas: `gener_negocio.id_rubro` para
 * hablar con el cliente e `id_tipo_negocio` —el módulo— porque de ahí cuelgan los roles y los
 * permisos, y confundirlos deja al cliente fuera de su propia app.
 *
 * Lo que estas pruebas sostienen:
 *   1. Solo se ofrecen oficios cuyo módulo existe de verdad. Un tipo suelto del catálogo
 *      (PARQUEADERO, que tiene código pero no está desplegado) no se puede elegir.
 *   2. Elegir un oficio guarda el oficio Y resuelve el módulo, sin que el que llama lo sepa.
 *   3. Cambiar de oficio dentro del mismo módulo NO toca los roles; cambiar de módulo sí.
 *   4. Lo que manda la landing —una clave en texto— resuelve al mismo sitio, incluidas las
 *      claves viejas que siguen circulando en páginas cacheadas.
 *
 * La regla de oro de la suite: **nada se busca por id escrito a mano**. Los ids de tipo NO
 * coinciden entre la base de desarrollo y la de producción (RESERVA es 9 en una y 10 en la
 * otra), y una prueba que los fije pasaría aquí y mentiría allí.
 *
 * Necesita `npm run migrate:rubros-negocio`.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const tipoOperativo = require('../../app_core/helpers/tipoNegocioOperativo');
const negocioDao = require('../../app_core/dao/negocioDao');
const { resolverRubroElegido } = require('../../app_admin_api/services/registroTrialService');

const sequelize = Models.sequelize;

const creados = [];
let idPorNombre = {};

async function idDe(nombre) {
    if (idPorNombre[nombre] !== undefined) return idPorNombre[nombre];
    const filas = await sequelize.query(
        `SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = :nombre;`,
        { replacements: { nombre }, type: sequelize.QueryTypes.SELECT },
    );
    idPorNombre[nombre] = filas[0]?.id_tipo_negocio ?? null;
    return idPorNombre[nombre];
}

async function estadoDe(idNegocio) {
    const filas = await sequelize.query(
        `SELECT m.nombre AS modulo, r.nombre AS rubro
           FROM general.gener_negocio n
           LEFT JOIN general.gener_tipo_negocio m ON m.id_tipo_negocio = n.id_tipo_negocio
           LEFT JOIN general.gener_tipo_negocio r ON r.id_tipo_negocio = n.id_rubro
          WHERE n.id_negocio = :id;`,
        { replacements: { id: idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
    return filas[0] ?? null;
}

/** Un cliente nuevo sobre el oficio dado. Devuelve { id_negocio, id_usuario }. */
async function registrar(nombreRubro, sufijo) {
    const r = await negocioDao.registrarCliente({
        negocio: { nombre: `TEST rubro ${sufijo}`, id_rubro: await idDe(nombreRubro) },
        plan: null,
        admin: {
            primer_nombre: 'Test', primer_apellido: 'Rubro',
            num_identificacion: `TESTRUBRO${sufijo}`,
            email: `test.rubro.${sufijo}@example.invalid`,
            password: 'Aa123456',
        },
    });
    creados.push(r);
    return r;
}

afterAll(async () => {
    for (const c of creados) {
        for (const sql of [
            'DELETE FROM platform.persona_negocio WHERE id_negocio = :n',
            'DELETE FROM general.gener_nivel_negocio WHERE id_negocio = :n',
            'DELETE FROM general.gener_usuario_rol WHERE id_negocio = :n',
            'DELETE FROM general.gener_negocio_usuario WHERE id_negocio = :n',
            'DELETE FROM general.gener_negocio_fiscal WHERE id_negocio = :n',
            'DELETE FROM general.gener_nivel_usuario WHERE id_usuario = :u',
            'DELETE FROM general.gener_usuario WHERE id_usuario = :u',
            'DELETE FROM general.gener_negocio WHERE id_negocio = :n',
        ]) {
            await sequelize.query(sql, { replacements: { n: c.id_negocio, u: c.id_usuario } })
                .catch(() => { /* tabla que no existe en esta base */ });
        }
    }
    await sequelize.close();
});

describe('qué se puede ofrecer', () => {
    it('los oficios ofrecidos tienen todos un módulo detrás', async () => {
        const rubros = await tipoOperativo.getRubros();

        expect(rubros.length).toBeGreaterThan(0);
        for (const r of rubros) {
            expect(r.id_tipo_modulo).toBeTruthy();
            expect(r.modulo).toBeTruthy();
            expect(r.etiqueta).toBeTruthy();
        }
    });

    it('varios oficios distintos comparten el mismo módulo', async () => {
        const rubros = await tipoOperativo.getRubros();
        const deRestaurante = rubros.filter((r) => r.modulo === 'RESTAURANTE');

        // Es el punto entero del cambio: heladería y pizzería no son el mismo negocio, pero sí
        // el mismo software. Si esto fuera 1 a 1 no habría hecho falta separar rubro de módulo.
        expect(deRestaurante.length).toBeGreaterThan(1);
        expect(new Set(deRestaurante.map((r) => r.id_tipo_modulo)).size).toBe(1);
    });

    it('un tipo sin módulo desplegado no se ofrece ni se puede elegir', async () => {
        const idParqueadero = await idDe('PARQUEADERO');
        const rubros = await tipoOperativo.getRubros();

        expect(rubros.some((r) => r.id_tipo_negocio === idParqueadero)).toBe(false);
        await expect(tipoOperativo.resolverRubro(idParqueadero))
            .rejects.toMatchObject({ code: 'TIPO_NEGOCIO_SIN_MODULO' });
    });

    it('un tipo que no existe se rechaza sin inventarse un módulo', async () => {
        await expect(tipoOperativo.resolverRubro(999999))
            .rejects.toMatchObject({ code: 'TIPO_NEGOCIO_INVALIDO', statusCode: 400 });
    });
});

describe('crear un cliente por su oficio', () => {
    it('una heladería se guarda como heladería y corre sobre restaurante', async () => {
        const r = await registrar('HELADERIA', 'HELA');

        expect(await estadoDe(r.id_negocio)).toEqual({ modulo: 'RESTAURANTE', rubro: 'HELADERIA' });
    });

    it('una barbería se guarda como barbería y corre sobre reserva', async () => {
        const r = await registrar('BARBERIA', 'BARB');

        expect(await estadoDe(r.id_negocio)).toEqual({ modulo: 'RESERVA', rubro: 'BARBERIA' });
    });

    it('el administrador que se crea es el del MÓDULO, no el del oficio', async () => {
        // Era el fallo original: el rol se buscaba por el tipo elegido, y el ADMINISTRADOR de
        // BARBERIA no tiene ni un permiso sembrado. El usuario entraba a una app sin pantallas.
        const r = creados.find((x) => x.id_negocio);
        const filas = await sequelize.query(
            `SELECT t.nombre AS tipo_del_rol
               FROM general.gener_usuario_rol ur
               JOIN general.gener_rol rol ON rol.id_rol = ur.id_rol
               JOIN general.gener_tipo_negocio t ON t.id_tipo_negocio = rol.id_tipo_negocio
              WHERE ur.id_negocio = :n AND ur.estado = 'A';`,
            { replacements: { n: r.id_negocio }, type: sequelize.QueryTypes.SELECT },
        );

        expect(filas.length).toBeGreaterThan(0);
        for (const f of filas) expect(['RESTAURANTE', 'RESERVA']).toContain(f.tipo_del_rol);
    });
});

describe('cambiar de oficio', () => {
    it('dentro del mismo módulo cambia el oficio y NADA más', async () => {
        const r = await registrar('CAFETERIA', 'CAFE');
        const rolesAntes = await sequelize.query(
            `SELECT id_rol FROM general.gener_usuario_rol WHERE id_negocio = :n ORDER BY id_rol;`,
            { replacements: { n: r.id_negocio }, type: sequelize.QueryTypes.SELECT },
        );

        await negocioDao.updateNegocio(r.id_negocio, {
            nombre: 'TEST rubro CAFE', id_rubro: await idDe('PIZZERIA'),
        });

        expect(await estadoDe(r.id_negocio)).toEqual({ modulo: 'RESTAURANTE', rubro: 'PIZZERIA' });

        const rolesDespues = await sequelize.query(
            `SELECT id_rol FROM general.gener_usuario_rol WHERE id_negocio = :n ORDER BY id_rol;`,
            { replacements: { n: r.id_negocio }, type: sequelize.QueryTypes.SELECT },
        );
        expect(rolesDespues).toEqual(rolesAntes);
    });

    it('cambiar de módulo traduce los roles del equipo', async () => {
        const r = await registrar('PIZZERIA', 'PIZZ');

        await negocioDao.updateNegocio(r.id_negocio, {
            nombre: 'TEST rubro PIZZ', id_rubro: await idDe('SALON DE BELLEZA'),
        });

        expect(await estadoDe(r.id_negocio)).toEqual({ modulo: 'RESERVA', rubro: 'SALON DE BELLEZA' });

        // El rol tiene que haber pasado al ADMINISTRADOR del módulo nuevo. Si se quedara con el
        // del viejo, la consulta de permisos no casaría con nada y el negocio no abriría — que
        // es exactamente lo que le pasó al primer cliente de reserva.
        const filas = await sequelize.query(
            `SELECT t.nombre AS tipo_del_rol
               FROM general.gener_usuario_rol ur
               JOIN general.gener_rol rol ON rol.id_rol = ur.id_rol
               JOIN general.gener_tipo_negocio t ON t.id_tipo_negocio = rol.id_tipo_negocio
              WHERE ur.id_negocio = :n AND ur.estado = 'A';`,
            { replacements: { n: r.id_negocio }, type: sequelize.QueryTypes.SELECT },
        );
        expect(filas.length).toBeGreaterThan(0);
        for (const f of filas) expect(f.tipo_del_rol).toBe('RESERVA');
    });
});

describe('lo que manda la landing', () => {
    it('resuelve la clave del oficio al mismo sitio que la consola', async () => {
        const rubro = await resolverRubroElegido('HELADERIA');

        expect(rubro).not.toBeNull();
        expect(rubro.id_tipo_negocio).toBe(await idDe('HELADERIA'));
        expect(rubro.id_tipo_modulo).toBe(await idDe('RESTAURANTE'));
    });

    it('acepta también el id numérico', async () => {
        const id = await idDe('PIZZERIA');

        const rubro = await resolverRubroElegido(String(id));

        expect(rubro?.id_tipo_negocio).toBe(id);
    });

    // La landing está prerenderizada: cuando se despliega una versión nueva puede quedar gente
    // con la página vieja abierta, y esa manda todavía `SALON_BELLEZA` con guion bajo.
    it('acepta las claves viejas que siguen circulando en páginas cacheadas', async () => {
        const rubro = await resolverRubroElegido('SALON_BELLEZA');

        expect(rubro?.nombre).toBe('SALON DE BELLEZA');
        expect(rubro?.id_tipo_modulo).toBe(await idDe('RESERVA'));
    });

    it('rechaza lo que no es un oficio ofrecible', async () => {
        expect(await resolverRubroElegido('PARQUEADERO')).toBeNull();
        expect(await resolverRubroElegido('LO QUE SEA')).toBeNull();
        expect(await resolverRubroElegido('')).toBeNull();
        expect(await resolverRubroElegido(null)).toBeNull();
    });
});
