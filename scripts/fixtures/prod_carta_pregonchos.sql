-- Carta de demo para «Restaurante pregonchos» (id_negocio 12) en PRODUCCIÓN.
--
-- ## Por qué existe
--
-- Es el restaurante que se va a usar para probar el asistente, y estaba **vacío**: 0 categorías
-- y 0 productos. Sin carta el bot responde correctamente «no hay nada» a todo, que es la peor
-- clase de prueba: pasa sin ejercitar nada.
--
-- ⚠️ **Son datos inventados en un negocio real.** No es un demo aislado como el Salón: pregonchos
-- está asociado al administrador y tiene caja abierta. Si algún día se usa de verdad, esta carta
-- hay que borrarla o reemplazarla — los nombres llevan el prefijo «(demo)» en la descripción
-- justamente para que se distingan de un producto de verdad al mirarlos en el panel.
--
-- Variedad con intención, la misma que en `dev_carta_restaurante.sql`:
--   · Duraciones no, pero sí **precios distintos** y un rango amplio, para que los totales de un
--     pedido con varios items no salgan todos redondos por casualidad.
--   · **Un producto oculto** (`visible = false`) y **uno agotado** (`disponible = false`): son dos
--     filtros distintos y el segundo es el que siempre se olvida. Un bot que ofrece algo agotado
--     hace quedar mal al negocio con su cliente.
--
-- Idempotente por nombre.
DO $$
DECLARE
    v_id_negocio integer := 12;
    v_nombre     text;
    v_ent        integer;
    v_pla        integer;
    v_beb        integer;
BEGIN
    -- Salvaguarda: si el 12 dejara de ser este restaurante, no se siembra nada. Meterle
    -- productos inventados al negocio equivocado es de las cosas que no se deshacen solas.
    SELECT nombre INTO v_nombre FROM general.gener_negocio WHERE id_negocio = v_id_negocio;
    IF v_nombre IS DISTINCT FROM 'Restaurante pregonchos' THEN
        RAISE EXCEPTION 'El negocio % se llama "%", no "Restaurante pregonchos". Abortado.',
            v_id_negocio, COALESCE(v_nombre, '(no existe)');
    END IF;

    INSERT INTO restaurante.carta_categoria (id_negocio, nombre, descripcion, orden, visible, estado)
    SELECT v_id_negocio, c.nombre, c.descripcion, c.orden, true, 'A'
      FROM (VALUES
            ('Entradas',  'Para empezar (demo)',        1),
            ('Platos',    'Fuertes de la casa (demo)',  2),
            ('Bebidas',   'Frías y calientes (demo)',   3)
           ) AS c(nombre, descripcion, orden)
     WHERE NOT EXISTS (
        SELECT 1 FROM restaurante.carta_categoria x
         WHERE x.id_negocio = v_id_negocio AND x.nombre = c.nombre
     );

    SELECT id_categoria INTO v_ent FROM restaurante.carta_categoria
     WHERE id_negocio = v_id_negocio AND nombre = 'Entradas';
    SELECT id_categoria INTO v_pla FROM restaurante.carta_categoria
     WHERE id_negocio = v_id_negocio AND nombre = 'Platos';
    SELECT id_categoria INTO v_beb FROM restaurante.carta_categoria
     WHERE id_negocio = v_id_negocio AND nombre = 'Bebidas';

    INSERT INTO restaurante.carta_producto
        (id_negocio, id_categoria, nombre, descripcion, precio, es_popular, disponible, visible, estado)
    SELECT v_id_negocio, p.cat, p.nombre, p.descripcion, p.precio, p.popular, p.disponible, p.visible, 'A'
      FROM (VALUES
            (v_ent, 'Empanadas (x3)',     '(demo) De carne, con ají',              9000, true,  true,  true),
            (v_ent, 'Patacón con hogao',  '(demo) Plátano verde y hogao casero',  12000, false, true,  true),
            (v_ent, 'Sopa del día',       '(demo) Preguntar por la del día',      11000, false, true,  true),
            (v_pla, 'Bandeja paisa',      '(demo) Completa, con chicharrón',      34000, true,  true,  true),
            (v_pla, 'Pechuga a la plancha','(demo) Con ensalada y arroz',         27000, false, true,  true),
            (v_pla, 'Mojarra frita',      '(demo) Con patacón y ensalada',        38000, false, true,  true),
            (v_pla, 'Churrasco',          '(demo) 300 g con papas',               42000, true,  true,  true),
            (v_pla, 'Plato del personal', '(demo) No se muestra en la carta',     12000, false, true,  false),
            (v_beb, 'Limonada de coco',   '(demo) Vaso de 16 oz',                 10000, true,  true,  true),
            (v_beb, 'Jugo natural',       '(demo) En agua o en leche',             7000, false, true,  true),
            (v_beb, 'Gaseosa',            '(demo) Lata de 350 ml',                 5000, false, true,  true),
            (v_beb, 'Michelada',          '(demo) Hoy agotada',                   14000, false, false, true)
           ) AS p(cat, nombre, descripcion, precio, popular, disponible, visible)
     WHERE NOT EXISTS (
        SELECT 1 FROM restaurante.carta_producto x
         WHERE x.id_negocio = v_id_negocio AND x.nombre = p.nombre
     );

    RAISE NOTICE 'Carta de demo lista en "%" (negocio %): % categorías, % productos visibles.',
        v_nombre, v_id_negocio,
        (SELECT count(*) FROM restaurante.carta_categoria WHERE id_negocio = v_id_negocio AND estado = 'A'),
        (SELECT count(*) FROM restaurante.carta_producto
          WHERE id_negocio = v_id_negocio AND estado = 'A' AND disponible AND visible);
END $$;
