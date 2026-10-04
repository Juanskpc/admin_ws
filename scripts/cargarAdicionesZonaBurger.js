/**
 * Carga la sección ADICIONALES de Zona Burger (id_negocio 6) tal como está en su carta impresa.
 *
 * Por qué: los clientes piden «con adición de papa», «con queso gratinado», «chicharrón y maicitos»
 * (2026-10-03) y el asistente no tenía dónde buscarlas, así que pasaba la conversación a una persona.
 * Como productos de una categoría, el asistente las busca, las suma como un producto aparte (que es
 * como las cobra el personal) y salen en la carta digital.
 *
 *   node scripts/cargarAdicionesZonaBurger.js            # simulación: muestra qué haría
 *   node scripts/cargarAdicionesZonaBurger.js --aplicar  # escribe
 *
 * Idempotente: crea la categoría si no existe y, por nombre, cada producto que falte; los que ya
 * existen no se tocan (ni su precio: si el dueño lo cambió desde Menú, se respeta).
 *
 * Sin empaque a propósito (`id_producto_empaque` NULL): es decisión del dueño si las porciones
 * llevan envase; se puede ligar desde Menú → editar producto.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

const ID_NEGOCIO = 6;
const CATEGORIA = 'ADICIONALES';

// Nombre y precio como en la carta impresa.
const ADICIONES = [
    ['Costilla ahumada', 5000],
    ['Queso gratinado', 3000],
    ['Carne de hamburguesa', 6000],
    ['Porción de papa', 6000],
    ['Chicharrón', 6000],
    ['Porción de maicitos', 3000],
    ['Porción de patacón', 4000],
];

const aplicar = process.argv.includes('--aplicar');

(async () => {
    const t = await Models.sequelize.transaction();
    try {
        const [negocio] = await Models.sequelize.query(
            'SELECT nombre FROM general.gener_negocio WHERE id_negocio = :id',
            { replacements: { id: ID_NEGOCIO }, type: 'SELECT', transaction: t }
        );
        if (!negocio) throw new Error(`No existe el negocio ${ID_NEGOCIO} en esta base.`);
        console.log(`Negocio ${ID_NEGOCIO}: ${negocio.nombre} — ${aplicar ? 'APLICANDO' : 'simulación'}\n`);

        let categoria = await Models.CartaCategoria.findOne({
            where: { id_negocio: ID_NEGOCIO, nombre: CATEGORIA },
            transaction: t,
        });
        if (categoria) {
            console.log(`Categoría ${CATEGORIA}: ya existe (id ${categoria.id_categoria}).`);
        } else {
            const orden = ((await Models.CartaCategoria.max('orden', { where: { id_negocio: ID_NEGOCIO }, transaction: t })) || 0) + 1;
            console.log(`Categoría ${CATEGORIA}: se crea (orden ${orden}).`);
            if (aplicar) {
                categoria = await Models.CartaCategoria.create(
                    {
                        id_negocio: ID_NEGOCIO,
                        nombre: CATEGORIA,
                        descripcion: 'Agrégale algo más a tu pedido',
                        orden,
                        visible: true,
                        estado: 'A',
                    },
                    { transaction: t }
                );
            }
        }

        for (const [nombre, precio] of ADICIONES) {
            const existente = categoria
                ? await Models.CartaProducto.findOne({
                      where: { id_negocio: ID_NEGOCIO, id_categoria: categoria.id_categoria, nombre },
                      transaction: t,
                  })
                : null;
            if (existente) {
                console.log(`  = ${nombre}: ya existe ($${Number(existente.precio)}), no se toca.`);
                continue;
            }
            console.log(`  + ${nombre} — $${precio}`);
            if (aplicar) {
                await Models.CartaProducto.create(
                    {
                        id_negocio: ID_NEGOCIO,
                        id_categoria: categoria.id_categoria,
                        nombre,
                        descripcion: 'Adición para tu pedido',
                        precio,
                        es_popular: false,
                        disponible: true,
                        visible: true,
                        estado: 'A',
                        cantidad_empaque: 1,
                    },
                    { transaction: t }
                );
            }
        }

        if (aplicar) await t.commit();
        else await t.rollback();
        console.log(aplicar ? '\n✓ Listo.' : '\n(simulación: no se escribió nada; usa --aplicar)');
    } catch (e) {
        await t.rollback();
        console.error('✗', e.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
})();
