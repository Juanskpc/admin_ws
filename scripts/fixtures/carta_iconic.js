/**
 * Carga la carta de «ICONIC» — cliente nuevo, promoción de registro de menú.
 *
 * Uso:
 *   node scripts/fixtures/carta_iconic.js              # ENSAYO: no escribe nada, solo informa
 *   node scripts/fixtures/carta_iconic.js --aplicar    # escribe
 *
 * ## Por qué no hay un id_negocio escrito a mano
 *
 * El id no es el mismo en cada base y meterle la carta al negocio equivocado no se deshace solo.
 * Aquí se resuelve desde el documento del administrador: si ese documento no lleva a exactamente
 * un negocio de tipo RESTAURANTE, el script aborta antes de escribir una sola fila.
 *
 * ## Imágenes
 *
 * `imagen_url` se deja en NULL a propósito. El menú público cae al emoji de `icono` cuando no hay
 * foto (`resolveImg()` devuelve '' y la plantilla muestra el emoji), así que la carta se ve
 * completa desde el primer día y el cliente sube sus fotos reales desde el panel. Meter aquí
 * degradados con emoji dentro de un data URI —como en el fixture de desarrollo— dejaría al cliente
 * con imágenes falsas que después hay que borrar una por una.
 *
 * Idempotente por (id_negocio, upper(nombre)): re-ejecutarlo no duplica ni pisa ediciones hechas
 * desde el panel.
 */
'use strict';
require('dotenv').config();

const Models = require('../../app_core/models/conection');

/** Documento del administrador del restaurante. */
const DOCUMENTO_ADMIN = '1193216114';
/** id de general.gener_tipo_negocio para RESTAURANTE. */
const TIPO_RESTAURANTE = 1;

const APLICAR = process.argv.includes('--aplicar');

/**
 * La carta, tal como está en las tres páginas del menú impreso.
 * Precios en pesos completos: la app suma y cobra con ellos, así que «20» sería veinte pesos.
 * Producto: [nombre, descripción, precio, emoji].
 */
