-- Retira la carta que el negocio tenga a medio hacer, ANTES de cargar la definitiva.
--
--   psql ... -v id_negocio=13 -v negocio="El Callejero" -f scripts/fixtures/carta_el_callejero_limpieza.sql
--
-- ## Por qué hace falta
--
-- El Callejero (negocio 13 en producción) había empezado a cargar su carta a mano: 6 categorías,
-- 1 producto y 7 insumos, con nombres propios («Pan», «Queso», «Carne de hamburguesa») que no son
-- los de la cartelera. Cargar el menú encima dejaría el catálogo con parejas como «Pan» y «Pan
-- artesanal», y tres secciones vacías visibles en el menú digital. Con 0 pedidos en el histórico,
-- sale más limpio retirar lo empezado y cargar la carta completa de una vez.
--
-- ## Es un borrado SUAVE, y se deshace
--
-- Nada se borra: todo pasa a `estado = 'I'`, que es lo mismo que hace el botón «eliminar» del
-- panel. Para devolverlo hay que reactivar y quitarle el sufijo del nombre (ver más abajo).
--
-- ## ⚠️ Por qué se renombra al retirar
--
-- `carta_categoria` y `carta_ingrediente` tienen UNIQUE (id_negocio, nombre) y el índice **no
-- mira el estado**. Una categoría «Hamburguesas» desactivada sigue ocupando el nombre, así que
-- el fixture de la carta no podría crear la suya y reventaría con violación de unicidad. Por eso
-- se les añade « (retirado <id>)», que es la misma solución que ya usa
-- `cartaAdminService.eliminarIngrediente`. Los productos no lo necesitan: no tienen ese índice.
--
-- ## Salvaguarda
--
-- Aborta si algún producto del negocio aparece en un pedido. Retirar de la carta algo que ya se
-- vendió deja informes históricos apuntando a filas inactivas, y eso ya no es una limpieza.

CREATE TEMP TABLE _param AS
    SELECT :id_negocio::integer AS id_negocio, :'negocio'::text AS negocio;

DO $$
DECLARE
    v_id_negocio integer;
    v_esperado   text;
    v_real       text;
    v_vendidos   integer;
    v_cat        integer;
    v_prod       integer;
    v_ing        integer;
BEGIN
    SELECT id_negocio, negocio INTO v_id_negocio, v_esperado FROM _param;

    SELECT nombre INTO v_real
      FROM general.gener_negocio
     WHERE id_negocio = v_id_negocio AND estado = 'A';

    IF v_real IS DISTINCT FROM v_esperado THEN
        RAISE EXCEPTION 'El negocio % activo se llama "%", no "%". Abortado.',
            v_id_negocio, COALESCE(v_real, '(no existe o inactivo)'), v_esperado;
    END IF;

    SELECT count(*) INTO v_vendidos
      FROM restaurante.pedid_detalle d
      JOIN restaurante.carta_producto p ON p.id_producto = d.id_producto
     WHERE p.id_negocio = v_id_negocio;

    IF v_vendidos > 0 THEN
        RAISE EXCEPTION 'El negocio % tiene % líneas de pedido sobre su carta actual. Abortado: esto ya no es una carta a medio hacer.',
            v_id_negocio, v_vendidos;
    END IF;

    -- Recetas primero: cuelgan de los productos que se van a retirar.
    UPDATE restaurante.carta_producto_ingred pi
       SET estado = 'I'
      FROM restaurante.carta_producto p
     WHERE p.id_producto = pi.id_producto
       AND p.id_negocio = v_id_negocio
       AND pi.estado = 'A';

    UPDATE restaurante.carta_producto
       SET estado = 'I'
     WHERE id_negocio = v_id_negocio AND estado = 'A';
    GET DIAGNOSTICS v_prod = ROW_COUNT;

    UPDATE restaurante.carta_ingrediente
       SET estado = 'I',
           nombre = nombre || ' (retirado ' || id_ingrediente || ')'
     WHERE id_negocio = v_id_negocio AND estado = 'A';
    GET DIAGNOSTICS v_ing = ROW_COUNT;

    UPDATE restaurante.carta_categoria
       SET estado = 'I',
           nombre = nombre || ' (retirado ' || id_categoria || ')'
     WHERE id_negocio = v_id_negocio AND estado = 'A';
    GET DIAGNOSTICS v_cat = ROW_COUNT;

    RAISE NOTICE 'Retirado en "%" (negocio %): % categorías, % productos, % insumos.',
        v_real, v_id_negocio, v_cat, v_prod, v_ing;
    RAISE NOTICE 'Para deshacerlo: UPDATE ... SET estado = ''A'', nombre = regexp_replace(nombre, '' \(retirado [0-9]+\)$'', '''') WHERE id_negocio = % AND estado = ''I'';', v_id_negocio;
END $$;

DROP TABLE _param;
