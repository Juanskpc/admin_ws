/**
 * Carta de demostración para «RESTAURANTE CHAYANE» (base de desarrollo).
 *
 * Uso:
 *   node scripts/fixtures/dev_carta_chayane.js
 *
 * ## Por qué las imágenes son SVG dentro de la base y no archivos
 *
 * Lo normal sería subir fotos a `uploads/restaurante/menu/<id_negocio>/producto/`, que es la
 * carpeta que sirve `app.js`. Pero esos archivos vivirían **en un solo PC**, y esta carta va a
 * una base **compartida**: el otro dev abriría el menú y vería todo roto.
 *
 * `resolveImg()` del menú público acepta `data:` además de rutas, así que la imagen viaja dentro
 * de la fila y se ve desde cualquier máquina — y también si algún día se restaura este volcado en
 * otro sitio. El límite es `varchar(500)`; los SVG de aquí ocupan ~390 caracteres, así que entran
 * con margen. Por eso el marcado está escrito apretado: sin atributos que valgan su valor por
 * defecto y con un `viewBox` de 4×3 en vez de 400×300.
 *
 * **No son fotos.** No se pueden generar fotografías desde aquí; son degradados con el emoji del
 * plato. Sirven para ver la carta con forma de carta —que es lo que se pidió— no para enseñárselo
 * a un cliente.
 *
 * ## Seguridad
 *
 * Comprueba id, tipo de negocio y nombre antes de escribir. Meterle la carta a otro negocio es de
 * las cosas que no se deshacen solas, y el id no es el mismo en cada base.
 *
 * Idempotente por (id_negocio, nombre): re-ejecutarlo no duplica ni pisa ediciones del panel.
 */
'use strict';
require('dotenv').config();

const Models = require('../../app_core/models/conection');

const ID_NEGOCIO = 17;
const NOMBRE_ESPERADO = 'RESTAURANTE CHAYANE';

