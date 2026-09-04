-- Carta de «El Callejero Fast Food» — categorías y productos.
--
-- ## Por qué existe
--
-- El negocio pidió tener su menú cargado para empezar a probar la app. Son ~32 productos con
-- descripción larga: escribirlos a mano en el panel es una tarde y un puñado de erratas.
--
-- ⚠️ **Son datos REALES de un cliente**, no un demo. A diferencia de `prod_carta_pregonchos.sql`
-- aquí no hay prefijo «(demo)» y no hay que borrar nada después: esta es su carta de verdad.
--
-- ## Parámetros (obligatorios los dos, a propósito)
--
--   psql ... -v id_negocio=3 -v negocio="Restaurante Rival" -f scripts/fixtures/carta_el_callejero.sql
--
-- El id y el nombre tienen que coincidir con la misma fila activa o aborta. Meterle la carta de
-- un cliente al negocio de otro es de las cosas que no se deshacen solas, y el id de un negocio
-- no es el mismo en local que en producción.
--
-- ## Decisiones que conviene conocer
--
--   · **Precios ×1000.** La cartelera dice «$ 19»; en Colombia eso es 19.000 COP. Se guardan
--     completos porque la app suma y cobra con ellos.
--   · **«Salchipapa Clásica» en vez de «Clásica».** En la cartelera hay dos productos llamados
--     «CLÁSICA» (una hamburguesa de 19.000 y una salchipapa de 16.000). La carta impresa los
--     separa con el encabezado de la sección, pero el asistente de WhatsApp lista los productos
--     en una sola columna de «nombre — precio»: dos «Clásica» con precios distintos en el mismo
--     mensaje es una pregunta del cliente garantizada. El nombre de la hamburguesa se respeta.
--   · **`es_popular` en false para todo.** Es la bandera que sube productos a la cabeza del
--     mensaje del bot. «Recomendados de la casa» es el nombre de una sección, no una medición:
--     marcarla entera equivale a no marcar nada. Que el negocio elija sus 3 o 4.
--   · **Desechable como producto.** «Recuerde que para llevar son 1 mil por desechable» es un
--     cobro, y en este modelo un cobro se representa con una línea del pedido. Va en Adicionales.
--
-- Idempotente por nombre: re-ejecutarlo no duplica ni pisa ediciones hechas desde el panel.

-- psql NO interpola variables dentro de un bloque $$…$$, así que entran por una tabla temporal.
CREATE TEMP TABLE _param AS
    SELECT :id_negocio::integer AS id_negocio, :'negocio'::text AS negocio;

DO $$
DECLARE
    v_id_negocio integer;
    v_esperado   text;
    v_real       text;
    v_ham        integer;
    v_rec        integer;
    v_sal        integer;
    v_adi        integer;
