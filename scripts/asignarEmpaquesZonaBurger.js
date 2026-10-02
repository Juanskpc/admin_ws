/**
 * Liga cada producto de Zona Burger (id_negocio 6) con su empaque.
 *
 * La asignación sale de los pedidos reales para llevar y a domicilio de los últimos 180 días: el
 * empaque que el personal usó en la gran mayoría de los pedidos de cada producto (ver la propuesta
 * revisada con el dueño). Productos que no aparecen aquí quedan SIN empaque (bebidas, `salchi
 * barril per`, `concurso`…).
 *
 * Requiere haber corrido `npm run migrate:restaurante-empaque-producto`.
 *
 *   node scripts/asignarEmpaquesZonaBurger.js            # simulación: muestra qué cambiaría
 *   node scripts/asignarEmpaquesZonaBurger.js --aplicar  # escribe
 *
 * Idempotente: volver a correrlo deja el mismo resultado. Comprueba que cada id exista en el
 * negocio y que los empaques se llamen como se espera, para no ligar a ciegas en otra base.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

const ID_NEGOCIO = 6;
const PEQUENO = 56; // «pequeño» $500
const MEDIANO = 57; // «mediano» $1.000

// [id_producto, id_empaque, cantidad por unidad]
const ASIGNACION = [
    // Pequeño: hamburguesas, salchipapas individuales, perros, alitas personal, costilla personal…
    ...[25, 26, 27, 28].map((id) => [id, PEQUENO, 1]), // Dulcinea, Dulce pecado, Pata-crunch, Discordia
    ...[29, 30, 31, 32].map((id) => [id, PEQUENO, 1]), // Salchi-limon, criollita, viciosa, the house
    [42, PEQUENO, 1], // perro loco
    [43, PEQUENO, 1], // smoked dog
    [40, PEQUENO, 1], // alitas personal
    [33, PEQUENO, 1], // choripapa
    [38, PEQUENO, 1], // costilla personal
    [147, PEQUENO, 1], // PANCETA (el personal usa pequeño)

    // Mediano: salchipapas medianas y grandes, alitas dobles, picada, parrillas, barril…
    ...[59, 60, 61, 62].map((id) => [id, MEDIANO, 1]), // criolla/the house/viciosa/salchi-limon mediana
    ...[63, 64, 65].map((id) => [id, MEDIANO, 1]), // criollita/viciosa/the house GRANDE
    [37, MEDIANO, 1], // picada zona burguer
    [41, MEDIANO, 1], // alitas dobles
    [34, MEDIANO, 1], // parrilla de cerdo
    [35, MEDIANO, 1], // parrilla de pollo
    [36, MEDIANO, 1], // parrillada de res
    [39, MEDIANO, 1], // costillas dobles
    [148, MEDIANO, 1], // BARRIL MEDIANO
    [73, MEDIANO, 1], // familiar: la mayoría de los pedidos lleva 1
    [76, MEDIANO, 3], // promo: casi siempre 3
];

async function main() {
    const aplicar = process.argv.includes('--aplicar');
    const q = Models.sequelize.query.bind(Models.sequelize);
    const SELECT = { type: Models.sequelize.QueryTypes.SELECT };

    const empaques = await q(
        `SELECT id_producto, nombre FROM restaurante.carta_producto
          WHERE id_negocio = :n AND id_producto IN (:ids)`,
        { replacements: { n: ID_NEGOCIO, ids: [PEQUENO, MEDIANO] }, ...SELECT }
    );
    const nombres = Object.fromEntries(empaques.map((e) => [e.id_producto, e.nombre]));
    if (nombres[PEQUENO] !== 'pequeño' || nombres[MEDIANO] !== 'mediano') {
        throw new Error(
            `Los empaques no son los esperados en el negocio ${ID_NEGOCIO}: ${JSON.stringify(nombres)}`
        );
    }

    const ids = ASIGNACION.map(([id]) => id);
    const productos = await q(
        `SELECT id_producto, nombre FROM restaurante.carta_producto
          WHERE id_negocio = :n AND id_producto IN (:ids)`,
        { replacements: { n: ID_NEGOCIO, ids }, ...SELECT }
    );
    const porId = new Map(productos.map((p) => [p.id_producto, p.nombre]));
    const faltan = ids.filter((id) => !porId.has(id));
    if (faltan.length) throw new Error(`Productos que no son del negocio ${ID_NEGOCIO}: ${faltan.join(', ')}`);

    const t = await Models.sequelize.transaction();
    try {
        for (const [id, empaque, cantidad] of ASIGNACION) {
            console.log(`${String(id).padStart(4)}  ${porId.get(id).padEnd(26)} → ${nombres[empaque]} × ${cantidad}`);
            if (aplicar) {
                await q(
                    `UPDATE restaurante.carta_producto
                        SET id_producto_empaque = :empaque, cantidad_empaque = :cantidad
                      WHERE id_producto = :id AND id_negocio = :n`,
                    { replacements: { id, empaque, cantidad, n: ID_NEGOCIO }, transaction: t }
                );
            }
        }
        if (aplicar) await t.commit();
        else await t.rollback();
        console.log(aplicar ? `\n✓ ${ASIGNACION.length} productos ligados.` : '\n(simulación: no se escribió nada)');
    } catch (e) {
        await t.rollback();
        throw e;
    } finally {
        await Models.sequelize.close();
    }
}

main().catch((e) => {
    console.error('✗', e.message);
    process.exitCode = 1;
});