/** Escape mínimo para meter SVG en un data URI sin inflarlo. */
function aDataUri(svg) {
    const escapado = svg
        .replace(/%/g, '%25')
        .replace(/</g, '%3C')
        .replace(/>/g, '%3E')
        .replace(/#/g, '%23')
        .replace(/"/g, "'")
        .replace(/ /g, '%20');
    return `data:image/svg+xml,${escapado}`;
}

function imagen(c1, c2, emoji) {
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 3'>` +
        `<defs><linearGradient id='g' x2='1' y2='1'>` +
        `<stop stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/>` +
        `</linearGradient></defs>` +
        `<rect width='4' height='3' fill='url(#g)'/>` +
        `<text x='2' y='2.3' font-size='1.5' text-anchor='middle'>${emoji}</text>` +
        `</svg>`;
    return aDataUri(svg);
}

/**
 * La carta. Precios en pesos completos: la app suma y cobra con ellos, así que «22» sería
 * veintidós pesos y no veintidós mil.
 */
const CARTA = [
    {
        nombre: 'Entradas',
        descripcion: 'Para picar mientras llega el plato',
        icono: '🥑',
        colores: ['#16A34A', '#065F46'],
        productos: [
            ['Patacón con hogao', 'Plátano verde aplastado y frito, con hogao de la casa y queso costeño.', 12000, '🫓', true],
            ['Empanadas de carne (x3)', 'Tres empanadas de maíz rellenas de carne desmechada, con ají casero.', 9000, '🥟', false],
            ['Chicharrón carnudo', 'Chicharrón crocante con arepa y limón.', 16000, '🥓', false],
        ],
    },
    {
        nombre: 'Hamburguesas',
        descripcion: 'Carne de res 150 g, pan artesanal',
        icono: '🍔',
        colores: ['#F97316', '#B91C1C'],
        productos: [
            ['Chayane Clásica', 'Carne de res, queso, lechuga, tomate y salsa de la casa.', 22000, '🍔', true],
            ['Doble Tocineta', 'Doble carne, doble queso cheddar y tocineta crocante.', 29000, '🥓', true],
            ['Pollo Crispy', 'Pechuga apanada, lechuga, tomate y salsa de miel y mostaza.', 24000, '🍗', false],
            ['Vegetariana de garbanzo', 'Torta de garbanzo y especias, con aguacate y pico de gallo.', 21000, '🥬', false],
        ],
    },
    {
        nombre: 'Platos fuertes',
        descripcion: 'Servidos con porción de acompañamiento',
        icono: '🍽️',
        colores: ['#B45309', '#78350F'],
        productos: [
            ['Bandeja paisa', 'Frijoles, arroz, carne molida, chicharrón, chorizo, huevo, plátano y arepa.', 34000, '🍛', true],
            ['Churrasco 300 g', 'Corte de res a la parrilla con chimichurri, papa criolla y ensalada.', 42000, '🥩', false],
            ['Mojarra frita', 'Mojarra entera con patacón, arroz con coco y ensalada.', 38000, '🐟', false],
            ['Pechuga a la plancha', 'Pechuga de pollo con verduras salteadas y puré de papa.', 28000, '🍗', false],
        ],
    },
    {
        nombre: 'Perros y salchipapas',
        descripcion: 'Lo de siempre, bien hecho',
        icono: '🌭',
        colores: ['#EAB308', '#A16207'],
        productos: [
            ['Perro Chayane', 'Salchicha americana, queso, papa ripio, piña y salsas.', 18000, '🌭', false],
            ['Salchipapa clásica', 'Papa a la francesa con salchicha y salsas de la casa.', 17000, '🍟', true],
            ['Salchipapa especial', 'Con carne desmechada, maíz tierno, queso y tocineta.', 24000, '🍟', false],
        ],
    },
    {
        nombre: 'Bebidas',
        descripcion: 'Frías y naturales',
        icono: '🥤',
        colores: ['#0EA5E9', '#1E40AF'],
        productos: [
            ['Limonada de coco', 'Limonada cremosa de coco, servida en jarra personal.', 9000, '🥥', true],
            ['Jugo natural en agua', 'Mora, maracuyá, lulo o mango. Pregunta por el del día.', 7000, '🧃', false],
            ['Gaseosa 400 ml', 'Surtida, bien fría.', 5000, '🥤', false],
            ['Cerveza nacional', 'Botella 330 ml.', 7000, '🍺', false],
        ],
    },
    {
        nombre: 'Postres',
        descripcion: 'Para cerrar',
        icono: '🍰',
        colores: ['#EC4899', '#9D174D'],
        productos: [
            ['Torta de chocolate', 'Porción generosa con salsa de chocolate caliente.', 11000, '🍰', false],
            ['Flan de caramelo', 'Flan casero con caramelo y crema.', 9000, '🍮', false],
        ],
    },
];

async function main() {
    const t = await Models.sequelize.transaction();
    try {
        // ── Comprobación previa: que sea el negocio que creemos ──────────────────────────
        const negocio = await Models.sequelize.query(
            `SELECT id_negocio, nombre, id_tipo_negocio, estado
               FROM general.gener_negocio WHERE id_negocio = :id;`,
            {
                replacements: { id: ID_NEGOCIO },
                transaction: t,
                type: Models.sequelize.QueryTypes.SELECT,
            }
        );

        if (negocio.length === 0) {
            throw new Error(`No existe el negocio ${ID_NEGOCIO} en esta base.`);
        }
        const n = negocio[0];
        if (n.nombre.trim().toUpperCase() !== NOMBRE_ESPERADO) {
            throw new Error(
                `El negocio ${ID_NEGOCIO} se llama «${n.nombre}», no «${NOMBRE_ESPERADO}». ` +
                    `Abortando para no meterle la carta a otro cliente.`
            );
        }
        if (Number(n.id_tipo_negocio) !== 1) {
            throw new Error(`El negocio ${ID_NEGOCIO} no es de tipo RESTAURANTE.`);
        }

        console.log(`Negocio ${n.id_negocio} · ${n.nombre} — verificado.`);

        let catsNuevas = 0;
        let prodsNuevos = 0;
        let orden = 1;

        for (const cat of CARTA) {
            const [c1, c2] = cat.colores;

            const existente = await Models.sequelize.query(
                `SELECT id_categoria FROM restaurante.carta_categoria
                  WHERE id_negocio = :id AND upper(nombre) = upper(:nombre) LIMIT 1;`,
                {
                    replacements: { id: ID_NEGOCIO, nombre: cat.nombre },
                    transaction: t,
                    type: Models.sequelize.QueryTypes.SELECT,
                }
            );

            let idCategoria;
            if (existente.length > 0) {
                idCategoria = existente[0].id_categoria;
            } else {
                const creada = await Models.sequelize.query(
                    `INSERT INTO restaurante.carta_categoria
                        (id_negocio, nombre, descripcion, icono, orden, estado, visible, imagen_url)
                     VALUES (:id, :nombre, :descripcion, :icono, :orden, 'A', true, :imagen)
                     RETURNING id_categoria;`,
                    {
                        replacements: {
                            id: ID_NEGOCIO,
                            nombre: cat.nombre,
                            descripcion: cat.descripcion,
                            icono: cat.icono,
                            orden: orden,
                            imagen: imagen(c1, c2, cat.icono),
                        },
                        transaction: t,
                        type: Models.sequelize.QueryTypes.SELECT,
                    }
                );
                idCategoria = creada[0].id_categoria;
                catsNuevas++;
            }
            orden++;

            for (const [nombre, descripcion, precio, emoji, popular] of cat.productos) {
                const yaEsta = await Models.sequelize.query(
                    `SELECT 1 FROM restaurante.carta_producto
                      WHERE id_negocio = :id AND upper(nombre) = upper(:nombre) LIMIT 1;`,
                    {
                        replacements: { id: ID_NEGOCIO, nombre },
                        transaction: t,
                        type: Models.sequelize.QueryTypes.SELECT,
                    }
                );
                if (yaEsta.length > 0) continue;

                await Models.sequelize.query(
                    `INSERT INTO restaurante.carta_producto
                        (id_negocio, id_categoria, nombre, descripcion, precio,
                         imagen_url, icono, es_popular, disponible, estado, visible)
                     VALUES (:id, :cat, :nombre, :descripcion, :precio,
                             :imagen, :icono, :popular, true, 'A', true);`,
                    {
                        replacements: {
                            id: ID_NEGOCIO,
                            cat: idCategoria,
                            nombre,
                            descripcion,
                            precio,
                            imagen: imagen(c1, c2, emoji),
                            icono: emoji,
                            popular,
                        },
                        transaction: t,
                    }
                );
                prodsNuevos++;
            }
        }

        const totales = await Models.sequelize.query(
            `SELECT
               (SELECT count(*)::int FROM restaurante.carta_categoria
                 WHERE id_negocio = :id AND estado = 'A') AS categorias,
               (SELECT count(*)::int FROM restaurante.carta_producto
                 WHERE id_negocio = :id AND estado = 'A') AS productos,
               (SELECT count(*)::int FROM restaurante.carta_producto
                 WHERE id_negocio = :id AND imagen_url IS NOT NULL) AS con_imagen;`,
            {
                replacements: { id: ID_NEGOCIO },
                transaction: t,
                type: Models.sequelize.QueryTypes.SELECT,
            }
        );

        await t.commit();

        console.log(`\nCreadas ahora: ${catsNuevas} categorías, ${prodsNuevos} productos.`);
        console.log(
            `Total en la carta: ${totales[0].categorias} categorías · ` +
                `${totales[0].productos} productos · ${totales[0].con_imagen} con imagen.`
        );
        console.log(`\nMenú público:  /restaurante/carta/${ID_NEGOCIO}`);
        console.log('✓ Listo.');
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

main()
    .then(() => Models.sequelize.close())
    .catch(async (error) => {
        console.error('Falló el fixture:', error.message);
        await Models.sequelize.close();
        process.exit(1);
    });