const CARTA = [
    {
        nombre: 'Carnes',
        descripcion: 'A la plancha, con porción de papa y patacón',
        icono: '🥩',
        productos: [
            ['Carnes a la plancha', 'Carne de res, cerdo o pechuga acompañada de porción de papa y patacón.', 20000, '🥩'],
            ['Chuletas', 'Chuleta de cerdo o pollo acompañada de porción de papa y patacón.', 18000, '🍖'],
        ],
    },
    {
        nombre: 'Alitas y Costillas BBQ',
        descripcion: 'Bañadas en salsa BBQ de la casa',
        icono: '🍗',
        productos: [
            ['Alitas sencilla (4)', 'Jugosas alitas de la casa bañadas en salsa BBQ o apanadas, acompañadas de porción de papa.', 14000, '🍗'],
            ['Alitas doble (10)', 'Jugosas alitas de la casa bañadas en salsa BBQ o apanadas, acompañadas de porción de papa.', 30000, '🍗'],
            ['Costilla BBQ', '250 gr de costilla bañada en salsa BBQ de la casa, con porción de papa a la francesa.', 22000, '🍖'],
        ],
    },
    {
        nombre: 'Picadas',
        descripcion: 'Para compartir',
        icono: '🍢',
        productos: [
            ['Picada pequeña', '200 gr de carne mixta servida sobre maicenas, papa a la francesa, plátanos fritos, salchicha y chorizo santarrosano.', 30000, '🍢'],
            ['Picada (3 personas)', '400 gr de carne mixta servida sobre maicenas, papa a la francesa, plátanos fritos, salchicha y chorizo santarrosano.', 50000, '🍢'],
            ['Picada (5 personas)', '500 gr de carne mixta, costilla ahumada y alitas sobre papa a la francesa, plátanos fritos, salchicha y chorizo santarrosano. Incluye jarra de limonada.', 70000, '🍢'],
        ],
    },
    {
        nombre: 'Bandejas',
        descripcion: 'Carne al gusto con arroz, papa, principio del día, ensalada y bebida',
        icono: '🍛',
        productos: [
            ['Bandeja de cerdo', 'Carne al gusto acompañada de porción de arroz, papa a la francesa, principio del día, ensalada y bebida.', 13000, '🍛'],
            ['Bandeja de pechuga', 'Carne al gusto acompañada de porción de arroz, papa a la francesa, principio del día, ensalada y bebida.', 13000, '🍛'],
            ['Bandeja de chuleta', 'Carne al gusto acompañada de porción de arroz, papa a la francesa, principio del día, ensalada y bebida.', 13000, '🍛'],
            ['Bandeja de res', 'Carne al gusto acompañada de porción de arroz, papa a la francesa, principio del día, ensalada y bebida.', 15000, '🍛'],
            ['Bandeja de costilla ahumada', 'Carne al gusto acompañada de porción de arroz, papa a la francesa, principio del día, ensalada y bebida.', 17000, '🍛'],
            ['Bandeja de alitas BBQ', 'Carne al gusto acompañada de porción de arroz, papa a la francesa, principio del día, ensalada y bebida.', 17000, '🍛'],
            ['Bandeja de trucha', 'Carne al gusto acompañada de porción de arroz, papa a la francesa, principio del día, ensalada y bebida.', 22000, '🐟'],
        ],
    },
    {
        nombre: 'Salchipapas',
        descripcion: 'La especialidad de la casa',
        icono: '🍟',
        productos: [
            ['Salchipapa tradicional', 'Papa a la francesa, salchicha y salsas de la casa.', 10000, '🍟'],
            ['Salchipapa ranchera', 'Papa a la francesa, salchicha ranchera y salsas de la casa.', 18000, '🌭'],
            ['Gratinada sencilla', 'Papa a la francesa, salchicha premium, jamón, queso gratinado, papa ripio, maicitos y salsas.', 13000, '🧀'],
            ['Gratinada doble', 'Papa a la francesa, salchicha premium, queso gratinado, tocineta ahumada, jamón, papa ripio, 2 huevos de codorniz y salsas.', 20000, '🧀'],
            ['La marrana', 'Papa a la francesa, carne de cerdo desmechada, salchicha premium, tocineta ahumada, maduritos y salsas.', 16000, '🐷'],
            ['Salchipapa mixta', 'Papa a la francesa, salchicha macopollo, carne de res y pollo desmechada, maicitos, tocineta ahumada, maduritos, costilla ahumada y salsas.', 22000, '🍟'],
            ['Salchipapa mixta doble', 'Papa a la francesa, salchicha macopollo, carne de res y pollo desmechada, maicitos, tocineta ahumada, maduritos, costilla ahumada y salsas.', 35000, '🍟'],
            ['La gran criolla', 'Papa criolla, salchicha macopollo, queso gratinado, costilla BBQ, chorizo, pollo desmechado, piña calada y salsas.', 18000, '🥔'],
            ['La mera, mera', 'Papa a la francesa, salchicha macopollo, carne de res desmechada, guacamole, maicitos, tostacos, huevos de codorniz y salsas.', 18000, '🍟'],
        ],
    },
    {
        nombre: 'Hamburguesas',
        descripcion: 'Pan brioche y carne de la casa',
        icono: '🍔',
        productos: [
            ['Clásica sencilla', 'Pan brioche, carne de la casa, jamón, queso mozzarella, cebolla caramelizada, tomate, lechuga, papa ripio y salsas de la casa, acompañada de porción de papa.', 14000, '🍔'],
            ['Clásica doble', 'Pan brioche, doble carne de la casa, jamón, queso mozzarella y americano, tomate, lechuga, papa ripio, tocineta ahumada, maicitos y salsas, acompañada de papa a la francesa.', 22000, '🍔'],
            ['Hawaiana', 'Pan brioche, carne de la casa, tocineta ahumada, lechuga, piña calada en salsa BBQ y queso mozzarella, acompañada de porción de papa.', 18000, '🍍'],
            ['Mexicana', 'Pan brioche, carne de la casa, queso americano fundido, pepinillos, doritos, guacamole y salsas, acompañada de porción de papa.', 18000, '🌶️'],
            ['Americana', 'Pan brioche, doble carne de la casa, queso americano fundido, cebolla caramelizada y tocineta ahumada, acompañada de porción de papa.', 18000, '🍔'],
            ['Doble impacto', 'Pan brioche, carne de la casa, queso mozzarella, lechuga, tomate, jamón, tocineta ahumada y pollo desmechado, acompañada de porción de papa.', 18000, '🍔'],
        ],
    },
    {
        nombre: 'Hot Dogs',
        descripcion: 'Pan brioche recién horneado',
        icono: '🌭',
        productos: [
            ['Perro sencillo', 'Pan brioche, salchicha Sevilla, jamón, queso mozzarella, papa ripio, cebolla caramelizada y salsas.', 7000, '🌭'],
            ['Perro Iconic especial', 'Pan brioche, salchicha ranchera, doble jamón, queso mozzarella gratinado, tocineta ahumada, maicitos, cebolla caramelizada y salsas.', 13000, '🌭'],
            ['Perro hawaiano', 'Pan brioche, salchicha ranchera, tocineta ahumada, queso gratinado, piña calada en salsa BBQ, maicitos y salsas.', 13000, '🍍'],
            ['Perro mexicano', 'Pan brioche, salchicha ranchera, pepinillos, guacamole, doritos, queso fundido y papa ripio.', 13000, '🌶️'],
            ['Glow dog', 'Pan brioche, salchicha de pollo, queso gratinado, papa ripio y pollo desmechado.', 14000, '✨'],
        ],
    },
    {
        nombre: 'Sándwich Cubano',
        descripcion: 'En pan brioche cubano',
        icono: '🥪',
        productos: [
            ['Sándwich mexicano', 'Pan brioche cubano, carne desmechada, lechuga, tomate, tostacos, salsa picante y guacamole.', 18000, '🌶️'],
            ['Sándwich de pollo', 'Pan brioche cubano, lechuga, tomate, cebolla, jamón, queso mozzarella y pollo en salsa de la casa.', 18000, '🍗'],
            ['Sándwich de atún', 'Pan brioche cubano, lechuga, tomate, atún en salsa de la casa, queso mozzarella y cebolla caramelizada.', 18000, '🐟'],
            ['Sándwich cubano', 'Pan brioche cubano, pepinillos, queso mozzarella, jamón y cerdo desmechado.', 18000, '🥪'],
        ],
    },
    {
        nombre: 'Dorilocos',
        descripcion: 'Doritos cargados',
        icono: '🌮',
        productos: [
            ['Dorilocos', 'Doritos, carne de res desmechada, queso mozzarella, salchicha, maicitos, guacamole y pico de gallo.', 15000, '🌮'],
        ],
    },
    {
        nombre: 'Tostón',
        descripcion: 'Patacón de la casa',
        icono: '🫓',
        productos: [
            ['Don Patacón', '3 porciones de patacón acompañadas de queso gratinado, guacamole, carne de res desmechada, maicitos y 3 huevos de codorniz.', 17000, '🫓'],
        ],
    },
    {
        nombre: 'Heladería',
        descripcion: 'Postres, helados y frutas',
        icono: '🍨',
        productos: [
            ['Ensalada de frutas pequeña', 'Banano, papaya, mango, fresa, manzana, kiwi, crema de leche, queso doble crema, helado, galleta y glass.', 6000, '🍉'],
            ['Ensalada de frutas mediana', 'Banano, papaya, mango, fresa, manzana, kiwi, crema de leche, queso doble crema, helado, galleta y glass.', 9000, '🍉'],
            ['Ensalada de frutas grande', 'Banano, papaya, mango, fresa, manzana, kiwi, crema de leche, queso doble crema, helado, galleta y glass.', 12000, '🍉'],
            ['Waffle de fruta', 'Waffle, salsa de fresa, fresas, cerezas, mora, helado y crema chantilly.', 15000, '🧇'],
            ['Fresa con crema grande', 'Porción de fresa, crema de leche y queso doble crema.', 8000, '🍓'],
            ['Porción de gelada', 'Porción de gelada.', 5000, '🍮'],
            ['Copa de helado pequeña', 'Copa de helado de la casa.', 7000, '🍦'],
            ['Copa de helado grande', 'Copa de helado de la casa.', 10000, '🍦'],
            ['Banana split', 'Banano, helado, crema chantilly y salsas.', 12000, '🍌'],
            ['Revolcón de dulce de fruta', 'A elegir: fresa, piña o mora.', 6000, '🍓'],
            ['Revolcón de helado', 'Revolcón de helado de la casa.', 8000, '🍨'],
            ['Porción de fruta', 'Porción de fruta de la temporada.', 6000, '🥭'],
            ['Brownie con helado', 'Brownie acompañado de crema de leche, queso doble crema, cereza, galleta, porción de helado y fruta.', 10000, '🍫'],
        ],
    },
    {
        nombre: 'Bebidas Frías',
        descripcion: 'Jugos, malteadas, granizados y micheladas',
        icono: '🥤',
        productos: [
            ['Jugos naturales en agua', 'Lulo, maracuyá, mora, tomate, fresa, limonada o mango.', 5000, '🧃'],
            ['Jugos naturales en leche', 'Maracuyá, mora, tomate, fresa o banano.', 7000, '🥛'],
            ['Malteadas', 'Chocolate, vainilla, frutos rojos o maracuyá.', 10000, '🥤'],
            ['Limonada cerezada', 'Limonada cerezada de la casa.', 10000, '🍋'],
            ['Granizados', 'Lulo, maracuyá, mango o mora.', 10000, '🧊'],
            ['Michelada Águila, Poker o Club Colombia', 'Michelada preparada de la casa.', 10000, '🍺'],
            ['Michelada Corona', 'Michelada preparada de la casa.', 12000, '🍺'],
            ['Sodas italianas', 'Frutos rojos, frutos amarillos o frutos verdes.', 10000, '🥤'],
            // El menú impreso las lista sin precio. Entran en 0 por decisión del negocio:
            // ⚠️ hay que ponerles precio desde el panel ANTES de venderlas, o el POS cobra cero.
            ['Cerveza', 'Consultar disponibilidad y precio.', 0, '🍺'],
            ['Gaseosa', 'Consultar disponibilidad y precio.', 0, '🥤'],
        ],
    },
    {
        nombre: 'Bebidas Calientes',
        descripcion: 'Café, aromáticas y hervidos',
        icono: '☕',
        productos: [
            ['Café negro', 'Café negro de la casa.', 2000, '☕'],
            ['Café con leche', 'Café con leche de la casa.', 3000, '☕'],
            ['Aromática', 'Aromática de la casa.', 2000, '🍵'],
            ['Aromática de frutas', 'Aromática de frutas de la casa.', 5000, '🍵'],
            ['Chocolate', 'Chocolate caliente.', 4000, '🍫'],
            ['Agua de panela', 'Agua de panela caliente.', 3000, '🫖'],
            ['Hervidos de frutas', 'Lulo, mora o maracuyá.', 9000, '🍹'],
        ],
    },
];

