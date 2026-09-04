-- Insumos y recetas de «El Callejero Fast Food».
--
-- Se aplica DESPUÉS de `carta_el_callejero.sql`, y es OPCIONAL: la carta funciona sin esto.
--
--   psql ... -v id_negocio=3 -v negocio="Restaurante Rival" -f scripts/fixtures/carta_el_callejero_recetas.sql
--
-- ## Qué añade y qué cuesta
--
-- La receta es lo que hace que en el POS aparezca «quitar tomate» al tocar un producto: la
-- exclusión que el mesero marca sale de `carta_producto_ingred`, no de la descripción. Sin
-- receta el modal del producto sale vacío y esa función no existe para el negocio.
--
-- El precio de tenerla: los insumos nacen con `stock_actual = 0`, así que la pantalla de
-- Inventario mostrará los 42 en «agotado» hasta que el negocio cargue existencias. Es cierto
-- —no han cargado nada—, pero conviene avisarlo antes de que lo vean.
--
-- ## ⚠️ `porcion = 0` NO es un descuido
--
-- `pedidoService.consumirIngredientesPorItems` descuenta inventario al crear un pedido y, si el
-- stock no alcanza, **lanza `STOCK_INSUFICIENTE` y el pedido no se crea** (salvo que el POS
-- mande `permitir_stock_negativo`, que por defecto va en false). Con porciones reales y stock 0,
-- el primer pedido del negocio fallaría. La misma función salta la línea cuando `porcion <= 0`:
--
--     const porcion = Number(recetaIng.porcion || 0);
--     if (porcion <= 0) return;
--
-- Así que con 0 se obtiene lo que se quiere —los ingredientes quitables— sin encender el control
-- de inventario. El día que el negocio quiera descontar existencias, pone las porciones desde
-- Inventario y a partir de ahí sí descuenta.
--
-- `es_removible` en false para la base del plato (pan, carne, chorizo, papa, pollo…): quitarle
-- el pan a una hamburguesa no es una preferencia, es otro producto.
--
-- Idempotente: los insumos por nombre, las recetas por (producto, insumo).

CREATE TEMP TABLE _param AS
    SELECT :id_negocio::integer AS id_negocio, :'negocio'::text AS negocio;

