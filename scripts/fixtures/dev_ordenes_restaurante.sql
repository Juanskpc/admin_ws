-- Datos sintéticos para verificar el backfill de F0.
-- Reproduce los casos límite encontrados en la medición de producción.
DELETE FROM restaurante.pedid_orden WHERE numero_orden LIKE 'TEST-%';
DELETE FROM platform.persona_negocio WHERE id_negocio = 1;

INSERT INTO restaurante.pedid_orden
    (id_negocio, id_usuario, numero_orden, subtotal, impuesto, total, estado,
     fecha_creacion, tipo_pedido, estado_pago, contacto_nombre, contacto_telefono)
VALUES
-- Mismo humano, cinco formatos distintos. Deben colapsar en UNA persona.
-- El nombre esperado es 'Nombre Nuevo': el de la orden más reciente (2026-06-01).
(1, 1, 'TEST-01', 100, 0, 100, 'CERRADA', '2026-01-01 10:00', 'DOMICILIO', 'pagado', 'Nombre Viejo',  '3001112233'),
(1, 1, 'TEST-02', 100, 0, 100, 'CERRADA', '2026-02-01 10:00', 'DOMICILIO', 'pagado', 'Nombre Medio',  '300 111 2233'),
(1, 1, 'TEST-03', 100, 0, 100, 'CERRADA', '2026-03-01 10:00', 'DOMICILIO', 'pagado', 'Nombre Medio',  '+57 300 111 2233'),
(1, 1, 'TEST-04', 100, 0, 100, 'CERRADA', '2026-04-01 10:00', 'DOMICILIO', 'pagado', 'Nombre Medio',  '573001112233'),
(1, 1, 'TEST-05', 100, 0, 100, 'CERRADA', '2026-06-01 10:00', 'DOMICILIO', 'pagado', 'Nombre Nuevo',  '03001112233'),
-- Segundo humano distinto.
(1, 1, 'TEST-06', 100, 0, 100, 'CERRADA', '2026-05-01 10:00', 'DOMICILIO', 'pagado', 'Otra Persona',  '3009998877'),
-- Basura y no-móviles: NO deben enlazarse.
(1, 1, 'TEST-07', 100, 0, 100, 'CERRADA', '2026-05-02 10:00', 'DOMICILIO', 'pagado', 'Basura',        '0000000000'),
(1, 1, 'TEST-08', 100, 0, 100, 'CERRADA', '2026-05-03 10:00', 'DOMICILIO', 'pagado', 'Corto',         '12345'),
(1, 1, 'TEST-09', 100, 0, 100, 'CERRADA', '2026-05-04 10:00', 'DOMICILIO', 'pagado', 'Fijo',          '6012345678'),
-- Sin teléfono: pedidos de mesa/llevar, el caso mayoritario en producción.
(1, 1, 'TEST-10', 100, 0, 100, 'CERRADA', '2026-05-05 10:00', 'MESA',      'pagado', NULL,            NULL),
(1, 1, 'TEST-11', 100, 0, 100, 'CERRADA', '2026-05-06 10:00', 'LLEVAR',    'pagado', NULL,            '');