/** Resuelve el negocio del administrador y verifica que sea uno y de tipo RESTAURANTE. */
async function resolverNegocio(t) {
    const usuarios = await Models.sequelize.query(
        `SELECT id_usuario, primer_nombre, primer_apellido, email, estado
           FROM general.gener_usuario
          WHERE num_identificacion = :doc;`,
        { replacements: { doc: DOCUMENTO_ADMIN }, transaction: t, type: Models.sequelize.QueryTypes.SELECT }
    );
    if (usuarios.length === 0) {
        throw new Error(`No existe ningún usuario con documento ${DOCUMENTO_ADMIN} en esta base.`);
    }
    const u = usuarios[0];

    const negocios = await Models.sequelize.query(
        `SELECT n.id_negocio, n.nombre, n.id_tipo_negocio, n.estado
           FROM general.gener_negocio_usuario nu
           JOIN general.gener_negocio n ON n.id_negocio = nu.id_negocio
          WHERE nu.id_usuario = :id AND nu.estado = 'A'
          ORDER BY n.id_negocio;`,
        { replacements: { id: u.id_usuario }, transaction: t, type: Models.sequelize.QueryTypes.SELECT }
    );
    if (negocios.length === 0) {
        throw new Error(`El usuario ${u.id_usuario} no tiene ningún negocio asociado.`);
    }
    if (negocios.length > 1) {
        const lista = negocios.map((n) => `${n.id_negocio} (${n.nombre})`).join(', ');
        throw new Error(
            `El usuario ${u.id_usuario} tiene varios negocios: ${lista}. ` +
                `Abortando: hay que decidir a mano a cuál va la carta.`
        );
    }
    const n = negocios[0];
    if (Number(n.id_tipo_negocio) !== TIPO_RESTAURANTE) {
        throw new Error(
            `El negocio ${n.id_negocio} («${n.nombre}») es de tipo ${n.id_tipo_negocio}, no RESTAURANTE.`
        );
    }

    console.log(`Usuario  ${u.id_usuario} · ${u.primer_nombre} ${u.primer_apellido} · ${u.email}`);
    console.log(`Negocio  ${n.id_negocio} · ${n.nombre} · tipo RESTAURANTE · estado ${n.estado}`);
    return n.id_negocio;
}

