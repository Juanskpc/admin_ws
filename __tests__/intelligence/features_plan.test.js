/**
 * Features desde datos y código estable de plan (ADR-021).
 *
 * ## Qué se está probando de verdad
 *
 * Que la fuente de las features pasó del NOMBRE del plan a las filas de
 * `general.gener_plan_caracteristica`, **sin que nadie pierda el asistente en el camino**:
 *
 *   1. Avanzado lo tiene con su fila… y también SIN ella (el mapa por nombre es el respaldo).
 *   2. Básico no lo tiene.
 *   3. Renombrar el plan NO se lo quita a quien tiene la fila (es lo que hace estable la fuente
 *      nueva), pero sin fila sí dependería del nombre (lo que demuestra que la fila es lo que protege).
 *   4. Una fila con valor distinto de 'true' es una decisión explícita y manda sobre el respaldo.
 *   5. `featuresDeNegocios` sigue siendo UNA consulta.
 *   6. Los sitios que buscaban el plan por nombre ahora lo buscan por código: la compra en línea, la
 *      prueba y el registro trial siguen resolviendo el plan aunque se renombre.
 *
 * Como `features.js` consulta por la conexión normal (no por una transacción que se pueda pasar), las
 * pruebas que tocan datos los **cambian de verdad y los restauran en un `finally`**. Es la base
 * LOCAL, pero por eso mismo cada cambio se deshace en el propio test que lo hace.
 *
 * ⚠️ Contra la base LOCAL (DB_PORT=5432).
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const Models = require('../../app_core/models/conection');
const features = require('../../intelligence/core/features');
const AdquirirService = require('../../app_admin_api/services/adquirirService');
const NegocioDao = require('../../app_core/dao/negocioDao');
const CobranzaDao = require('../../app_core/dao/cobranzaDao');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };
const consulta = (sql, r = {}) => sequelize.query(sql, { replacements: r, ...SELECT });
const ejecutar = (sql, r = {}) => sequelize.query(sql, { replacements: r, logging: false });

const { FEATURE, estaHabilitado, featuresDeNegocios, explicar } = features;

let idBasico;
let idAvanzado;
let negocios; // tres negocios distintos para colgarles planes
const filasCreadas = [];

async function darPlan(idNegocio, idPlan) {
    const [filas] = await sequelize.query(
        `INSERT INTO general.gener_negocio_plan (id_negocio, id_plan, fecha_inicio, fecha_fin, estado)
         VALUES (:idNegocio, :idPlan, now() + interval '1 second', NULL, 'A')
         RETURNING id_negocio_plan;`,
        { replacements: { idNegocio, idPlan }, logging: false }
    );
    filasCreadas.push(filas[0].id_negocio_plan);
    return filas[0].id_negocio_plan;
}

const filaCaracteristica = (idPlan, codigo = FEATURE.ASISTENTE_IA) =>
    consulta(
        `SELECT valor FROM general.gener_plan_caracteristica WHERE id_plan = :idPlan AND codigo = :codigo;`,
        { idPlan, codigo }
    ).then((f) => f[0] ?? null);

beforeAll(async () => {
    const planes = await consulta(
        `SELECT id_plan, codigo FROM general.gener_plan WHERE codigo IN ('BASICO', 'AVANZADO');`
    );
    idBasico = planes.find((p) => p.codigo === 'BASICO')?.id_plan;
    idAvanzado = planes.find((p) => p.codigo === 'AVANZADO')?.id_plan;
    if (!idBasico || !idAvanzado) {
        throw new Error('Faltan los planes BASICO y AVANZADO: corre `npm run migrate:planes-codigo`.');
    }

    negocios = (await consulta(
        `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 3;`
    )).map((n) => n.id_negocio);
    if (negocios.length < 3) throw new Error('Hacen falta tres negocios en la base local.');
});

afterAll(async () => {
    if (filasCreadas.length > 0) {
        await ejecutar(`DELETE FROM general.gener_negocio_plan WHERE id_negocio_plan IN (:ids);`, {
            ids: filasCreadas,
        });
    }
    await sequelize.close();
});

describe('la migración', () => {
    test('los planes tienen su código y BASICO / AVANZADO son únicos', async () => {
        const filas = await consulta(
            `SELECT codigo, count(*)::int AS n FROM general.gener_plan
              WHERE codigo IS NOT NULL GROUP BY codigo;`
        );
        for (const f of filas) expect(f.n).toBe(1);
        expect(filas.map((f) => f.codigo)).toEqual(expect.arrayContaining(['BASICO', 'AVANZADO']));
    });

    test('Avanzado trae asistente_ia = true y Básico no trae nada', async () => {
        expect((await filaCaracteristica(idAvanzado))?.valor).toBe('true');
        expect(await filaCaracteristica(idBasico)).toBeNull();
    });

    test('FACTURACION_ELECTRONICA existe como constante y ningún plan actual la tiene', async () => {
        expect(FEATURE.FACTURACION_ELECTRONICA).toBe('facturacion_electronica');
        const [fe] = await consulta(
            `SELECT count(*)::int AS n FROM general.gener_plan_caracteristica
              WHERE codigo = 'facturacion_electronica' AND valor = 'true';`
        );
        expect(fe.n).toBe(0);
    });
});

describe('Avanzado conserva el asistente', () => {
    test('con su fila de característica', async () => {
        await darPlan(negocios[0], idAvanzado);
        expect(await estaHabilitado(negocios[0], FEATURE.ASISTENTE_IA)).toBe(true);
        expect((await explicar(negocios[0], FEATURE.ASISTENTE_IA)).motivo).toContain('gener_plan_caracteristica');
    });

    test('y también SIN ella (respaldo por nombre): nadie pierde el asistente en la transición', async () => {
        const fila = await filaCaracteristica(idAvanzado);
        expect(fila).not.toBeNull();
        try {
            await ejecutar(
                `DELETE FROM general.gener_plan_caracteristica WHERE id_plan = :id AND codigo = 'asistente_ia';`,
                { id: idAvanzado }
            );
            expect(await estaHabilitado(negocios[0], FEATURE.ASISTENTE_IA)).toBe(true);
            expect((await explicar(negocios[0], FEATURE.ASISTENTE_IA)).motivo).toContain('mapa de respaldo');
            const mapa = await featuresDeNegocios([negocios[0]]);
            expect(mapa.get(negocios[0])).toContain(FEATURE.ASISTENTE_IA);
        } finally {
            await ejecutar(
                `INSERT INTO general.gener_plan_caracteristica (id_plan, codigo, valor)
                 VALUES (:id, 'asistente_ia', :valor) ON CONFLICT (id_plan, codigo) DO NOTHING;`,
                { id: idAvanzado, valor: fila.valor }
            );
        }
    });

    test('una fila explícita con valor distinto de «true» manda sobre el respaldo', async () => {
        try {
            await ejecutar(
                `UPDATE general.gener_plan_caracteristica SET valor = 'false'
                  WHERE id_plan = :id AND codigo = 'asistente_ia';`,
                { id: idAvanzado }
            );
            expect(await estaHabilitado(negocios[0], FEATURE.ASISTENTE_IA)).toBe(false);
        } finally {
            await ejecutar(
                `UPDATE general.gener_plan_caracteristica SET valor = 'true'
                  WHERE id_plan = :id AND codigo = 'asistente_ia';`,
                { id: idAvanzado }
            );
        }
        expect(await estaHabilitado(negocios[0], FEATURE.ASISTENTE_IA)).toBe(true);
    });
});

describe('Básico no la tiene', () => {
    test('ni por fila ni por respaldo', async () => {
        await darPlan(negocios[1], idBasico);
        expect(await estaHabilitado(negocios[1], FEATURE.ASISTENTE_IA)).toBe(false);
        expect((await featuresDeNegocios([negocios[1]])).get(negocios[1])).toEqual([]);
    });
});

describe('renombrar el plan', () => {
    async function renombrar(idPlan, nuevo, fn) {
        const [{ nombre }] = await consulta(`SELECT nombre FROM general.gener_plan WHERE id_plan = :idPlan;`, { idPlan });
        try {
            await ejecutar(`UPDATE general.gener_plan SET nombre = :nuevo WHERE id_plan = :idPlan;`, { idPlan, nuevo });
            await fn();
        } finally {
            await ejecutar(`UPDATE general.gener_plan SET nombre = :nombre WHERE id_plan = :idPlan;`, { idPlan, nombre });
        }
    }

    test('NO le quita el asistente si existe la fila', async () => {
        await renombrar(idAvanzado, 'Plan Avanzado (renombrado por marketing)', async () => {
            expect(await estaHabilitado(negocios[0], FEATURE.ASISTENTE_IA)).toBe(true);
            expect((await featuresDeNegocios([negocios[0]])).get(negocios[0])).toContain(FEATURE.ASISTENTE_IA);
        });
    });

    test('sin la fila SÍ dependería del nombre: es la fila lo que lo protege', async () => {
        const fila = await filaCaracteristica(idAvanzado);
        try {
            await ejecutar(
                `DELETE FROM general.gener_plan_caracteristica WHERE id_plan = :id AND codigo = 'asistente_ia';`,
                { id: idAvanzado }
            );
            await renombrar(idAvanzado, 'Plan Avanzado (renombrado por marketing)', async () => {
                expect(await estaHabilitado(negocios[0], FEATURE.ASISTENTE_IA)).toBe(false);
            });
        } finally {
            await ejecutar(
                `INSERT INTO general.gener_plan_caracteristica (id_plan, codigo, valor)
                 VALUES (:id, 'asistente_ia', :valor) ON CONFLICT (id_plan, codigo) DO NOTHING;`,
                { id: idAvanzado, valor: fila.valor }
            );
        }
    });
});

describe('featuresDeNegocios sigue siendo UNA consulta', () => {
    test('con varios negocios', async () => {
        const espia = jest.spyOn(sequelize, 'query');
        try {
            const mapa = await featuresDeNegocios(negocios);
            expect(espia).toHaveBeenCalledTimes(1);
            expect(mapa.size).toBe(3);
            expect(mapa.get(negocios[0])).toContain(FEATURE.ASISTENTE_IA);
            expect(mapa.get(negocios[1])).toEqual([]);
        } finally {
            espia.mockRestore();
        }
    });
});

describe('lo que buscaba el plan por nombre ahora lo busca por código', () => {
    // El precio no es lo que se prueba aquí: la base local puede no tener las tablas de cobranza
    // (`cob_precio_plan`), y sin precio `resolverPlan` lanza DESPUÉS de encontrar el plan. Se fija.
    let precio;
    beforeAll(() => {
        precio = jest.spyOn(CobranzaDao, 'getPrecio').mockResolvedValue(59999);
    });
    afterAll(() => precio.mockRestore());

    async function conNombreCambiado(idPlan, fn) {
        const [{ nombre }] = await consulta(`SELECT nombre FROM general.gener_plan WHERE id_plan = :idPlan;`, { idPlan });
        try {
            await ejecutar(`UPDATE general.gener_plan SET nombre = :n WHERE id_plan = :idPlan;`, {
                idPlan,
                n: `${nombre} (renombrado)`,
            });
            await fn();
        } finally {
            await ejecutar(`UPDATE general.gener_plan SET nombre = :nombre WHERE id_plan = :idPlan;`, { idPlan, nombre });
        }
    }

    test('la compra en línea resuelve el plan por su código, en mayúsculas o no', async () => {
        for (const referencia of ['AVANZADO', 'avanzado', 'BASICO']) {
            const plan = await AdquirirService.resolverPlan(referencia);
            expect(plan.codigo).toBe(referencia.toUpperCase());
        }
    });

    test('y sigue resolviendo aunque el plan se renombre', async () => {
        await conNombreCambiado(idAvanzado, async () => {
            const plan = await AdquirirService.resolverPlan('AVANZADO');
            expect(plan.id_plan).toBe(idAvanzado);
        });
    });

    test('la referencia antigua por nombre sigue valiendo (los enlaces de la landing)', async () => {
        const [{ nombre }] = await consulta(`SELECT nombre FROM general.gener_plan WHERE id_plan = :id;`, { id: idAvanzado });
        const plan = await AdquirirService.resolverPlan(nombre);
        expect(plan.id_plan).toBe(idAvanzado);
    });

    test('un plan que no existe sigue siendo PLAN_NO_DISPONIBLE', async () => {
        await expect(AdquirirService.resolverPlan('NO_EXISTE')).rejects.toMatchObject({
            code: 'PLAN_NO_DISPONIBLE',
        });
    });

    test('el catálogo de compra ofrece solo BASICO y AVANZADO, con su código', async () => {
        // Necesita `usuarios_incluidos` (migrate:cobranza-complementos): la base local puede no
        // tenerla. Contra la compartida (5433) se comprobó a mano: ['BASICO', 'AVANZADO'].
        const [col] = await consulta(
            `SELECT 1 AS hay FROM information_schema.columns
              WHERE table_schema = 'general' AND table_name = 'gener_plan' AND column_name = 'usuarios_incluidos';`
        );
        if (!col) return console.warn('catalogoCompra omitido: falta migrate:cobranza-complementos en esta base.');
        const { planes } = await AdquirirService.catalogoCompra();
        for (const p of planes) expect(['BASICO', 'AVANZADO']).toContain(p.codigo);
    });

    test('la prueba desde la consola corre con el plan BASICO aunque se renombre', async () => {
        await conNombreCambiado(idBasico, async () => {
            const v = await NegocioDao.resolverVigencia({ prueba: true });
            expect(v.idPlan).toBe(idBasico);
            expect(v.esPrueba).toBe(true);
        });
    });

    test('el registro de prueba busca el plan por código y no por nombre', async () => {
        const fuente = fs.readFileSync(
            path.join(__dirname, '../../app_admin_api/services/registroTrialService.js'),
            'utf8'
        );
        expect(fuente).toMatch(/where:\s*\{\s*codigo:\s*'BASICO'/);
        expect(fuente).not.toMatch(/nombre:\s*'Plan Básico'/);
    });

    test('y ese plan existe y está activo por su código', async () => {
        const plan = await Models.GenerPlan.findOne({
            where: { codigo: 'BASICO', estado: 'A' },
            attributes: ['id_plan', 'codigo'], // como registroTrialService: sin columnas que la base local no tenga
        });
        expect(plan?.id_plan).toBe(idBasico);
    });
});
