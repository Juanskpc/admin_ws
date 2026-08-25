-- Catálogo del «Salón Demo EscalApp» (id_negocio 10) en PRODUCCIÓN.
--
-- ## Por qué existe, y por qué toca producción
--
-- F8-C necesita probar el canal de WhatsApp de punta a punta con un número real. Los dos
-- clientes activos (6 ZONA BURGER y 14 LA ESQUINA DEL BARRIL) son **restaurantes**, y el
-- asistente solo sabe agendar citas: las seis capacidades son de `reserva` y el único
-- adaptador es `reserva`. No hay dónde probarlo sobre un cliente real sin inventarle un
-- negocio que no tiene.
--
-- El negocio 10 es de tipo «Salones de belleza, barberías y servicios con cita previa», no
-- tiene dueño real y estaba **vacío**: 0 servicios, 0 profesionales, 0 citas. Es el sitio
-- correcto para la prueba — y sembrarlo no toca a ningún cliente.
--
-- ## Por qué el catálogo es variado y no dos servicios de muestra
--
-- La primera versión (2026-08-24) puso lo mínimo para que el bot no respondiera «no hay
-- nada»: dos servicios y dos profesionales. Sirve para comprobar que la tubería funciona y
-- para nada más. Un catálogo pobre esconde justo los casos donde el motor de disponibilidad
-- se rompe, así que esta versión busca **variedad con intención**:
--
--   · **Duraciones de 15 a 180 minutos.** Con todo durando 30 min y un paso de 15, los
--     huecos siempre cuadran. Un alisado de 3 horas contra una agenda partida en dos
--     bloques es lo que descubre si el buffer de limpieza y el solape están bien.
--   · **Seis profesionales con horarios DISTINTOS**, no el mismo copiado. Cuando dos
--     agendas se funden para el mismo servicio, `consultar_disponibilidad` tiene que
--     unirlas sin duplicar huecos; con horarios idénticos ese caso no se ejercita.
--   · **Quién presta qué, repartido de forma desigual.** El diseño de cejas lo hace una
--     sola persona y el corte lo hacen cuatro: son los dos extremos del mismo cálculo.
--   · **Sábado incluido** para tres de ellos, porque `dia_semana` es 0=domingo…6=sábado y
--     un fixture de lunes a viernes nunca prueba el borde de la semana.
--
-- Precios en pesos colombianos, coherentes con un salón real de barrio.
--
-- Es idempotente por nombre: se puede volver a ejecutar y no duplica nada. Añadir un
-- servicio nuevo aquí y reejecutar es la forma prevista de ampliarlo.
DO $$
DECLARE
    v_id_negocio integer := 10;
    v_nombre     text;
    v_serv       integer;
    v_prof       integer;
    v_hor        integer;