async function main() {
    console.log(APLICAR ? '\n== MODO APLICAR: se va a escribir ==\n' : '\n== ENSAYO (sin --aplicar no se escribe nada) ==\n');

    const t = await Models.sequelize.transaction();
    try {
        const ID_NEGOCIO = await resolverNegocio(t);

        let catsNuevas = 0;
        let catsExistentes = 0;
        let prodsNuevos = 0;
        let prodsExistentes = 0;

        // Continúa la numeración de las categorías que ya tenga el negocio.
        const [{ max_orden: maxOrden }] = await Models.sequelize.query(
            `SELECT COALESCE(max(orden), 0)::int AS max_orden
               FROM restaurante.carta_categoria WHERE id_negocio = :id;`,
            { replacements: { id: ID_NEGOCIO }, transaction: t, type: Models.sequelize.QueryTypes.SELECT }
        );
        let orden = maxOrden + 1;

        for (const cat of CARTA) {
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
                catsExistentes++;
            } else {
                const creada = await Models.sequelize.query(
                    `INSERT INTO restaurante.carta_categoria
                        (id_negocio, nombre, descripcion, icono, orden, estado, visible)
                     VALUES (:id, :nombre, :descripcion, :icono, :orden, 'A', true)
                     RETURNING id_categoria;`,
                    {
                        replacements: {
                            id: ID_NEGOCIO,
                            nombre: cat.nombre,
                            descripcion: cat.descripcion,
                            icono: cat.icono,
                            orden,
                        },
                        transaction: t,
                        type: Models.sequelize.QueryTypes.SELECT,
                    }
                );
                idCategoria = creada[0].id_categoria;
                catsNuevas++;
                orden++;
            }

            for (const [nombre, descripcion, precio, icono] of cat.productos) {
                const yaEsta = await Models.sequelize.query(
                    `SELECT 1 FROM restaurante.carta_producto
                      WHERE id_negocio = :id AND upper(nombre) = upper(:nombre) LIMIT 1;`,
                    {
                        replacements: { id: ID_NEGOCIO, nombre },
                        transaction: t,
                        type: Models.sequelize.QueryTypes.SELECT,
                    }
                );
                if (yaEsta.length > 0) {
                    prodsExistentes++;
                    continue;
                }

                await Models.sequelize.query(
                    `INSERT INTO restaurante.carta_producto
                        (id_negocio, id_categoria, nombre, descripcion, precio,
                         icono, es_popular, disponible, estado, visible)
                     VALUES (:id, :cat, :nombre, :descripcion, :precio,
                             :icono, false, true, 'A', true);`,
                    {
                        replacements: { id: ID_NEGOCIO, cat: idCategoria, nombre, descripcion, precio, icono },
                        transaction: t,
                    }
                );
                prodsNuevos++;
            }
        }

        const [totales] = await Models.sequelize.query(
            `SELECT
               (SELECT count(*)::int FROM restaurante.carta_categoria
                 WHERE id_negocio = :id AND estado = 'A') AS categorias,
               (SELECT count(*)::int FROM restaurante.carta_producto
                 WHERE id_negocio = :id AND estado = 'A') AS productos,
               (SELECT count(*)::int FROM restaurante.carta_producto
                 WHERE id_negocio = :id AND estado = 'A' AND precio = 0) AS sin_precio;`,
            { replacements: { id: ID_NEGOCIO }, transaction: t, type: Models.sequelize.QueryTypes.SELECT }
        );

        console.log(
            `\nCategorías: ${catsNuevas} nuevas, ${catsExistentes} ya estaban.` +
                `\nProductos:  ${prodsNuevos} nuevos, ${prodsExistentes} ya estaban.`
        );
        console.log(`Quedaría la carta con ${totales.categorias} categorías y ${totales.productos} productos.`);
        if (totales.sin_precio > 0) {
            console.log(
                `\n⚠️  ${totales.sin_precio} producto(s) quedan en $0 (cerveza y gaseosa: el menú no las tarifa). ` +
                    `Ponles precio desde el panel antes de venderlos, o el POS cobra cero.`
            );
        }

        if (APLICAR) {
            await t.commit();
            console.log(`\n✓ Escrito. Menú público: /restaurante/carta/${ID_NEGOCIO}`);
        } else {
            await t.rollback();
            console.log('\nEnsayo: no se escribió nada. Repite con --aplicar para confirmar.');
        }
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

main()
    .then(() => Models.sequelize.close())
    .catch(async (error) => {
        console.error('\nFalló la carga de la carta:', error.message);
        await Models.sequelize.close();
        process.exit(1);
    });