-- ── Recetas ─────────────────────────────────────────────────────────────────
-- Se resuelven por nombre contra la carta ya cargada. Si un producto no está, la fila se
-- cae sola en el JOIN; la comprobación de más abajo es la que avisa de que eso ha pasado.
CREATE TEMP TABLE _receta (producto text, insumo text, removible boolean);
INSERT INTO _receta (producto, insumo, removible) VALUES
    -- Hamburguesas
    ('Clásica','Pan artesanal',false),('Clásica','Lechuga crespa',true),('Clásica','Tomate',true),
    ('Clásica','Carne artesanal de res',false),('Clásica','Tocineta',true),
    ('Clásica','Loncha de queso',true),('Clásica','Salsa de la casa',true),

    ('Choriburguer','Pan artesanal',false),('Choriburguer','Lechuga crespa',true),
    ('Choriburguer','Tomate',true),('Choriburguer','Carne artesanal de res',false),
    ('Choriburguer','Loncha de queso',true),('Choriburguer','Chorizo artesanal',false),
    ('Choriburguer','Guacamole',true),('Choriburguer','Pico de gallo',true),
    ('Choriburguer','Salsa de la casa',true),

    ('Spicy','Pan artesanal',false),('Spicy','Lechuga crespa',true),('Spicy','Tomate',true),
    ('Spicy','Carne artesanal de res',false),('Spicy','Loncha de queso',true),
    ('Spicy','Cebolla caramelizada',true),('Spicy','Salsa chipotle',true),
    ('Spicy','Salsa de la casa',true),

    ('Crunchy Burguer','Pan artesanal',false),('Crunchy Burguer','Lechuga crespa',true),
    ('Crunchy Burguer','Tomate',true),('Crunchy Burguer','Carne artesanal de res',false),
    ('Crunchy Burguer','Tocineta',true),('Crunchy Burguer','Loncha de queso',true),
    ('Crunchy Burguer','Crocante de temporada',true),('Crunchy Burguer','Salsa de uvilla',true),

    ('Tremenda Burguer','Pan artesanal',false),('Tremenda Burguer','Lechuga crespa',true),
    ('Tremenda Burguer','Tomate',true),('Tremenda Burguer','Carne artesanal de res',false),
    ('Tremenda Burguer','Tocineta',true),('Tremenda Burguer','Loncha de queso',true),
    ('Tremenda Burguer','Queso crema',true),('Tremenda Burguer','Pepinillos',true),
    ('Tremenda Burguer','Aros de cebolla',true),

    ('Madurito Burguer','Pan artesanal',false),('Madurito Burguer','Lechuga crespa',true),
    ('Madurito Burguer','Tomate',true),('Madurito Burguer','Carne artesanal de res',false),
    ('Madurito Burguer','Tocineta',true),('Madurito Burguer','Loncha de queso',true),
    ('Madurito Burguer','Salsa de la casa',true),('Madurito Burguer','Plátano maduro',true),

    ('Bacon Burguer','Pan artesanal',false),('Bacon Burguer','Lechuga crespa',true),
    ('Bacon Burguer','Tomate',true),('Bacon Burguer','Carne artesanal de res',false),
    ('Bacon Burguer','Tocineta',false),('Bacon Burguer','Loncha de queso',true),
    ('Bacon Burguer','Cebolla encurtida',true),('Bacon Burguer','Salsa de tocineta',true),

    ('Queso Frito','Pan artesanal',false),('Queso Frito','Lechuga crespa',true),
    ('Queso Frito','Tomate',true),('Queso Frito','Carne artesanal de res',false),
    ('Queso Frito','Queso apanado en panko',false),('Queso Frito','Tocineta',true),
    ('Queso Frito','Mermelada de tomate',true),('Queso Frito','Salsa de la casa',true),

    ('Jalapeño','Pan artesanal',false),('Jalapeño','Lechuga crespa',true),
    ('Jalapeño','Tomate',true),('Jalapeño','Carne artesanal de res',false),
    ('Jalapeño','Queso americano',true),('Jalapeño','Tocineta',true),
    ('Jalapeño','Jalapeños',false),('Jalapeño','Salsa cheddar',true),

    ('Doble Carne','Pan artesanal',false),('Doble Carne','Lechuga crespa',true),
    ('Doble Carne','Tomate',true),('Doble Carne','Carne artesanal de res',false),
    ('Doble Carne','Queso americano',true),('Doble Carne','Tocineta',true),
    ('Doble Carne','Salsa de la casa',true),

    -- Recomendados de la casa
    ('Callejero','Chorizo artesanal',false),('Callejero','Arepa',false),
    ('Callejero','Guacamole',true),('Callejero','Pico de gallo',true),

    ('Chori Papa','Chorizo artesanal',false),('Chori Papa','Papas',false),
    ('Chori Papa','Guacamole',true),('Chori Papa','Pico de gallo',true),

    ('Papipollo','Pechuga de pollo',false),('Papipollo','Loncha de queso',true),
    ('Papipollo','Papas',false),('Papipollo','Salsa de queso',true),
    ('Papipollo','Salsa de la casa',true),

    ('Mexicano','Chorizo artesanal',false),('Mexicano','Papas',false),
    ('Mexicano','Guacamole',true),('Mexicano','Pico de gallo',true),
    ('Mexicano','Jalapeños',true),('Mexicano','Nachos',true),
    ('Mexicano','Salsa chipotle',true),('Mexicano','Salsa de la casa',true),

    ('Mazorcada','Papas',false),('Mazorcada','Pechuga de pollo',false),
    ('Mazorcada','Piña',true),('Mazorcada','Queso campesino',true),
    ('Mazorcada','Maíz dulce',false),('Mazorcada','Salsa de maíz',true),
    ('Mazorcada','Mayonesa de la casa',true),

    ('Picada','Papas',false),('Picada','Carne artesanal de res',false),
    ('Picada','Chorizo artesanal',false),('Picada','Pechuga de pollo',false),
    ('Picada','Plátano maduro',true),('Picada','Arepa',true),
    ('Picada','Pico de gallo',true),('Picada','Guacamole',true),

    ('Perro Caliente','Pan bimbo',false),('Perro Caliente','Salchicha americana',false),
    ('Perro Caliente','Tocineta',true),('Perro Caliente','Loncha de queso',true),
    ('Perro Caliente','Doritos',true),('Perro Caliente','Salsa de la casa',true),
    ('Perro Caliente','Papas',false),

    ('Choripan','Pan bimbo',false),('Choripan','Chorizo artesanal',false),
    ('Choripan','Guacamole',true),('Choripan','Papas',false),

    ('Alitas BBQ','Alitas de pollo',false),('Alitas BBQ','Salsa BBQ',true),
    ('Alitas BBQ','Papas',false),

    ('Crispetas de Pollo','Nuggets de pollo',false),('Crispetas de Pollo','Papas',false),
    ('Crispetas de Pollo','Salsa de la casa',true),

    -- Salchipapas
    ('Salchipapa Clásica','Salchicha americana',false),('Salchipapa Clásica','Loncha de queso',true),
    ('Salchipapa Clásica','Papas',false),('Salchipapa Clásica','Salsa de la casa',true),

    ('Salchipapa Ahumada','Salchicha americana',false),('Salchipapa Ahumada','Costilla ahumada',false),
    ('Salchipapa Ahumada','Papas',false),('Salchipapa Ahumada','Salsa BBQ',true),
    ('Salchipapa Ahumada','Salsa de la casa',true);

