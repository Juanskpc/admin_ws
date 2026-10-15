/**
 * El barrio del domicilio cuando el negocio cargó la ciudad entera por comunas (2026-10-15).
 *
 *  - con muchos barrios la pregunta no los lista (no cabrían en WhatsApp): resume el precio por zona;
 *  - un nombre que existe en varias zonas no se elige por el cliente: se le dan numerados y se
 *    toma el que diga, por número;
 *  - «San José comuna 1» acierta a la primera.
 * Sin base de datos: el catálogo es falso.
 */
'use strict';

const flujo = require('../../intelligence/adapters/restaurante/flujo');

const BARRIOS = [
    { id_barrio: 1, nombre: 'San José', zona: 'Comuna 1', valor: 5000 },
    { id_barrio: 2, nombre: 'San José', zona: 'Buesaquillo', valor: 9000 },
    ...Array.from({ length: 40 }, (_, k) => ({
        id_barrio: 100 + k,
        nombre: `Barrio ${k}`,
        zona: k < 20 ? 'Comuna 1' : 'Comuna 2',
        valor: k < 20 ? 5000 : 6000 + (k % 2) * 1000,
    })),
];

function crear() {
    return flujo.crearFlujoRestaurante({
        contextoNegocio: {
            obtener: async () => ({ id: 12, nombre: 'P', tratamiento: 'P', atencion: null, tipoNegocio: 'RESTAURANTE' }),
        },
        identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
        gate: {},
        catalogo: {
            barrios: async () => ({ habilitado: true, barrios: BARRIOS }),
            mesas: async () => [],
            resolverBarrio: async () => { throw new Error('no se usa'); },
            resolverMesa: async () => { throw new Error('no se usa'); },
            resolverExclusiones: async ({ lineas }) => lineas.map(() => ({ validas: [], descartadas: [] })),
        },
    });
}

const turno = (manejar, texto, tarea = null) =>
    manejar({
        conversacion: {
            id_conversacion: 'c', id_negocio: 12, canal: 'whatsapp', id_externo: '573000000000',
            variables: { turnos: 1, nombre: 'Ana' },
            tarea_actual: tarea?.nombre ?? null,
            tarea_datos: tarea?.datos ?? null,
        },
        mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't' },
    });

describe('el barrio con la ciudad cargada por comunas', () => {
    it('la pregunta resume por zona en vez de listar 42 barrios', async () => {
        const manejar = crear();
        const d0 = await turno(manejar, '#P12-4x1');
        const d = await turno(manejar, 'a domicilio', d0.tarea);
        const texto = d.respuestas.map((r) => r.texto).join('\n');
        expect(texto).toContain('• Comuna 1 — $5.000');
        expect(texto).toContain('• Comuna 2 — desde $6.000');
        expect(texto).toContain('• Buesaquillo — $9.000');
        expect(texto).not.toContain('Barrio 7');
    });

    it('un nombre repetido se pregunta numerado y se toma el que diga', async () => {
        const manejar = crear();
        const d0 = await turno(manejar, '#P12-4x1');
        const d1 = await turno(manejar, 'a domicilio', d0.tarea);
        const d2 = await turno(manejar, 'san jose', d1.tarea);
        const texto = d2.respuestas.map((r) => r.texto).join('\n');
        expect(texto).toContain('1. San José (Comuna 1) — $5.000');
        expect(texto).toContain('2. San José (Buesaquillo) — $9.000');
        expect(d2.tarea.datos.barrio_opciones).toEqual([1, 2]);

        const d3 = await turno(manejar, '2', d2.tarea);
        const datos = d3.tarea?.datos ?? d3.conversacion?.tarea_datos ?? {};
        const args = datos.args ?? datos;
        expect(JSON.stringify(d3)).toContain('San José (Buesaquillo)');
        expect(args.barrio_opciones).toBeUndefined();
    });

    it('«San José comuna 1» acierta a la primera', () => {
        expect(flujo.elegirBarrio('San José comuna 1', BARRIOS).id_barrio).toBe(1);
        expect(flujo.elegirBarrio('san jose de buesaquillo', BARRIOS).id_barrio).toBe(2);
    });
});
