/**
 * Qué comandas ve la pantalla de Cocina (`getOrdenesCocina`).
 *
 * Un pedido enviado a cocina que nadie avanzó allí se quedaba en el tablero para siempre: en
 * Zona Burger, que no usa Cocina, aparecían 25 comandas de mayo a octubre ya cobradas. Pero
 * CERRADA significa COBRADA, no servida: un pedido para llevar pagado al pedirlo se cierra de
 * una y sigue cocinándose. Por eso la regla es:
 *
 *  1. ABIERTA se ve siempre, por vieja que sea.
 *  2. CERRADA se ve solo si entró en las últimas 12 h.
 *  3. CANCELADA no se ve nunca.
 *
 * Corre contra la base de verdad. Los pedidos los crea y los borra la propia suite.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuario;
let idPuntoCaja;
const ids = {};

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

/** Crea un pedido en cocina con el estado y la antigüedad (en horas) dados. */
async function crear(clave, estado, horas) {
    const fila = await unaFila(
        `INSERT INTO restaurante.pedid_orden
            (id_negocio, id_usuario, numero_orden, estado, estado_cocina, id_punto_caja, fecha_creacion)
         VALUES (:n, :u, :num, :estado, 'PENDIENTE', :p, now() - make_interval(hours => :h))
         RETURNING id_orden;`,
        { n: idNegocio, u: idUsuario, num: `T-KDS-${Object.keys(ids).length}-${Date.now() % 100000}`, estado, p: idPuntoCaja, h: horas },
    );
    ids[clave] = fila.id_orden;
}

beforeAll(async () => {
    const base = await unaFila(
        `SELECT o.id_negocio, o.id_usuario, o.id_punto_caja
           FROM restaurante.pedid_orden o
          WHERE o.id_punto_caja IS NOT NULL
          ORDER BY o.id_orden DESC LIMIT 1;`,
    );
    if (!base) throw new Error('La base no tiene ningún pedido del que tomar negocio y caja.');
    ({ id_negocio: idNegocio, id_usuario: idUsuario, id_punto_caja: idPuntoCaja } = base);

    await crear('abierta_vieja', 'ABIERTA', 24 * 30);
    await crear('cerrada_reciente', 'CERRADA', 1);
    await crear('cerrada_vieja', 'CERRADA', 24 * 160);
    await crear('cancelada', 'CANCELADA', 1);
});

afterAll(async () => {
    const lista = Object.values(ids);
    if (lista.length) {
        await sequelize.query('DELETE FROM restaurante.pedid_orden WHERE id_orden IN (:lista);', {
            replacements: { lista },
        });
    }
    await sequelize.close();
});

describe('Cocina: qué comandas se ven', () => {
    let visibles;

    beforeAll(async () => {
        const ordenes = await pedidoService.getOrdenesCocina(idNegocio);
        visibles = new Set(ordenes.map((o) => o.id_orden));
    });

    test('un pedido ABIERTO se ve aunque tenga un mes', () => {
        expect(visibles.has(ids.abierta_vieja)).toBe(true);
    });

    test('un pedido cobrado hace 1 hora se ve (para llevar pagado al pedir, aún en el fogón)', () => {
        expect(visibles.has(ids.cerrada_reciente)).toBe(true);
    });

    test('un pedido cobrado hace meses ya no se ve', () => {
        expect(visibles.has(ids.cerrada_vieja)).toBe(false);
    });

    test('un pedido cancelado no se ve', () => {
        expect(visibles.has(ids.cancelada)).toBe(false);
    });
});