DO $$
DECLARE
    v_id_negocio integer;
    v_esperado   text;
    v_real       text;
    v_sin_prod   text;
    v_sin_ins    text;
BEGIN
    SELECT id_negocio, negocio INTO v_id_negocio, v_esperado FROM _param;

    SELECT nombre INTO v_real
      FROM general.gener_negocio
     WHERE id_negocio = v_id_negocio AND estado = 'A';

    IF v_real IS DISTINCT FROM v_esperado THEN
        RAISE EXCEPTION 'El negocio % activo se llama "%", no "%". Abortado.',
            v_id_negocio, COALESCE(v_real, '(no existe o inactivo)'), v_esperado;
    END IF;

    -- ── Insumos ──────────────────────────────────────────────────────────────
    INSERT INTO restaurante.carta_ingrediente
        (id_negocio, nombre, unidad_medida, stock_actual, stock_minimo, stock_maximo, estado)
    SELECT v_id_negocio, i.nombre, i.unidad, 0, 0, 0, 'A'
      FROM (VALUES
            ('Pan artesanal', 'und'), ('Pan bimbo', 'und'), ('Arepa', 'und'),
            ('Lechuga crespa', 'g'), ('Tomate', 'g'),
            ('Carne artesanal de res', 'g'), ('Tocineta', 'g'),
            ('Loncha de queso', 'und'), ('Queso americano', 'und'), ('Queso crema', 'g'),
            ('Queso campesino', 'g'), ('Queso apanado en panko', 'und'),
            ('Salsa de la casa', 'ml'), ('Salsa chipotle', 'ml'), ('Salsa de uvilla', 'ml'),
            ('Salsa de tocineta', 'ml'), ('Salsa cheddar', 'ml'), ('Salsa de queso', 'ml'),
            ('Salsa BBQ', 'ml'), ('Salsa de maíz', 'ml'), ('Mayonesa de la casa', 'ml'),
            ('Mermelada de tomate', 'ml'),
            ('Chorizo artesanal', 'und'), ('Salchicha americana', 'und'),
            ('Pechuga de pollo', 'g'), ('Alitas de pollo', 'und'), ('Nuggets de pollo', 'und'),
            ('Costilla ahumada', 'g'),
            ('Guacamole', 'g'), ('Pico de gallo', 'g'),
            ('Cebolla caramelizada', 'g'), ('Cebolla encurtida', 'g'), ('Aros de cebolla', 'und'),
            ('Crocante de temporada', 'g'), ('Pepinillos', 'g'), ('Jalapeños', 'g'),
            ('Plátano maduro', 'und'), ('Papas', 'g'), ('Piña', 'g'), ('Maíz dulce', 'g'),
            ('Nachos', 'g'), ('Doritos', 'g')
           ) AS i(nombre, unidad)
     WHERE NOT EXISTS (
        SELECT 1 FROM restaurante.carta_ingrediente x
         WHERE x.id_negocio = v_id_negocio AND lower(x.nombre) = lower(i.nombre) AND x.estado = 'A'
     );

    SELECT string_agg(DISTINCT r.producto, ', ') INTO v_sin_prod
      FROM _receta r
     WHERE NOT EXISTS (
        SELECT 1 FROM restaurante.carta_producto p
         WHERE p.id_negocio = v_id_negocio AND p.nombre = r.producto AND p.estado = 'A'
     );
    IF v_sin_prod IS NOT NULL THEN
        RAISE EXCEPTION 'Faltan productos en la carta del negocio %: %. ¿Se aplicó carta_el_callejero.sql?',
            v_id_negocio, v_sin_prod;
    END IF;

    -- El JOIN de abajo descarta en silencio la línea cuyo insumo no exista, y una errata en un
    -- nombre se vería solo como «a este producto le faltan ingredientes» semanas después.
    SELECT string_agg(DISTINCT r.insumo, ', ') INTO v_sin_ins
      FROM _receta r
     WHERE NOT EXISTS (
        SELECT 1 FROM restaurante.carta_ingrediente i
         WHERE i.id_negocio = v_id_negocio AND i.nombre = r.insumo AND i.estado = 'A'
     );
    IF v_sin_ins IS NOT NULL THEN
        RAISE EXCEPTION 'Insumos nombrados en las recetas que no están en el catálogo: %.', v_sin_ins;
    END IF;

    INSERT INTO restaurante.carta_producto_ingred
        (id_producto, id_ingrediente, porcion, unidad_medida, es_removible, estado)
    SELECT p.id_producto, i.id_ingrediente, 0, i.unidad_medida, r.removible, 'A'
      FROM _receta r
      JOIN restaurante.carta_producto p
        ON p.id_negocio = v_id_negocio AND p.nombre = r.producto AND p.estado = 'A'
      JOIN restaurante.carta_ingrediente i
        ON i.id_negocio = v_id_negocio AND i.nombre = r.insumo AND i.estado = 'A'
     WHERE NOT EXISTS (
        SELECT 1 FROM restaurante.carta_producto_ingred x
         WHERE x.id_producto = p.id_producto AND x.id_ingrediente = i.id_ingrediente
     );

    RAISE NOTICE 'Recetas cargadas en "%" (negocio %): % insumos y % líneas de receta.',
        v_real, v_id_negocio,
        (SELECT count(*) FROM restaurante.carta_ingrediente
          WHERE id_negocio = v_id_negocio AND estado = 'A'),
        (SELECT count(*) FROM restaurante.carta_producto_ingred pi
          JOIN restaurante.carta_producto p ON p.id_producto = pi.id_producto
         WHERE p.id_negocio = v_id_negocio AND pi.estado = 'A');
END $$;

DROP TABLE _param;
DROP TABLE _receta;