BEGIN
    SELECT id_negocio, negocio INTO v_id_negocio, v_esperado FROM _param;

    SELECT nombre INTO v_real
      FROM general.gener_negocio
     WHERE id_negocio = v_id_negocio AND estado = 'A';

    IF v_real IS DISTINCT FROM v_esperado THEN
        RAISE EXCEPTION 'El negocio % activo se llama "%", no "%". Abortado.',
            v_id_negocio, COALESCE(v_real, '(no existe o inactivo)'), v_esperado;
    END IF;

    -- ── Categorías ───────────────────────────────────────────────────────────
    INSERT INTO restaurante.carta_categoria (id_negocio, nombre, descripcion, icono, orden, visible, estado)
    SELECT v_id_negocio, c.nombre, c.descripcion, c.icono, c.orden, true, 'A'
      FROM (VALUES
            ('Hamburguesas',            'Todas nuestras hamburguesas van acompañadas de papa', '🍔', 1),
            ('Recomendados de la casa', 'Lo que más se pide en la calle',                      '⭐', 2),
            ('Salchipapas',             'Con papa y salsas de la casa',                        '🍟', 3),
            ('Adicionales',             'Para armar tu pedido a tu gusto',                     '➕', 4)
           ) AS c(nombre, descripcion, icono, orden)
     WHERE NOT EXISTS (
        SELECT 1 FROM restaurante.carta_categoria x
         WHERE x.id_negocio = v_id_negocio AND x.nombre = c.nombre AND x.estado = 'A'
     );

    SELECT id_categoria INTO v_ham FROM restaurante.carta_categoria
     WHERE id_negocio = v_id_negocio AND nombre = 'Hamburguesas' AND estado = 'A';
    SELECT id_categoria INTO v_rec FROM restaurante.carta_categoria
     WHERE id_negocio = v_id_negocio AND nombre = 'Recomendados de la casa' AND estado = 'A';
    SELECT id_categoria INTO v_sal FROM restaurante.carta_categoria
     WHERE id_negocio = v_id_negocio AND nombre = 'Salchipapas' AND estado = 'A';
    SELECT id_categoria INTO v_adi FROM restaurante.carta_categoria
     WHERE id_negocio = v_id_negocio AND nombre = 'Adicionales' AND estado = 'A';

    -- ── Productos ────────────────────────────────────────────────────────────
    INSERT INTO restaurante.carta_producto
        (id_negocio, id_categoria, nombre, descripcion, precio, icono, es_popular, disponible, visible, estado)
    SELECT v_id_negocio, p.cat, p.nombre, p.descripcion, p.precio, p.icono, false, true, true, 'A'
      FROM (VALUES
        -- Hamburguesas
        (v_ham, 'Clásica',            'Pan artesanal, lechuga crespa, tomate, carne artesanal de res, tocineta y loncha de queso con salsa de la casa.', 19000, '🍔'),
        (v_ham, 'Choriburguer',       'Pan artesanal, lechuga crespa, tomate, carne artesanal de res, loncha de queso, chorizo artesanal de cerdo, guacamole, pico de gallo y salsa de la casa.', 24000, '🍔'),
        (v_ham, 'Spicy',              'Pan artesanal, lechuga crespa, tomate, carne artesanal de res, loncha de queso, cebolla caramelizada con un toque picante, salsa chipotle y salsa de la casa.', 22000, '🌶️'),
        (v_ham, 'Crunchy Burguer',    'Pan artesanal, lechuga crespa, tomate, carne artesanal de res, tocineta, loncha de queso, crocante de temporada y salsa de uvilla.', 22000, '🍔'),
        (v_ham, 'Tremenda Burguer',   'Pan artesanal, lechuga crespa, tomate, carne artesanal de res, tocineta, loncha de queso, queso crema, pepinillos y aros de cebolla.', 24000, '🍔'),
        (v_ham, 'Madurito Burguer',   'Pan artesanal, lechuga crespa, tomate, carne artesanal de res, tocineta y loncha de queso, con salsa de la casa y madurito frito.', 21000, '🍔'),
        (v_ham, 'Bacon Burguer',      'Pan artesanal, lechuga crespa, tomate, carne artesanal de res, tocineta, loncha de queso, cebolla encurtida y salsa de tocineta.', 23000, '🥓'),
        (v_ham, 'Queso Frito',        'Pan artesanal, lechuga crespa, tomate, carne artesanal, queso apanado en panko, tocineta, mermelada de tomate y salsa de la casa.', 23000, '🧀'),
        (v_ham, 'Jalapeño',           'Pan artesanal, lechuga crespa, tomate, carne artesanal, queso americano, tocineta, jalapeños y salsa cheddar.', 21000, '🌶️'),
        (v_ham, 'Doble Carne',        'Pan artesanal, lechuga crespa, tomate, doble carne artesanal, queso americano, tocineta y salsa de la casa.', 28000, '🍔'),
        -- Recomendados de la casa
        (v_rec, 'Callejero',          'Chorizo artesanal acompañado de arepa, guacamole y pico de gallo.', 9000, '🌭'),
        (v_rec, 'Chori Papa',         'Chorizo artesanal, papas, guacamole y pico de gallo.', 16000, '🌭'),
        (v_rec, 'Papipollo',          'Pechuga de pollo a la parrilla, loncha de queso, papas, salsa de queso y salsa de la casa.', 17000, '🍗'),
        (v_rec, 'Mexicano',           'Chorizo artesanal, papas, guacamole, pico de gallo, jalapeños, nachos, salsa de chipotle y salsa de la casa.', 18000, '🌮'),
        (v_rec, 'Mazorcada',          'Papas, filete de pollo asado, piña calada, queso campesino, maíz dulce, salsa de maíz y mayonesa con especias de la casa.', 22000, '🌽'),
        (v_rec, 'Picada',             'Papa, carne de hamburguesa, chorizo artesanal, filete de pechuga asado, plátano maduro, arepa, pico de gallo y guacamole.', 32000, '🍽️'),
        (v_rec, 'Perro Caliente',     'Pan bimbo, salchicha americana, tocineta, loncha de queso, ripio de doritos, salsas y papa.', 15000, '🌭'),
        (v_rec, 'Choripan',           'Pan bimbo, chorizo artesanal, guacamole y papas.', 17000, '🌭'),
        (v_rec, 'Alitas BBQ',         '6 piezas de alitas apanadas con deliciosa salsa BBQ y papas.', 21000, '🍗'),
        (v_rec, 'Crispetas de Pollo', 'Nuggets de pollo apanados con papas y salsa de la casa.', 21000, '🍗'),
        -- Salchipapas
        (v_sal, 'Salchipapa Clásica', 'Salchicha americana, loncha de queso, papas y salsa de la casa.', 16000, '🍟'),
        (v_sal, 'Salchipapa Ahumada', 'Salchicha americana, costilla ahumada, papas, salsa BBQ y salsa de la casa.', 20000, '🍟'),
        -- Adicionales
        (v_adi, 'Adicional de tocineta',        'Porción adicional de tocineta.', 3000, '🥓'),
        (v_adi, 'Adicional de queso',           'Loncha adicional de queso.', 3000, '🧀'),
        (v_adi, 'Adicional de jalapeños',       'Porción adicional de jalapeños.', 3000, '🌶️'),
        (v_adi, 'Adicional de pepinillos',      'Porción adicional de pepinillos.', 3000, '🥒'),
        (v_adi, 'Adicional de piña',            'Porción adicional de piña.', 3000, '🍍'),
        (v_adi, 'Adicional de cebolla',         'Porción adicional de cebolla.', 3000, '🧅'),
        (v_adi, 'Adicional de doritos',         'Porción adicional de doritos.', 3000, '🌮'),
        (v_adi, 'Adicional de carne artesanal', 'Carne artesanal de res adicional.', 10000, '🥩'),
        (v_adi, 'Adicional de papa criolla',    'Porción adicional de papa criolla.', 5000, '🥔'),
        (v_adi, 'Desechable (para llevar)',     'Cobro por desechable en los pedidos para llevar.', 1000, '📦')
       ) AS p(cat, nombre, descripcion, precio, icono)
     WHERE NOT EXISTS (
        SELECT 1 FROM restaurante.carta_producto x
         WHERE x.id_negocio = v_id_negocio AND x.nombre = p.nombre AND x.estado = 'A'
     );

    RAISE NOTICE 'Carta cargada en "%" (negocio %): % categorías y % productos visibles.',
        v_real, v_id_negocio,
        (SELECT count(*) FROM restaurante.carta_categoria
          WHERE id_negocio = v_id_negocio AND estado = 'A' AND visible),
        (SELECT count(*) FROM restaurante.carta_producto
          WHERE id_negocio = v_id_negocio AND estado = 'A' AND disponible AND visible);
END $$;

DROP TABLE _param;
