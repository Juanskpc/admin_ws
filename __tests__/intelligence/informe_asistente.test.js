/**
 * Informe del asistente con las conversaciones reales (fase 3 del diagnóstico, 2026-10-05).
 *
 * Correr con:  npx jest __tests__/intelligence/informe_asistente.test.js   (contra la base LOCAL)
 */
'use strict';
require('dotenv').config();

const Models = require('../../app_core/models/conection');
const servicio = require('../../app_admin_api/services/informeAsistenteService');

afterAll(() => Models.sequelize.close());

const base = (extra = {}) => ({
    actual: {
        pedidos: { total: 35, de_carta: 8, por_chat: 27, pct_por_chat: 77, modelo_por_pedido_carta: 1.3, modelo_por_pedido_chat: 4.7 },
    },
    busq: { sin_resultado: [], agotados: [] },
    persona: { total: 0, motivos: [], dichos_por_el_asistente: [], esperan_respuesta_ahora: 0 },
    errores: [],
    ...extra,
});
const claves = (r) => r.map((a) => a.clave);

describe('recomendar — de los números a «qué hacer»', () => {
    test('el caso de Zona Burger: 77 % de los pedidos por chat → invitar a la carta, con los dos números', () => {
        const r = servicio.recomendar(base());
        expect(claves(r)).toEqual(['pedidos_por_chat']);
        expect(r[0].titulo).toContain('77%');
        expect(r[0].por_que).toContain('4.7');
        expect(r[0].por_que).toContain('1.3');
    });

    test('con pocos pedidos, o mayoría por la carta, no se dice nada', () => {
        expect(servicio.recomendar(base({ actual: { pedidos: { total: 3, pct_por_chat: 100 } } }))).toEqual([]);
        expect(servicio.recomendar(base({ actual: { pedidos: { total: 40, pct_por_chat: 30 } } }))).toEqual([]);
    });

    test('lo que se pidió y no se encuentra, con cuántas veces', () => {
        const r = servicio.recomendar(
            base({ busq: { sin_resultado: [{ termino: 'salchibarril', veces: 4 }, { termino: 'panceta', veces: 1 }], agotados: [] } })
        );
        const a = r.find((x) => x.clave === 'busquedas_sin_resultado');
        expect(a.titulo).toContain('5 veces');
        expect(a.detalles).toEqual(['«salchibarril» (4 veces)', '«panceta»']);
    });

    test('lo que se pidió y está marcado como no disponible va aparte', () => {
        const r = servicio.recomendar(base({ busq: { sin_resultado: [], agotados: [{ veces: 2, producto: 'Discordia' }] } }));
        expect(r.find((x) => x.clave === 'busquedas_agotados').detalles).toEqual(['«Discordia» (lo pidieron 2 veces)']);
    });

    test('los pedidos rechazados van PRIMERO, con dónde se arregla', () => {
        const r = servicio.recomendar(
            base({ errores: [{ codigo: 'SIN_DOMICILIARIO_DISPONIBLE', veces: 3, que_paso: 'No había domiciliario registrado', donde: 'Usuarios' }] })
        );
        expect(r[0].clave).toBe('error_sin_domiciliario_disponible');
        expect(r[0].titulo).toContain('3 pedidos rechazados');
        expect(r[0].donde).toBe('Usuarios');
    });

    test('chats que acabaron en una persona, con los motivos; y los que esperan ahora', () => {
        const r = servicio.recomendar(
            base({
                persona: {
                    total: 7,
                    motivos: [{ motivo: 'El cliente mandó una foto, un audio o una ubicación', veces: 4 }],
                    dichos_por_el_asistente: [{ motivo: 'pregunta por empleo', veces: 2 }],
                    esperan_respuesta_ahora: 2,
                },
            })
        );
        const p = r.find((x) => x.clave === 'chats_a_persona');
        expect(p.detalles.join(' ')).toContain('foto, un audio');
        expect(p.detalles.join(' ')).toContain('pregunta por empleo');
        expect(r.find((x) => x.clave === 'esperan_respuesta').titulo).toContain('2 chats esperan');
    });
});

test('un saludo o un número suelto no es un producto que falte', () => {
    expect(servicio.esTerminoDeProducto('bu es más noches')).toBe(false);
    expect(servicio.esTerminoDeProducto('1.5')).toBe(false);
    expect(servicio.esTerminoDeProducto('hot dog')).toBe(true);
    expect(servicio.esTerminoDeProducto('salchilimon')).toBe(true);
});

describe('informe — contra la base', () => {
    let idNegocio;
    beforeAll(async () => {
        const [fila] = await Models.sequelize.query(
            `SELECT id_negocio FROM intelligence.turno GROUP BY 1 ORDER BY count(*) DESC LIMIT 1;`,
            { type: Models.sequelize.QueryTypes.SELECT, logging: false }
        );
        idNegocio = fila?.id_negocio ?? 1;
    });

    test('la forma del informe, y la semana anterior para comparar', async () => {
        const r = await servicio.informe(idNegocio, { dias: 7, buscar: async () => ({ productos: [] }) });
        expect(r.dias).toBe(7);
        expect(r.actual.pedidos).toEqual(expect.objectContaining({ total: expect.any(Number), pct_por_chat: expect.any(Number) }));
        expect(r.anterior).toEqual(expect.objectContaining({ turnos: expect.any(Number) }));
        expect(Array.isArray(r.que_hacer)).toBe(true);
        expect(r.busquedas.revisadas).toBe(true);
    });

    test('el gasto en IA NO viaja salvo que se pida (solo super admin)', async () => {
        const sin = await servicio.informe(idNegocio, { buscar: async () => ({ productos: [] }) });
        expect(sin.costo).toBeUndefined();
        expect(sin.actual.costo).toBeUndefined();
        const con = await servicio.informe(idNegocio, { conCosto: true, buscar: async () => ({ productos: [] }) });
        expect(con.costo).toEqual(expect.objectContaining({ usd: expect.any(Number), usd_proyeccion_mes: expect.any(Number) }));
    });

    test('la ventana se acota a 1–31 días', async () => {
        expect((await servicio.informe(idNegocio, { dias: 500, buscar: async () => ({ productos: [] }) })).dias).toBe(31);
        expect((await servicio.informe(idNegocio, { dias: 0, buscar: async () => ({ productos: [] }) })).dias).toBe(7);
    });
});
