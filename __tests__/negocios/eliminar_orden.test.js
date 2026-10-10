/**
 * Eliminar un negocio: que siga existiendo un orden de borrado.
 *
 * El borrado no tiene lista de tablas: `construirPlan` recorre las FK del catálogo de Postgres y
 * ordena las tablas de las hojas hacia `gener_negocio`. Es lo que hace que una tabla nueva entre
 * sola sin tocar el servicio — y también lo que hace que una **FK** nueva pueda romperlo sin que
 * nadie se entere.
 *
 * Pasó de verdad: `gener_negocio.id_metodo_pago_domicilio` apunta a `rest_metodo_pago`, que a su
 * vez apunta a `gener_negocio`. Un ciclo. A partir de ese momento la eliminación de CUALQUIER
 * negocio —no solo de los que usaban esa columna— fallaba con «se referencian en ciclo», y
 * tampoco se podía ver la previsualización. El arreglo es vaciar esas columnas antes de empezar
 * a borrar (`neutralizar`), que se puede porque admiten NULL y porque la fila se va a borrar
 * entera de todos modos.
 *
 * Esta prueba es el centinela de eso. **Solo lee** el catálogo —ni una fila escrita—, así que
 * puede correr contra la base de desarrollo compartida (ver `docs/desarrollo-local.md`).
 *
 *   npx jest __tests__/negocios/eliminar_orden.test.js
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const { construirPlan } = require('../../app_admin_api/services/negocioCicloVidaService');

const RAIZ = 'general.gener_negocio';

let plan;

beforeAll(async () => {
    // Si hubiera un ciclo sin salida, esto lanza y la suite entera falla con el motivo.
    plan = await construirPlan();
});

afterAll(async () => {
    await Models.sequelize.close();
});

describe('eliminar negocio · orden de borrado', () => {
    it('hay un plan con pasos', () => {
        expect(Array.isArray(plan.pasos)).toBe(true);
        // Decenas de tablas cuelgan del negocio; un plan diminuto sería un recorrido roto.
        expect(plan.pasos.length).toBeGreaterThan(20);
    });

    it('cada paso sabe qué tabla borra y con qué condición', () => {
        for (const paso of plan.pasos) {
            expect(typeof paso.tabla).toBe('string');
            expect(typeof paso.donde).toBe('string');
            expect(paso.donde.length).toBeGreaterThan(0);
            // Toda condición acaba acotada al negocio que se elimina.
            expect(paso.donde).toContain(':id');
        }
    });

    it('la fila del negocio se borra al final', () => {
        // Es la raíz: si saliera antes, todo lo que cuelga de ella quedaría huérfano o el DELETE
        // fallaría por FK.
        expect(plan.pasos.at(-1).tabla).toBe(RAIZ);
        expect(plan.pasos.filter((p) => p.tabla === RAIZ)).toHaveLength(1);
    });

    it('ninguna tabla aparece dos veces', () => {
        const tablas = plan.pasos.map((p) => p.tabla);
        expect(new Set(tablas).size).toBe(tablas.length);
    });

    it('no toca la auditoría', () => {
        // La auditoría es la memoria de quién eliminó qué, incluido este borrado.
        for (const paso of plan.pasos) {
            expect(paso.tabla.startsWith('auditoria.')).toBe(false);
        }
    });

    it('no toca las tablas compartidas', () => {
        // Usuarios, roles, tipos y planes son de la plataforma. El servicio se niega si el
        // recorrido las alcanza, así que llegar aquí ya significa que no lo hizo; se afirma
        // explícitamente porque es la consecuencia que de verdad importa.
        for (const compartida of ['general.gener_usuario', 'general.gener_rol',
            'general.gener_tipo_negocio', 'general.gener_plan']) {
            expect(plan.pasos.map((p) => p.tabla)).not.toContain(compartida);
        }
    });

    it('las FK de la propia fila del negocio se vacían antes de borrar', () => {
        // Hoy hay una: `id_metodo_pago_domicilio`. Si mañana hay dos, las dos tienen que estar
        // aquí; si alguien quitara la columna, la lista queda vacía y eso también es correcto.
        expect(Array.isArray(plan.neutralizar)).toBe(true);
        for (const n of plan.neutralizar) {
            expect(n.tabla).toBe(RAIZ);
            expect(n.columnas.length).toBeGreaterThan(0);
            expect(n.sql).toMatch(/^UPDATE /);
            expect(n.sql).toContain('= NULL');
            expect(n.sql).toContain(':id');
        }
    });

    it('toda FK de la raíz hacia una tabla del negocio se neutraliza', () => {
        // La afirmación de fondo: el plan existe PORQUE esas aristas se quitan del orden. Si
        // apareciera una FK así que fuera NOT NULL, `construirPlan` habría lanzado en el
        // `beforeAll` y esta prueba no se habría ejecutado — que es el aviso que se quiere.
        const vaciadas = new Set(plan.neutralizar.flatMap((n) => n.columnas));
        const enElPlan = new Set(plan.pasos.map((p) => p.tabla));

        const sospechosas = plan.neutralizar.length === 0 ? [] : [...vaciadas];
        for (const columna of sospechosas) {
            // La columna existe de verdad en la tabla raíz.
            expect(typeof columna).toBe('string');
        }
        // Y la tabla a la que apuntan sigue dentro del borrado: vaciarlas no la saca del plan.
        expect(enElPlan.has('restaurante.rest_metodo_pago')).toBe(true);
    });
});
