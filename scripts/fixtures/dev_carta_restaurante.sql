-- Carta mínima de `restaurante` para desarrollo local.
--
-- Sin esto, `carta_categoria` y `carta_producto` están **vacías** en la base local —igual que
-- `reserva` lo estaba antes de `dev_reserva.sql`— y el adaptador de restaurante responde
-- correctamente «no hay nada» a todo, que es la peor clase de test verde: pasa sin ejercitar
-- una sola línea de lo que importa.
--
-- Monta sobre el negocio 1 (Restaurante Demo) una carta pequeña pero con los casos que el
-- adaptador tiene que distinguir:
--
--   · **Tres categorías**, para que `consultar_carta` sin categoría tenga algo que listar y se
--     vea que devuelve el conteo de productos de cada una.
--   · **Un producto NO visible** (`Menú del personal`): existe y está disponible, pero el
--     negocio no se lo enseña a nadie. Es lo que separa las consultas públicas de las de
--     administración, y sin él nada comprobaría que el bot usa las correctas.
--   · **Un producto NO disponible** (`Malteada de mora`): visible en la carta pero agotado hoy.
--     Otro filtro distinto, y el que más se olvida.
--   · **Dos productos que comparten palabra** («hamburguesa»), para que `buscar_producto`
--     devuelva varios y no se pueda dar por bueno un buscador que solo acierta con uno.
--
-- Idempotente por nombre: se puede volver a ejecutar sin duplicar.
DO $$
DECLARE
    v_id_negocio integer := 1;
    v_nombre     text;
    v_hamb       integer;
    v_beb        integer;
    v_post       integer;
BEGIN
    SELECT nombre INTO v_nombre FROM general.gener_negocio WHERE id_negocio = v_id_negocio;
    IF v_nombre IS NULL THEN
        RAISE EXCEPTION 'No existe el negocio %. ¿Falta el seed de desarrollo?', v_id_negocio;
    END IF;

    -- ── Categorías ───────────────────────────────────────────────────────────────────────
    INSERT INTO restaurante.carta_categoria (id_negocio, nombre, descripcion, orden, visible, estado)
    SELECT v_id_negocio, c.nombre, c.descripcion, c.orden, true, 'A'
      FROM (VALUES
            ('Hamburguesas', 'Todas con papas a la francesa', 1),
            ('Bebidas',      'Frías y calientes',             2),
            ('Postres',      'Para terminar',                 3)
           ) AS c(nombre, descripcion, orden)
     WHERE NOT EXISTS (
        SELECT 1 FROM restaurante.carta_categoria x
         WHERE x.id_negocio = v_id_negocio AND x.nombre = c.nombre
     );

    SELECT id_categoria INTO v_hamb FROM restaurante.carta_categoria
     WHERE id_negocio = v_id_negocio AND nombre = 'Hamburguesas';
    SELECT id_categoria INTO v_beb  FROM restaurante.carta_categoria
     WHERE id_negocio = v_id_negocio AND nombre = 'Bebidas';
    SELECT id_categoria INTO v_post FROM restaurante.carta_categoria
     WHERE id_negocio = v_id_negocio AND nombre = 'Postres';

    -- ── Productos ────────────────────────────────────────────────────────────────────────
    INSERT INTO restaurante.carta_producto
        (id_negocio, id_categoria, nombre, descripcion, precio, es_popular, disponible, visible, estado)
    SELECT v_id_negocio, p.cat, p.nombre, p.descripcion, p.precio, p.popular, p.disponible, p.visible, 'A'
      FROM (VALUES
            (v_hamb, 'Hamburguesa clásica', 'Carne, queso, lechuga y tomate',   22000, true,  true,  true),
            (v_hamb, 'Hamburguesa doble',   'Doble carne y doble queso',        32000, true,  true,  true),
            (v_hamb, 'Menú del personal',   'No se muestra en la carta',        10000, false, true,  false),
            (v_beb,  'Limonada natural',    'Vaso de 16 oz',                     7000, false, true,  true),
            (v_beb,  'Gaseosa',             'Lata de 350 ml',                    5000, false, true,  true),
            (v_post, 'Brownie con helado',  'Brownie tibio con vainilla',       14000, false, true,  true),
            (v_post, 'Malteada de mora',    'Hoy agotada',                      12000, false, false, true)
           ) AS p(cat, nombre, descripcion, precio, popular, disponible, visible)
     WHERE NOT EXISTS (
        SELECT 1 FROM restaurante.carta_producto x
         WHERE x.id_negocio = v_id_negocio AND x.nombre = p.nombre
     );

    RAISE NOTICE 'Carta lista en "%" (negocio %): % categorías, % productos visibles.',
        v_nombre, v_id_negocio,
        (SELECT count(*) FROM restaurante.carta_categoria WHERE id_negocio = v_id_negocio AND estado = 'A'),
        (SELECT count(*) FROM restaurante.carta_producto
          WHERE id_negocio = v_id_negocio AND estado = 'A' AND disponible AND visible);
END $$;
