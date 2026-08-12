-- Agenda mínima de `reserva` para desarrollo local.
--
-- `reserva` tiene CERO filas en producción y también en el volcado de esquema local, así
-- que sin este fixture no hay forma de ejercitar el adaptador piloto de F4: la vertical
-- responde correctamente "no hay nada" a todo.
--
-- Monta sobre el negocio 1 (Restaurante Demo) una agenda pequeña pero completa: config,
-- dos servicios, dos profesionales, quién presta qué y horario de lunes a viernes.
-- Idempotente: se puede volver a ejecutar.
DO $$
DECLARE
    v_id_negocio integer := 1;
    v_corte      integer;
    v_tinte      integer;
    v_laura      integer;
    v_marco      integer;
    v_dia        integer;
BEGIN
    -- Config. La crea explícitamente el fixture porque el adaptador exige que exista:
    -- `disponibilidadService.getConfig` la crearía sola, pero eso convierte una lectura en
    -- una escritura y rompería el "dry-run no deja rastro".
    INSERT INTO reserva.reserva_config (id_negocio, anticipacion_min_horas, buffer_limpieza_min, paso_slot_min)
    VALUES (v_id_negocio, 1, 10, 15)
    ON CONFLICT (id_negocio) DO NOTHING;

    SELECT id_servicio INTO v_corte FROM reserva.reserva_servicio
     WHERE id_negocio = v_id_negocio AND nombre = 'Corte de cabello';
    IF v_corte IS NULL THEN
        INSERT INTO reserva.reserva_servicio (id_negocio, nombre, descripcion, duracion_min, precio, estado)
        VALUES (v_id_negocio, 'Corte de cabello', 'Corte clásico con lavado', 30, 35000, 'A')
        RETURNING id_servicio INTO v_corte;
    END IF;

    SELECT id_servicio INTO v_tinte FROM reserva.reserva_servicio
     WHERE id_negocio = v_id_negocio AND nombre = 'Tinte';
    IF v_tinte IS NULL THEN
        INSERT INTO reserva.reserva_servicio (id_negocio, nombre, descripcion, duracion_min, precio, estado)
        VALUES (v_id_negocio, 'Tinte', 'Coloración completa', 90, 120000, 'A')
        RETURNING id_servicio INTO v_tinte;
    END IF;

    SELECT id_profesional INTO v_laura FROM reserva.reserva_profesional
     WHERE id_negocio = v_id_negocio AND nombre = 'Laura Gómez';
    IF v_laura IS NULL THEN
        INSERT INTO reserva.reserva_profesional (id_negocio, nombre, especialidad, estado)
        VALUES (v_id_negocio, 'Laura Gómez', 'Colorimetría', 'A')
        RETURNING id_profesional INTO v_laura;
    END IF;

    SELECT id_profesional INTO v_marco FROM reserva.reserva_profesional
     WHERE id_negocio = v_id_negocio AND nombre = 'Marco Ruiz';
    IF v_marco IS NULL THEN
        INSERT INTO reserva.reserva_profesional (id_negocio, nombre, especialidad, estado)
        VALUES (v_id_negocio, 'Marco Ruiz', 'Barbería', 'A')
        RETURNING id_profesional INTO v_marco;
    END IF;

    -- Laura hace las dos cosas; Marco solo corta. Así `consultar_disponibilidad` sin
    -- profesional tiene que fundir dos agendas para el corte y una sola para el tinte,
    -- que es justo el caso que el adaptador compensa.
    INSERT INTO reserva.reserva_profesional_servicio (id_profesional, id_servicio)
    VALUES (v_laura, v_corte), (v_laura, v_tinte), (v_marco, v_corte)
    ON CONFLICT DO NOTHING;

    -- Lunes a viernes, 09:00–13:00 y 14:00–18:00, para ambos.
    FOREACH v_dia IN ARRAY ARRAY[1, 2, 3, 4, 5] LOOP
        INSERT INTO reserva.reserva_horario (id_negocio, id_profesional, dia_semana, hora_inicio, hora_fin)
        SELECT v_id_negocio, p, v_dia, h[1]::time, h[2]::time
          FROM unnest(ARRAY[v_laura, v_marco]) AS p,
               (VALUES (ARRAY['09:00', '13:00']), (ARRAY['14:00', '18:00'])) AS t(h)
         WHERE NOT EXISTS (
            SELECT 1 FROM reserva.reserva_horario
             WHERE id_negocio = v_id_negocio AND id_profesional = p
               AND dia_semana = v_dia AND hora_inicio = h[1]::time
         );
    END LOOP;

    RAISE NOTICE 'Agenda de reserva lista en el negocio %: servicios % y %, profesionales % y %',
        v_id_negocio, v_corte, v_tinte, v_laura, v_marco;
END $$;