BEGIN
    -- Salvaguarda: si el 10 dejara de ser el salón demo, esto NO siembra nada. En producción
    -- un fixture que se equivoca de inquilino le mete servicios inventados a un cliente real.
    SELECT nombre INTO v_nombre FROM general.gener_negocio WHERE id_negocio = v_id_negocio;
    IF v_nombre IS DISTINCT FROM 'Salón Demo EscalApp' THEN
        RAISE EXCEPTION 'El negocio % se llama "%", no "Salón Demo EscalApp". Abortado.',
            v_id_negocio, COALESCE(v_nombre, '(no existe)');
    END IF;

    -- Config. La crea explícitamente el fixture porque el adaptador exige que exista:
    -- `disponibilidadService.getConfig` la crearía sola, pero eso convierte una lectura en
    -- una escritura y rompería el "dry-run no deja rastro".
    INSERT INTO reserva.reserva_config (id_negocio, anticipacion_min_horas, buffer_limpieza_min, paso_slot_min)
    VALUES (v_id_negocio, 1, 10, 15)
    ON CONFLICT (id_negocio) DO NOTHING;

    -- ── Servicios ────────────────────────────────────────────────────────────────────────
    INSERT INTO reserva.reserva_servicio (id_negocio, nombre, descripcion, duracion_min, precio, estado)
    SELECT v_id_negocio, c.nombre, c.descripcion, c.duracion, c.precio, 'A'
      FROM (VALUES
            ('Corte de cabello',          'Corte clásico con lavado y secado',                30,  35000),
            ('Corte y barba',             'Corte completo más perfilado de barba',            45,  50000),
            ('Arreglo de barba',          'Perfilado, recorte y aceite hidratante',           20,  22000),
            ('Afeitado clásico a navaja', 'Toalla caliente, navaja y bálsamo',                30,  30000),
            ('Corte infantil',            'Corte para niños hasta 12 años',                   25,  25000),
            ('Tinte',                     'Coloración completa',                              90, 120000),
            ('Mechas y balayage',         'Iluminación con matizado incluido',               150, 220000),
            ('Peinado y secado',          'Brushing, ondas o recogido',                       40,  45000),
            ('Tratamiento capilar',       'Hidratación profunda con masaje',                  60,  70000),
            ('Alisado con keratina',      'Alisado progresivo, incluye lavado y sellado',    180, 280000),
            ('Manicure',                  'Limado, cutícula y esmaltado',                     40,  30000),
            ('Pedicure',                  'Spa de pies, limado y esmaltado',                  50,  40000),
            ('Diseño de cejas',           'Depilación y perfilado',                           15,  18000)
           ) AS c(nombre, descripcion, duracion, precio)
     WHERE NOT EXISTS (
        SELECT 1 FROM reserva.reserva_servicio s
         WHERE s.id_negocio = v_id_negocio AND s.nombre = c.nombre
     );

    -- ── Profesionales ────────────────────────────────────────────────────────────────────
    INSERT INTO reserva.reserva_profesional (id_negocio, nombre, especialidad, estado)
    SELECT v_id_negocio, p.nombre, p.especialidad, 'A'
      FROM (VALUES
            ('Laura Gómez',     'Colorimetría'),
            ('Marco Ruiz',      'Barbería'),
            ('Valentina Ríos',  'Estilismo y peinado'),
            ('Andrés Mora',     'Barbería clásica'),
            ('Camila Torres',   'Manicure y pedicure'),
            ('Sofía Herrera',   'Tratamientos capilares')
           ) AS p(nombre, especialidad)
     WHERE NOT EXISTS (
        SELECT 1 FROM reserva.reserva_profesional r
         WHERE r.id_negocio = v_id_negocio AND r.nombre = p.nombre
     );

    -- ── Quién presta qué ─────────────────────────────────────────────────────────────────
    -- Repartido a propósito de forma desigual: el corte lo hacen cuatro personas y el diseño
    -- de cejas una sola. Son los dos extremos de la misma consulta de disponibilidad.
    INSERT INTO reserva.reserva_profesional_servicio (id_profesional, id_servicio)
    SELECT pr.id_profesional, se.id_servicio
      FROM (VALUES
            ('Laura Gómez',    'Corte de cabello'),
            ('Laura Gómez',    'Tinte'),
            ('Laura Gómez',    'Mechas y balayage'),
            ('Laura Gómez',    'Peinado y secado'),
            ('Laura Gómez',    'Tratamiento capilar'),
            ('Laura Gómez',    'Alisado con keratina'),
            ('Marco Ruiz',     'Corte de cabello'),
            ('Marco Ruiz',     'Corte y barba'),
            ('Marco Ruiz',     'Arreglo de barba'),
            ('Marco Ruiz',     'Afeitado clásico a navaja'),
            ('Marco Ruiz',     'Corte infantil'),
            ('Valentina Ríos', 'Corte de cabello'),
            ('Valentina Ríos', 'Peinado y secado'),
            ('Valentina Ríos', 'Tinte'),
            ('Valentina Ríos', 'Alisado con keratina'),
            ('Andrés Mora',    'Corte de cabello'),
            ('Andrés Mora',    'Corte y barba'),
            ('Andrés Mora',    'Arreglo de barba'),
            ('Andrés Mora',    'Afeitado clásico a navaja'),
            ('Andrés Mora',    'Corte infantil'),
            ('Camila Torres',  'Manicure'),
            ('Camila Torres',  'Pedicure'),
            ('Camila Torres',  'Diseño de cejas'),
            ('Sofía Herrera',  'Tratamiento capilar'),
            ('Sofía Herrera',  'Mechas y balayage'),
            ('Sofía Herrera',  'Alisado con keratina')
           ) AS a(profesional, servicio)
      JOIN reserva.reserva_profesional pr
        ON pr.id_negocio = v_id_negocio AND pr.nombre = a.profesional
      JOIN reserva.reserva_servicio se
        ON se.id_negocio = v_id_negocio AND se.nombre = a.servicio
    ON CONFLICT DO NOTHING;

    -- ── Horarios ─────────────────────────────────────────────────────────────────────────
    -- `dia_semana`: 0=domingo … 6=sábado (es `Date.getDay()` de Bogotá, ver
    -- `reglasAgenda.diaSemanaLocal`). Cada persona tiene un horario DISTINTO a propósito:
    -- con agendas idénticas nunca se prueba la fusión de disponibilidades.
    INSERT INTO reserva.reserva_horario (id_negocio, id_profesional, dia_semana, hora_inicio, hora_fin)
    SELECT v_id_negocio, pr.id_profesional, h.dia, h.desde::time, h.hasta::time
      FROM (VALUES
            -- Laura: martes a sábado, jornada partida
            ('Laura Gómez', 2, '09:00', '13:00'), ('Laura Gómez', 2, '14:00', '18:00'),
            ('Laura Gómez', 3, '09:00', '13:00'), ('Laura Gómez', 3, '14:00', '18:00'),
            ('Laura Gómez', 4, '09:00', '13:00'), ('Laura Gómez', 4, '14:00', '18:00'),
            ('Laura Gómez', 5, '09:00', '13:00'), ('Laura Gómez', 5, '14:00', '18:00'),
            ('Laura Gómez', 6, '09:00', '14:00'),
            -- Marco: lunes a viernes, cierra más tarde
            ('Marco Ruiz', 1, '09:00', '13:00'), ('Marco Ruiz', 1, '14:00', '19:00'),
            ('Marco Ruiz', 2, '09:00', '13:00'), ('Marco Ruiz', 2, '14:00', '19:00'),
            ('Marco Ruiz', 3, '09:00', '13:00'), ('Marco Ruiz', 3, '14:00', '19:00'),
            ('Marco Ruiz', 4, '09:00', '13:00'), ('Marco Ruiz', 4, '14:00', '19:00'),
            ('Marco Ruiz', 5, '09:00', '13:00'), ('Marco Ruiz', 5, '14:00', '19:00'),
            -- Valentina: solo lunes, miércoles, viernes y sábado por la mañana
            ('Valentina Ríos', 1, '10:00', '18:00'),
            ('Valentina Ríos', 3, '10:00', '18:00'),
            ('Valentina Ríos', 5, '10:00', '18:00'),
            ('Valentina Ríos', 6, '09:00', '13:00'),
            -- Andrés: martes a sábado, entra y sale más tarde
            ('Andrés Mora', 2, '10:00', '14:00'), ('Andrés Mora', 2, '15:00', '19:00'),
            ('Andrés Mora', 3, '10:00', '14:00'), ('Andrés Mora', 3, '15:00', '19:00'),
            ('Andrés Mora', 4, '10:00', '14:00'), ('Andrés Mora', 4, '15:00', '19:00'),
            ('Andrés Mora', 5, '10:00', '14:00'), ('Andrés Mora', 5, '15:00', '19:00'),
            ('Andrés Mora', 6, '10:00', '16:00'),
            -- Camila: lunes a viernes de corrido, sin pausa de almuerzo
            ('Camila Torres', 1, '09:00', '17:00'),
            ('Camila Torres', 2, '09:00', '17:00'),
            ('Camila Torres', 3, '09:00', '17:00'),
            ('Camila Torres', 4, '09:00', '17:00'),
            ('Camila Torres', 5, '09:00', '17:00'),
            -- Sofía: solo jueves, viernes y sábado (los tratamientos largos)
            ('Sofía Herrera', 4, '10:00', '18:00'),
            ('Sofía Herrera', 5, '10:00', '18:00'),
            ('Sofía Herrera', 6, '10:00', '16:00')
           ) AS h(profesional, dia, desde, hasta)
      JOIN reserva.reserva_profesional pr
        ON pr.id_negocio = v_id_negocio AND pr.nombre = h.profesional
     WHERE NOT EXISTS (
        SELECT 1 FROM reserva.reserva_horario x
         WHERE x.id_negocio = v_id_negocio
           AND x.id_profesional = pr.id_profesional
           AND x.dia_semana = h.dia
           AND x.hora_inicio = h.desde::time
     );

    SELECT count(*) INTO v_serv FROM reserva.reserva_servicio    WHERE id_negocio = v_id_negocio AND estado = 'A';
    SELECT count(*) INTO v_prof FROM reserva.reserva_profesional WHERE id_negocio = v_id_negocio AND estado = 'A';
    SELECT count(*) INTO v_hor  FROM reserva.reserva_horario     WHERE id_negocio = v_id_negocio;

    RAISE NOTICE 'Catálogo de "%" (negocio %): % servicios, % profesionales, % bloques de horario.',
        v_nombre, v_id_negocio, v_serv, v_prof, v_hor;
END $$;
