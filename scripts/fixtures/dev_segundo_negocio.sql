-- Segundo inquilino, para poder demostrar (y luego prevenir) fugas entre negocios.
-- Password de ambos usuarios: Admin123*  (mismo hash que el seed de desarrollo)
DO $$
DECLARE
    v_id_negocio integer;
    v_id_usuario integer;
    v_hash text;
    v_id_rol integer;
BEGIN
    SELECT password INTO v_hash FROM general.gener_usuario WHERE num_identificacion = '1000000002';

    SELECT id_negocio INTO v_id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Rival';
    IF v_id_negocio IS NULL THEN
        INSERT INTO general.gener_negocio (nombre, nit, email_contacto, telefono, direccion, estado, id_tipo_negocio)
        VALUES ('Restaurante Rival', '900000000-2', 'rival@local', '3000000020', 'Otra calle 456', 'A', 1)
        RETURNING id_negocio INTO v_id_negocio;
    END IF;

    SELECT id_usuario INTO v_id_usuario FROM general.gener_usuario WHERE num_identificacion = '1000000003';
    IF v_id_usuario IS NULL THEN
        INSERT INTO general.gener_usuario
            (primer_nombre, primer_apellido, num_identificacion, telefono, email, password,
             estado, es_admin_principal, debe_cambiar_password)
        VALUES ('Admin', 'Rival', '1000000003', '3000000021', 'admin.rival@escalapp.local', v_hash, 'A', false, false)
        RETURNING id_usuario INTO v_id_usuario;
    END IF;

    INSERT INTO general.gener_negocio_usuario (id_usuario, id_negocio, estado)
    VALUES (v_id_usuario, v_id_negocio, 'A')
    ON CONFLICT (id_usuario, id_negocio) DO NOTHING;

    SELECT id_rol INTO v_id_rol FROM general.gener_rol
     WHERE UPPER(descripcion) = 'ADMINISTRADOR' AND id_tipo_negocio = 1 LIMIT 1;

    IF NOT EXISTS (SELECT 1 FROM general.gener_usuario_rol
                    WHERE id_usuario = v_id_usuario AND id_rol = v_id_rol AND id_negocio = v_id_negocio) THEN
        INSERT INTO general.gener_usuario_rol (id_usuario, id_rol, id_negocio, estado)
        VALUES (v_id_usuario, v_id_rol, v_id_negocio, 'A');
    END IF;

    -- Mesas propias de cada negocio, para que la fuga sea visible sin ambigüedad.
    INSERT INTO restaurante.rest_mesa (id_negocio, nombre, numero, estado)
    SELECT v_id_negocio, 'Mesa RIVAL-1', 1, 'A'
     WHERE NOT EXISTS (SELECT 1 FROM restaurante.rest_mesa WHERE id_negocio = v_id_negocio);

    INSERT INTO restaurante.rest_mesa (id_negocio, nombre, numero, estado)
    SELECT 1, 'Mesa DEMO-1', 1, 'A'
     WHERE NOT EXISTS (SELECT 1 FROM restaurante.rest_mesa WHERE id_negocio = 1);

    RAISE NOTICE 'Negocio rival id=%, usuario rival id=% (1000000003 / Admin123*)', v_id_negocio, v_id_usuario;
END $$;
