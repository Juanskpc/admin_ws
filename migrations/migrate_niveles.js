/**
 * Migración de niveles: Crea tipo_nivel, altera gener_nivel e inserta
 * toda la estructura de módulos/vistas para cada tipo de negocio.
 * 
 * Ejecutar con: node migrations/migrate_niveles.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('=== Migración de Niveles ===\n');

        // ─── 1. Crear tabla gener_tipo_nivel ───
        console.log('1. Creando tabla gener_tipo_nivel...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS general.gener_tipo_nivel (
                id_tipo_nivel SERIAL PRIMARY KEY,
                nombre VARCHAR(100) NOT NULL UNIQUE,
                descripcion VARCHAR(255),
                orden INTEGER NOT NULL DEFAULT 0,
                estado CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        console.log('   OK\n');

        // ─── 2. Insertar tipos de nivel ───
        console.log('2. Insertando tipos de nivel...');
        await sequelize.query(`
            INSERT INTO general.gener_tipo_nivel (id_tipo_nivel, nombre, descripcion, orden) VALUES
                (1, 'MODULO',        'Módulo principal de navegación (nivel raíz)',           1),
                (2, 'SUBMODULO',     'Agrupador de funcionalidades dentro de un módulo',      2),
                (3, 'VISTA',         'Pantalla o página individual accesible por el usuario', 3),
                (4, 'ACCION',        'Operación específica dentro de una vista',              4)
            ON CONFLICT (nombre) DO NOTHING;
            SELECT setval('general.gener_tipo_nivel_id_tipo_nivel_seq', 4, true);
        `, { transaction: t });
        console.log('   OK\n');

        // ─── 3. Alterar gener_nivel: agregar id_tipo_negocio + FK tipo_nivel ───
        console.log('3. Alterando gener_nivel...');
        const [colCheck] = await sequelize.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema='general' AND table_name='gener_nivel' AND column_name='id_tipo_negocio';
        `, { transaction: t });

        if (colCheck.length === 0) {
            await sequelize.query(`
                ALTER TABLE general.gener_nivel
                ADD COLUMN id_tipo_negocio INTEGER;
            `, { transaction: t });
            console.log('   Columna id_tipo_negocio agregada');
        }

        // Agregar FK id_tipo_negocio -> gener_tipo_negocio
        const [fkTN] = await sequelize.query(`
            SELECT constraint_name FROM information_schema.table_constraints
            WHERE table_schema='general' AND table_name='gener_nivel' AND constraint_name='fk_nivel_tipo_negocio';
        `, { transaction: t });
        if (fkTN.length === 0) {
            await sequelize.query(`
                ALTER TABLE general.gener_nivel
                ADD CONSTRAINT fk_nivel_tipo_negocio
                    FOREIGN KEY (id_tipo_negocio) REFERENCES general.gener_tipo_negocio(id_tipo_negocio);
            `, { transaction: t });
            console.log('   FK id_tipo_negocio agregada');
        }

        // Agregar FK id_tipo_nivel -> gener_tipo_nivel
        const [fkTNv] = await sequelize.query(`
            SELECT constraint_name FROM information_schema.table_constraints
            WHERE table_schema='general' AND table_name='gener_nivel' AND constraint_name='fk_nivel_tipo_nivel';
        `, { transaction: t });
        if (fkTNv.length === 0) {
            await sequelize.query(`
                ALTER TABLE general.gener_nivel
                ADD CONSTRAINT fk_nivel_tipo_nivel
                    FOREIGN KEY (id_tipo_nivel) REFERENCES general.gener_tipo_nivel(id_tipo_nivel);
            `, { transaction: t });
            console.log('   FK id_tipo_nivel agregada');
        }
        console.log('   OK\n');

        // ─── 4. Insertar TODOS los niveles ───
        console.log('4. Insertando niveles para todos los tipos de negocio...\n');

        // Usamos IDs explícitos en rangos por tipo de negocio para claridad:
        // Restaurante: 100-199 | Parqueadero: 200-299 | Barbería: 300-399
        // Supermercado: 400-499 | Taller: 500-599 | Fondo: 600-699 | Financiera: 700-799

        await sequelize.query(`
        INSERT INTO general.gener_nivel (id_nivel, descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, id_tipo_negocio, url) VALUES

        -- ╔══════════════════════════════════════════════════════════════╗
        -- ║  RESTAURANTE (id_tipo_negocio = 1)  ·  IDs 100-199        ║
        -- ╚══════════════════════════════════════════════════════════════╝

        -- Autenticación
        (100, 'AUTENTICACION',          NULL, 'lock',            'A', 1, 1, '/auth'),
        (101, 'LOGIN',                  100,  'login',           'A', 3, 1, '/auth/login'),
        (102, 'RECUPERAR CONTRASEÑA',   100,  'lock_reset',      'A', 3, 1, '/auth/recuperar-password'),
        (103, 'CAMBIO DE CONTRASEÑA',   100,  'password',        'A', 3, 1, '/auth/cambiar-password'),

        -- Dashboard
        (110, 'DASHBOARD',              NULL, 'dashboard',       'A', 1, 1, '/dashboard'),
        (111, 'RESUMEN DE VENTAS',      110,  'trending_up',     'A', 3, 1, '/dashboard/resumen-ventas'),
        (112, 'PEDIDOS PENDIENTES',     110,  'pending_actions', 'A', 3, 1, '/dashboard/pedidos-pendientes'),
        (113, 'PRODUCTOS BAJO STOCK',   110,  'inventory_2',     'A', 3, 1, '/dashboard/bajo-stock'),
        (114, 'RESUMEN DE CAJA',        110,  'account_balance', 'A', 3, 1, '/dashboard/resumen-caja'),

        -- Punto de Venta
        (120, 'PUNTO DE VENTA',         NULL, 'point_of_sale',   'A', 1, 1, '/pos'),
        (121, 'PEDIDOS',                120,  'receipt_long',    'A', 2, 1, '/pos/pedidos'),
        (122, 'CREAR PEDIDO',           121,  'add_shopping_cart','A', 3, 1, '/pos/pedidos/crear'),
        (123, 'EDITAR PEDIDO',          121,  'edit_note',       'A', 3, 1, '/pos/pedidos/editar'),
        (124, 'APLICAR DESCUENTOS',     121,  'discount',        'A', 3, 1, '/pos/pedidos/descuentos'),
        (125, 'DIVIDIR CUENTA',         121,  'call_split',      'A', 3, 1, '/pos/pedidos/dividir-cuenta'),
        (126, 'ESTADO DEL PEDIDO',      121,  'swap_vert',       'A', 3, 1, '/pos/pedidos/estado'),
        (127, 'FACTURACION',            120,  'receipt',         'A', 2, 1, '/pos/facturacion'),
        (128, 'GENERAR FACTURA',        127,  'note_add',        'A', 3, 1, '/pos/facturacion/generar'),
        (129, 'IMPRIMIR TICKET',        127,  'print',           'A', 3, 1, '/pos/facturacion/imprimir'),

        -- Cocina
        (130, 'COCINA',                 NULL, 'restaurant',      'A', 1, 1, '/cocina'),
        (131, 'PEDIDOS PENDIENTES',     130,  'pending',         'A', 3, 1, '/cocina/pedidos-pendientes'),
        (132, 'DETALLE DEL PEDIDO',     130,  'list_alt',        'A', 3, 1, '/cocina/detalle-pedido'),
        (133, 'CAMBIAR ESTADO',         130,  'swap_horiz',      'A', 3, 1, '/cocina/cambiar-estado'),

        -- Inventario
        (140, 'INVENTARIO',             NULL, 'inventory',       'A', 1, 1, '/inventario'),
        (141, 'PRODUCTOS',              140,  'category',        'A', 2, 1, '/inventario/productos'),
        (142, 'CREAR PRODUCTO',         141,  'add_circle',      'A', 3, 1, '/inventario/productos/crear'),
        (143, 'EDITAR PRODUCTO',        141,  'edit',            'A', 3, 1, '/inventario/productos/editar'),
        (144, 'CATEGORIAS',             141,  'label',           'A', 3, 1, '/inventario/productos/categorias'),
        (145, 'UNIDADES DE MEDIDA',     141,  'straighten',      'A', 3, 1, '/inventario/productos/unidades'),
        (146, 'CONTROL DE STOCK',       140,  'inventory_2',     'A', 2, 1, '/inventario/stock'),
        (147, 'ENTRADA DE INVENTARIO',  146,  'add_box',         'A', 3, 1, '/inventario/stock/entrada'),
        (148, 'SALIDA POR VENTA',       146,  'remove_circle',   'A', 3, 1, '/inventario/stock/salida'),
        (149, 'ALERTAS BAJO STOCK',     146,  'warning',         'A', 3, 1, '/inventario/stock/alertas'),
        (150, 'HISTORIAL DE MOVIMIENTOS', 146, 'history',        'A', 3, 1, '/inventario/stock/historial'),

        -- Caja
        (160, 'CAJA',                   NULL, 'payments',        'A', 1, 1, '/caja'),
        (161, 'APERTURA DE CAJA',       160,  'lock_open',       'A', 3, 1, '/caja/apertura'),
        (162, 'CIERRE DE CAJA',         160,  'lock',            'A', 3, 1, '/caja/cierre'),
        (163, 'INGRESOS',               160,  'arrow_downward',  'A', 3, 1, '/caja/ingresos'),
        (164, 'EGRESOS',                160,  'arrow_upward',    'A', 3, 1, '/caja/egresos'),
        (165, 'HISTORIAL DE MOVIMIENTOS', 160, 'history',        'A', 3, 1, '/caja/historial'),
        (166, 'ARQUEO DE CAJA',         160,  'account_balance_wallet', 'A', 3, 1, '/caja/arqueo'),

        -- Gestión de Usuarios
        (170, 'GESTION DE USUARIOS',    NULL, 'people',          'A', 1, 1, '/usuarios'),
        (171, 'CREAR USUARIO',          170,  'person_add',      'A', 3, 1, '/usuarios/crear'),
        (172, 'ASIGNAR ROL',            170,  'admin_panel_settings', 'A', 3, 1, '/usuarios/asignar-rol'),
        (173, 'ACTIVAR / DESACTIVAR',   170,  'toggle_on',       'A', 3, 1, '/usuarios/activar-desactivar'),
        (174, 'HISTORIAL DE ACTIVIDAD', 170,  'history',         'A', 3, 1, '/usuarios/historial'),

        -- Reportes
        (180, 'REPORTES',               NULL, 'assessment',      'A', 1, 1, '/reportes'),
        (181, 'VENTAS POR DIA',         180,  'today',           'A', 3, 1, '/reportes/ventas-dia'),
        (182, 'VENTAS POR MES',         180,  'calendar_month',  'A', 3, 1, '/reportes/ventas-mes'),
        (183, 'VENTAS POR PRODUCTO',    180,  'shopping_bag',    'A', 3, 1, '/reportes/ventas-producto'),
        (184, 'PRODUCTOS MAS VENDIDOS', 180,  'star',            'A', 3, 1, '/reportes/mas-vendidos'),
        (185, 'VENTAS POR MESERO',      180,  'person',          'A', 3, 1, '/reportes/ventas-mesero'),
        (186, 'UTILIDAD BRUTA',         180,  'attach_money',    'A', 3, 1, '/reportes/utilidad'),
        (187, 'MOVIMIENTOS DE INVENTARIO', 180, 'swap_vert',     'A', 3, 1, '/reportes/mov-inventario'),

        -- Configuración
        (190, 'CONFIGURACION',          NULL, 'settings',        'A', 1, 1, '/configuracion'),
        (191, 'IMPUESTOS',              190,  'percent',         'A', 3, 1, '/configuracion/impuestos'),
        (192, 'METODOS DE PAGO',        190,  'credit_card',     'A', 3, 1, '/configuracion/metodos-pago'),
        (193, 'DATOS DEL RESTAURANTE',  190,  'store',           'A', 3, 1, '/configuracion/datos-negocio'),
        (194, 'PROPINAS',               190,  'volunteer_activism', 'A', 3, 1, '/configuracion/propinas'),
        (195, 'HORARIOS',               190,  'schedule',        'A', 3, 1, '/configuracion/horarios'),

        -- ╔══════════════════════════════════════════════════════════════╗
        -- ║  PARQUEADERO (id_tipo_negocio = 2)  ·  IDs 200-299        ║
        -- ╚══════════════════════════════════════════════════════════════╝

        -- Autenticación
        (200, 'AUTENTICACION',          NULL, 'lock',            'A', 1, 2, '/auth'),
        (201, 'LOGIN',                  200,  'login',           'A', 3, 2, '/auth/login'),
        (202, 'RECUPERAR CONTRASEÑA',   200,  'lock_reset',      'A', 3, 2, '/auth/recuperar-password'),
        (203, 'CAMBIO DE CONTRASEÑA',   200,  'password',        'A', 3, 2, '/auth/cambiar-password'),

        -- Dashboard
        (210, 'DASHBOARD',              NULL, 'dashboard',       'A', 1, 2, '/dashboard'),
        (211, 'RESUMEN DE INGRESOS',    210,  'trending_up',     'A', 3, 2, '/dashboard/resumen-ingresos'),
        (212, 'OCUPACION ACTUAL',       210,  'local_parking',   'A', 3, 2, '/dashboard/ocupacion'),
        (213, 'VEHICULOS EN PARQUEADERO', 210,'directions_car',  'A', 3, 2, '/dashboard/vehiculos-actual'),

        -- Control de Vehículos
        (220, 'CONTROL DE VEHICULOS',   NULL, 'directions_car',  'A', 1, 2, '/vehiculos'),
        (221, 'REGISTRO DE ENTRADA',    220,  'login',           'A', 3, 2, '/vehiculos/entrada'),
        (222, 'REGISTRO DE SALIDA',     220,  'logout',          'A', 3, 2, '/vehiculos/salida'),
        (223, 'VEHICULOS ACTUALES',     220,  'garage',          'A', 3, 2, '/vehiculos/actuales'),
        (224, 'HISTORIAL DE VEHICULOS', 220,  'history',         'A', 3, 2, '/vehiculos/historial'),

        -- Tarifas
        (230, 'TARIFAS',                NULL, 'sell',            'A', 1, 2, '/tarifas'),
        (231, 'GESTION DE TARIFAS',     230,  'price_change',    'A', 3, 2, '/tarifas/gestion'),
        (232, 'TARIFAS POR TIPO VEHICULO', 230, 'two_wheeler',  'A', 3, 2, '/tarifas/por-tipo'),
        (233, 'ABONOS Y MENSUALIDADES', 230,  'event_repeat',    'A', 3, 2, '/tarifas/abonos'),

        -- Caja
        (240, 'CAJA',                   NULL, 'payments',        'A', 1, 2, '/caja'),
        (241, 'APERTURA DE CAJA',       240,  'lock_open',       'A', 3, 2, '/caja/apertura'),
        (242, 'CIERRE DE CAJA',         240,  'lock',            'A', 3, 2, '/caja/cierre'),
        (243, 'COBROS',                 240,  'paid',            'A', 3, 2, '/caja/cobros'),
        (244, 'HISTORIAL DE MOVIMIENTOS', 240, 'history',        'A', 3, 2, '/caja/historial'),

        -- Gestión de Usuarios
        (250, 'GESTION DE USUARIOS',    NULL, 'people',          'A', 1, 2, '/usuarios'),
        (251, 'CREAR USUARIO',          250,  'person_add',      'A', 3, 2, '/usuarios/crear'),
        (252, 'ASIGNAR ROL',            250,  'admin_panel_settings', 'A', 3, 2, '/usuarios/asignar-rol'),
        (253, 'ACTIVAR / DESACTIVAR',   250,  'toggle_on',       'A', 3, 2, '/usuarios/activar-desactivar'),

        -- Reportes
        (260, 'REPORTES',               NULL, 'assessment',      'A', 1, 2, '/reportes'),
        (261, 'INGRESOS POR DIA',       260,  'today',           'A', 3, 2, '/reportes/ingresos-dia'),
        (262, 'INGRESOS POR MES',       260,  'calendar_month',  'A', 3, 2, '/reportes/ingresos-mes'),
        (263, 'OCUPACION HISTORICA',     260,  'bar_chart',       'A', 3, 2, '/reportes/ocupacion'),
        (264, 'VEHICULOS FRECUENTES',   260,  'repeat',          'A', 3, 2, '/reportes/vehiculos-frecuentes'),
        (265, 'INGRESOS POR TIPO VEHICULO', 260, 'pie_chart',   'A', 3, 2, '/reportes/ingresos-tipo'),

        -- Configuración
        (270, 'CONFIGURACION',          NULL, 'settings',        'A', 1, 2, '/configuracion'),
        (271, 'TIPOS DE VEHICULO',      270,  'commute',         'A', 3, 2, '/configuracion/tipos-vehiculo'),
        (272, 'CAPACIDAD DEL PARQUEADERO', 270, 'layers',        'A', 3, 2, '/configuracion/capacidad'),
        (273, 'METODOS DE PAGO',        270,  'credit_card',     'A', 3, 2, '/configuracion/metodos-pago'),
        (274, 'DATOS DEL PARQUEADERO',  270,  'store',           'A', 3, 2, '/configuracion/datos-negocio'),

        -- ╔══════════════════════════════════════════════════════════════╗
        -- ║  BARBERIA (id_tipo_negocio = 3)  ·  IDs 300-399            ║
        -- ╚══════════════════════════════════════════════════════════════╝

        -- Autenticación
        (300, 'AUTENTICACION',          NULL, 'lock',            'A', 1, 3, '/auth'),
        (301, 'LOGIN',                  300,  'login',           'A', 3, 3, '/auth/login'),
        (302, 'RECUPERAR CONTRASEÑA',   300,  'lock_reset',      'A', 3, 3, '/auth/recuperar-password'),
        (303, 'CAMBIO DE CONTRASEÑA',   300,  'password',        'A', 3, 3, '/auth/cambiar-password'),

        -- Dashboard
        (310, 'DASHBOARD',              NULL, 'dashboard',       'A', 1, 3, '/dashboard'),
        (311, 'CITAS DEL DIA',          310,  'event',           'A', 3, 3, '/dashboard/citas-dia'),
        (312, 'RESUMEN DE VENTAS',      310,  'trending_up',     'A', 3, 3, '/dashboard/resumen-ventas'),
        (313, 'BARBEROS DISPONIBLES',   310,  'groups',          'A', 3, 3, '/dashboard/barberos'),

        -- Agenda / Citas
        (320, 'AGENDA',                 NULL, 'event_note',      'A', 1, 3, '/agenda'),
        (321, 'CREAR CITA',             320,  'add_circle',      'A', 3, 3, '/agenda/crear'),
        (322, 'CALENDARIO',             320,  'calendar_month',  'A', 3, 3, '/agenda/calendario'),
        (323, 'HISTORIAL DE CITAS',     320,  'history',         'A', 3, 3, '/agenda/historial'),
        (324, 'CANCELAR / REPROGRAMAR', 320,  'event_busy',      'A', 3, 3, '/agenda/cancelar'),

        -- Servicios
        (330, 'SERVICIOS',              NULL, 'content_cut',     'A', 1, 3, '/servicios'),
        (331, 'GESTION DE SERVICIOS',   330,  'build',           'A', 3, 3, '/servicios/gestion'),
        (332, 'CATEGORIAS DE SERVICIOS', 330, 'label',           'A', 3, 3, '/servicios/categorias'),
        (333, 'LISTA DE PRECIOS',       330,  'sell',            'A', 3, 3, '/servicios/precios'),

        -- Punto de Venta
        (340, 'PUNTO DE VENTA',         NULL, 'point_of_sale',   'A', 1, 3, '/pos'),
        (341, 'REGISTRAR VENTA',        340,  'add_shopping_cart','A', 3, 3, '/pos/registrar'),
        (342, 'PRODUCTOS',              340,  'shopping_bag',    'A', 3, 3, '/pos/productos'),
        (343, 'FACTURACION',            340,  'receipt',         'A', 3, 3, '/pos/facturacion'),

        -- Caja
        (350, 'CAJA',                   NULL, 'payments',        'A', 1, 3, '/caja'),
        (351, 'APERTURA DE CAJA',       350,  'lock_open',       'A', 3, 3, '/caja/apertura'),
        (352, 'CIERRE DE CAJA',         350,  'lock',            'A', 3, 3, '/caja/cierre'),
        (353, 'INGRESOS',               350,  'arrow_downward',  'A', 3, 3, '/caja/ingresos'),
        (354, 'EGRESOS',                350,  'arrow_upward',    'A', 3, 3, '/caja/egresos'),
        (355, 'HISTORIAL DE MOVIMIENTOS', 350, 'history',        'A', 3, 3, '/caja/historial'),

        -- Clientes
        (360, 'CLIENTES',               NULL, 'people',          'A', 1, 3, '/clientes'),
        (361, 'REGISTRO DE CLIENTES',   360,  'person_add',      'A', 3, 3, '/clientes/registro'),
        (362, 'HISTORIAL DEL CLIENTE',  360,  'history',         'A', 3, 3, '/clientes/historial'),
        (363, 'PREFERENCIAS',           360,  'tune',            'A', 3, 3, '/clientes/preferencias'),

        -- Gestión de Usuarios
        (370, 'GESTION DE USUARIOS',    NULL, 'manage_accounts', 'A', 1, 3, '/usuarios'),
        (371, 'CREAR USUARIO',          370,  'person_add',      'A', 3, 3, '/usuarios/crear'),
        (372, 'ASIGNAR ROL',            370,  'admin_panel_settings', 'A', 3, 3, '/usuarios/asignar-rol'),
        (373, 'ACTIVAR / DESACTIVAR',   370,  'toggle_on',       'A', 3, 3, '/usuarios/activar-desactivar'),

        -- Reportes
        (380, 'REPORTES',               NULL, 'assessment',      'A', 1, 3, '/reportes'),
        (381, 'VENTAS POR DIA',         380,  'today',           'A', 3, 3, '/reportes/ventas-dia'),
        (382, 'VENTAS POR BARBERO',     380,  'person',          'A', 3, 3, '/reportes/ventas-barbero'),
        (383, 'SERVICIOS MAS SOLICITADOS', 380, 'star',          'A', 3, 3, '/reportes/servicios-top'),
        (384, 'INGRESOS POR MES',       380,  'calendar_month',  'A', 3, 3, '/reportes/ingresos-mes'),
        (385, 'CLIENTES FRECUENTES',    380,  'repeat',          'A', 3, 3, '/reportes/clientes-frecuentes'),

        -- Configuración
        (390, 'CONFIGURACION',          NULL, 'settings',        'A', 1, 3, '/configuracion'),
        (391, 'METODOS DE PAGO',        390,  'credit_card',     'A', 3, 3, '/configuracion/metodos-pago'),
        (392, 'DATOS DE LA BARBERIA',   390,  'store',           'A', 3, 3, '/configuracion/datos-negocio'),
        (393, 'HORARIOS DE ATENCION',   390,  'schedule',        'A', 3, 3, '/configuracion/horarios'),
        (394, 'COMISIONES',             390,  'percent',         'A', 3, 3, '/configuracion/comisiones'),

        -- ╔══════════════════════════════════════════════════════════════╗
        -- ║  SUPERMERCADO (id_tipo_negocio = 4)  ·  IDs 400-499        ║
        -- ╚══════════════════════════════════════════════════════════════╝

        -- Autenticación
        (400, 'AUTENTICACION',          NULL, 'lock',            'A', 1, 4, '/auth'),
        (401, 'LOGIN',                  400,  'login',           'A', 3, 4, '/auth/login'),
        (402, 'RECUPERAR CONTRASEÑA',   400,  'lock_reset',      'A', 3, 4, '/auth/recuperar-password'),
        (403, 'CAMBIO DE CONTRASEÑA',   400,  'password',        'A', 3, 4, '/auth/cambiar-password'),

        -- Dashboard
        (410, 'DASHBOARD',              NULL, 'dashboard',       'A', 1, 4, '/dashboard'),
        (411, 'RESUMEN DE VENTAS',      410,  'trending_up',     'A', 3, 4, '/dashboard/resumen-ventas'),
        (412, 'PRODUCTOS BAJO STOCK',   410,  'inventory_2',     'A', 3, 4, '/dashboard/bajo-stock'),
        (413, 'RESUMEN DE CAJA',        410,  'account_balance', 'A', 3, 4, '/dashboard/resumen-caja'),

        -- Punto de Venta
        (420, 'PUNTO DE VENTA',         NULL, 'point_of_sale',   'A', 1, 4, '/pos'),
        (421, 'REGISTRAR VENTA',        420,  'add_shopping_cart','A', 3, 4, '/pos/registrar'),
        (422, 'ESCANEAR PRODUCTOS',     420,  'qr_code_scanner', 'A', 3, 4, '/pos/escanear'),
        (423, 'APLICAR DESCUENTOS',     420,  'discount',        'A', 3, 4, '/pos/descuentos'),
        (424, 'FACTURACION',            420,  'receipt',         'A', 3, 4, '/pos/facturacion'),
        (425, 'DEVOLUCIONES',           420,  'assignment_return','A', 3, 4, '/pos/devoluciones'),

        -- Inventario
        (430, 'INVENTARIO',             NULL, 'inventory',       'A', 1, 4, '/inventario'),
        (431, 'PRODUCTOS',              430,  'category',        'A', 2, 4, '/inventario/productos'),
        (432, 'CREAR PRODUCTO',         431,  'add_circle',      'A', 3, 4, '/inventario/productos/crear'),
        (433, 'EDITAR PRODUCTO',        431,  'edit',            'A', 3, 4, '/inventario/productos/editar'),
        (434, 'CATEGORIAS',             431,  'label',           'A', 3, 4, '/inventario/productos/categorias'),
        (435, 'CODIGOS DE BARRAS',      431,  'qr_code',         'A', 3, 4, '/inventario/productos/codigos'),
        (436, 'CONTROL DE STOCK',       430,  'inventory_2',     'A', 2, 4, '/inventario/stock'),
        (437, 'ENTRADA DE INVENTARIO',  436,  'add_box',         'A', 3, 4, '/inventario/stock/entrada'),
        (438, 'SALIDA DE INVENTARIO',   436,  'remove_circle',   'A', 3, 4, '/inventario/stock/salida'),
        (439, 'ALERTAS BAJO STOCK',     436,  'warning',         'A', 3, 4, '/inventario/stock/alertas'),
        (440, 'HISTORIAL DE MOVIMIENTOS', 436, 'history',        'A', 3, 4, '/inventario/stock/historial'),
        (441, 'PROVEEDORES',            430,  'local_shipping',  'A', 2, 4, '/inventario/proveedores'),
        (442, 'GESTION DE PROVEEDORES', 441,  'business',        'A', 3, 4, '/inventario/proveedores/gestion'),
        (443, 'ORDENES DE COMPRA',      441,  'shopping_cart',   'A', 3, 4, '/inventario/proveedores/ordenes'),

        -- Caja
        (450, 'CAJA',                   NULL, 'payments',        'A', 1, 4, '/caja'),
        (451, 'APERTURA DE CAJA',       450,  'lock_open',       'A', 3, 4, '/caja/apertura'),
        (452, 'CIERRE DE CAJA',         450,  'lock',            'A', 3, 4, '/caja/cierre'),
        (453, 'INGRESOS',               450,  'arrow_downward',  'A', 3, 4, '/caja/ingresos'),
        (454, 'EGRESOS',                450,  'arrow_upward',    'A', 3, 4, '/caja/egresos'),
        (455, 'HISTORIAL DE MOVIMIENTOS', 450, 'history',        'A', 3, 4, '/caja/historial'),
        (456, 'ARQUEO DE CAJA',         450,  'account_balance_wallet', 'A', 3, 4, '/caja/arqueo'),

        -- Clientes
        (460, 'CLIENTES',               NULL, 'people',          'A', 1, 4, '/clientes'),
        (461, 'REGISTRO DE CLIENTES',   460,  'person_add',      'A', 3, 4, '/clientes/registro'),
        (462, 'PROGRAMA DE FIDELIZACION', 460, 'card_membership','A', 3, 4, '/clientes/fidelizacion'),
        (463, 'HISTORIAL DE COMPRAS',   460,  'history',         'A', 3, 4, '/clientes/historial'),

        -- Gestión de Usuarios
        (470, 'GESTION DE USUARIOS',    NULL, 'manage_accounts', 'A', 1, 4, '/usuarios'),
        (471, 'CREAR USUARIO',          470,  'person_add',      'A', 3, 4, '/usuarios/crear'),
        (472, 'ASIGNAR ROL',            470,  'admin_panel_settings', 'A', 3, 4, '/usuarios/asignar-rol'),
        (473, 'ACTIVAR / DESACTIVAR',   470,  'toggle_on',       'A', 3, 4, '/usuarios/activar-desactivar'),

        -- Reportes
        (480, 'REPORTES',               NULL, 'assessment',      'A', 1, 4, '/reportes'),
        (481, 'VENTAS POR DIA',         480,  'today',           'A', 3, 4, '/reportes/ventas-dia'),
        (482, 'VENTAS POR MES',         480,  'calendar_month',  'A', 3, 4, '/reportes/ventas-mes'),
        (483, 'VENTAS POR PRODUCTO',    480,  'shopping_bag',    'A', 3, 4, '/reportes/ventas-producto'),
        (484, 'VENTAS POR CATEGORIA',   480,  'label',           'A', 3, 4, '/reportes/ventas-categoria'),
        (485, 'PRODUCTOS MAS VENDIDOS', 480,  'star',            'A', 3, 4, '/reportes/mas-vendidos'),
        (486, 'UTILIDAD BRUTA',         480,  'attach_money',    'A', 3, 4, '/reportes/utilidad'),
        (487, 'MOVIMIENTOS DE INVENTARIO', 480, 'swap_vert',     'A', 3, 4, '/reportes/mov-inventario'),

        -- Configuración
        (490, 'CONFIGURACION',          NULL, 'settings',        'A', 1, 4, '/configuracion'),
        (491, 'IMPUESTOS',              490,  'percent',         'A', 3, 4, '/configuracion/impuestos'),
        (492, 'METODOS DE PAGO',        490,  'credit_card',     'A', 3, 4, '/configuracion/metodos-pago'),
        (493, 'DATOS DEL SUPERMERCADO', 490,  'store',           'A', 3, 4, '/configuracion/datos-negocio'),

        -- ╔══════════════════════════════════════════════════════════════╗
        -- ║  TALLER AUTOMOTRIZ (id_tipo_negocio = 5)  ·  IDs 500-599   ║
        -- ╚══════════════════════════════════════════════════════════════╝

        -- Autenticación
        (500, 'AUTENTICACION',          NULL, 'lock',            'A', 1, 5, '/auth'),
        (501, 'LOGIN',                  500,  'login',           'A', 3, 5, '/auth/login'),
        (502, 'RECUPERAR CONTRASEÑA',   500,  'lock_reset',      'A', 3, 5, '/auth/recuperar-password'),
        (503, 'CAMBIO DE CONTRASEÑA',   500,  'password',        'A', 3, 5, '/auth/cambiar-password'),

        -- Dashboard
        (510, 'DASHBOARD',              NULL, 'dashboard',       'A', 1, 5, '/dashboard'),
        (511, 'ORDENES ACTIVAS',        510,  'assignment',      'A', 3, 5, '/dashboard/ordenes-activas'),
        (512, 'RESUMEN DE INGRESOS',    510,  'trending_up',     'A', 3, 5, '/dashboard/resumen-ingresos'),
        (513, 'VEHICULOS EN TALLER',    510,  'garage',          'A', 3, 5, '/dashboard/vehiculos-taller'),

        -- Órdenes de Trabajo
        (520, 'ORDENES DE TRABAJO',     NULL, 'assignment',      'A', 1, 5, '/ordenes'),
        (521, 'CREAR ORDEN',            520,  'note_add',        'A', 3, 5, '/ordenes/crear'),
        (522, 'ASIGNAR MECANICO',       520,  'engineering',     'A', 3, 5, '/ordenes/asignar'),
        (523, 'ESTADO DE LA ORDEN',     520,  'swap_vert',       'A', 3, 5, '/ordenes/estado'),
        (524, 'HISTORIAL DE ORDENES',   520,  'history',         'A', 3, 5, '/ordenes/historial'),
        (525, 'DIAGNOSTICOS',           520,  'troubleshoot',    'A', 3, 5, '/ordenes/diagnosticos'),

        -- Vehículos
        (530, 'VEHICULOS',              NULL, 'directions_car',  'A', 1, 5, '/vehiculos'),
        (531, 'REGISTRO DE VEHICULOS',  530,  'add_circle',      'A', 3, 5, '/vehiculos/registro'),
        (532, 'HISTORIAL POR VEHICULO', 530,  'history',         'A', 3, 5, '/vehiculos/historial'),
        (533, 'FICHA TECNICA',          530,  'description',     'A', 3, 5, '/vehiculos/ficha'),

        -- Inventario / Repuestos
        (540, 'REPUESTOS',              NULL, 'build',           'A', 1, 5, '/repuestos'),
        (541, 'GESTION DE REPUESTOS',   540,  'settings',        'A', 3, 5, '/repuestos/gestion'),
        (542, 'CATEGORIAS',             540,  'label',           'A', 3, 5, '/repuestos/categorias'),
        (543, 'CONTROL DE STOCK',       540,  'inventory_2',     'A', 3, 5, '/repuestos/stock'),
        (544, 'PROVEEDORES',            540,  'local_shipping',  'A', 3, 5, '/repuestos/proveedores'),
        (545, 'ORDENES DE COMPRA',      540,  'shopping_cart',   'A', 3, 5, '/repuestos/ordenes-compra'),

        -- Clientes
        (550, 'CLIENTES',               NULL, 'people',          'A', 1, 5, '/clientes'),
        (551, 'REGISTRO DE CLIENTES',   550,  'person_add',      'A', 3, 5, '/clientes/registro'),
        (552, 'HISTORIAL DEL CLIENTE',  550,  'history',         'A', 3, 5, '/clientes/historial'),

        -- Caja / Facturación
        (560, 'CAJA',                   NULL, 'payments',        'A', 1, 5, '/caja'),
        (561, 'APERTURA DE CAJA',       560,  'lock_open',       'A', 3, 5, '/caja/apertura'),
        (562, 'CIERRE DE CAJA',         560,  'lock',            'A', 3, 5, '/caja/cierre'),
        (563, 'FACTURACION',            560,  'receipt',         'A', 3, 5, '/caja/facturacion'),
        (564, 'HISTORIAL DE PAGOS',     560,  'history',         'A', 3, 5, '/caja/historial'),

        -- Gestión de Usuarios
        (570, 'GESTION DE USUARIOS',    NULL, 'manage_accounts', 'A', 1, 5, '/usuarios'),
        (571, 'CREAR USUARIO',          570,  'person_add',      'A', 3, 5, '/usuarios/crear'),
        (572, 'ASIGNAR ROL',            570,  'admin_panel_settings', 'A', 3, 5, '/usuarios/asignar-rol'),
        (573, 'ACTIVAR / DESACTIVAR',   570,  'toggle_on',       'A', 3, 5, '/usuarios/activar-desactivar'),

        -- Reportes
        (580, 'REPORTES',               NULL, 'assessment',      'A', 1, 5, '/reportes'),
        (581, 'INGRESOS POR DIA',       580,  'today',           'A', 3, 5, '/reportes/ingresos-dia'),
        (582, 'INGRESOS POR MES',       580,  'calendar_month',  'A', 3, 5, '/reportes/ingresos-mes'),
        (583, 'ORDENES POR MECANICO',   580,  'person',          'A', 3, 5, '/reportes/ordenes-mecanico'),
        (584, 'REPUESTOS MAS UTILIZADOS', 580, 'star',           'A', 3, 5, '/reportes/repuestos-top'),
        (585, 'SERVICIOS MAS SOLICITADOS', 580, 'trending_up',   'A', 3, 5, '/reportes/servicios-top'),

        -- Configuración
        (590, 'CONFIGURACION',          NULL, 'settings',        'A', 1, 5, '/configuracion'),
        (591, 'TIPOS DE SERVICIO',      590,  'build',           'A', 3, 5, '/configuracion/tipos-servicio'),
        (592, 'METODOS DE PAGO',        590,  'credit_card',     'A', 3, 5, '/configuracion/metodos-pago'),
        (593, 'DATOS DEL TALLER',       590,  'store',           'A', 3, 5, '/configuracion/datos-negocio'),
        (594, 'HORARIOS',               590,  'schedule',        'A', 3, 5, '/configuracion/horarios'),

        -- ╔══════════════════════════════════════════════════════════════╗
        -- ║  FONDO DE AHORROS (id_tipo_negocio = 6)  ·  IDs 600-699    ║
        -- ╚══════════════════════════════════════════════════════════════╝

        -- Autenticación
        (600, 'AUTENTICACION',          NULL, 'lock',            'A', 1, 6, '/auth'),
        (601, 'LOGIN',                  600,  'login',           'A', 3, 6, '/auth/login'),
        (602, 'RECUPERAR CONTRASEÑA',   600,  'lock_reset',      'A', 3, 6, '/auth/recuperar-password'),
        (603, 'CAMBIO DE CONTRASEÑA',   600,  'password',        'A', 3, 6, '/auth/cambiar-password'),

        -- Dashboard
        (610, 'DASHBOARD',              NULL, 'dashboard',       'A', 1, 6, '/dashboard'),
        (611, 'RESUMEN GENERAL',        610,  'summarize',       'A', 3, 6, '/dashboard/resumen'),
        (612, 'AHORROS DEL PERIODO',    610,  'savings',         'A', 3, 6, '/dashboard/ahorros-periodo'),
        (613, 'CREDITOS ACTIVOS',       610,  'credit_score',    'A', 3, 6, '/dashboard/creditos-activos'),
        (614, 'APORTES RECIBIDOS',      610,  'volunteer_activism', 'A', 3, 6, '/dashboard/aportes'),

        -- Asociados
        (620, 'ASOCIADOS',              NULL, 'groups',          'A', 1, 6, '/asociados'),
        (621, 'REGISTRO DE ASOCIADOS',  620,  'person_add',      'A', 3, 6, '/asociados/registro'),
        (622, 'GESTION DE ASOCIADOS',   620,  'manage_accounts', 'A', 3, 6, '/asociados/gestion'),
        (623, 'ESTADO DE CUENTA',       620,  'account_balance', 'A', 3, 6, '/asociados/estado-cuenta'),
        (624, 'HISTORIAL DEL ASOCIADO', 620,  'history',         'A', 3, 6, '/asociados/historial'),

        -- Ahorros
        (630, 'AHORROS',                NULL, 'savings',         'A', 1, 6, '/ahorros'),
        (631, 'DEPOSITOS',              630,  'arrow_downward',  'A', 3, 6, '/ahorros/depositos'),
        (632, 'RETIROS',                630,  'arrow_upward',    'A', 3, 6, '/ahorros/retiros'),
        (633, 'HISTORIAL DE MOVIMIENTOS', 630, 'history',        'A', 3, 6, '/ahorros/historial'),
        (634, 'SALDOS',                 630,  'account_balance_wallet', 'A', 3, 6, '/ahorros/saldos'),

        -- Aportes
        (640, 'APORTES',                NULL, 'volunteer_activism', 'A', 1, 6, '/aportes'),
        (641, 'REGISTRO DE APORTES',    640,  'add_circle',      'A', 3, 6, '/aportes/registro'),
        (642, 'HISTORIAL DE APORTES',   640,  'history',         'A', 3, 6, '/aportes/historial'),
        (643, 'APORTES PENDIENTES',     640,  'pending',         'A', 3, 6, '/aportes/pendientes'),

        -- Créditos
        (650, 'CREDITOS',               NULL, 'credit_score',    'A', 1, 6, '/creditos'),
        (651, 'SOLICITUDES DE CREDITO', 650,  'note_add',        'A', 3, 6, '/creditos/solicitudes'),
        (652, 'APROBACION DE CREDITOS', 650,  'check_circle',    'A', 3, 6, '/creditos/aprobacion'),
        (653, 'DESEMBOLSOS',            650,  'paid',            'A', 3, 6, '/creditos/desembolsos'),
        (654, 'PLAN DE PAGOS',          650,  'event_repeat',    'A', 3, 6, '/creditos/plan-pagos'),
        (655, 'ESTADO DE CREDITOS',     650,  'swap_vert',       'A', 3, 6, '/creditos/estado'),

        -- Tesorería
        (660, 'TESORERIA',              NULL, 'account_balance', 'A', 1, 6, '/tesoreria'),
        (661, 'MOVIMIENTOS',            660,  'swap_vert',       'A', 3, 6, '/tesoreria/movimientos'),
        (662, 'BALANCE GENERAL',        660,  'pie_chart',       'A', 3, 6, '/tesoreria/balance'),
        (663, 'CONCILIACION',           660,  'fact_check',      'A', 3, 6, '/tesoreria/conciliacion'),

        -- Gestión de Usuarios
        (670, 'GESTION DE USUARIOS',    NULL, 'manage_accounts', 'A', 1, 6, '/usuarios'),
        (671, 'CREAR USUARIO',          670,  'person_add',      'A', 3, 6, '/usuarios/crear'),
        (672, 'ASIGNAR ROL',            670,  'admin_panel_settings', 'A', 3, 6, '/usuarios/asignar-rol'),
        (673, 'ACTIVAR / DESACTIVAR',   670,  'toggle_on',       'A', 3, 6, '/usuarios/activar-desactivar'),

        -- Reportes
        (680, 'REPORTES',               NULL, 'assessment',      'A', 1, 6, '/reportes'),
        (681, 'AHORROS POR PERIODO',    680,  'savings',         'A', 3, 6, '/reportes/ahorros-periodo'),
        (682, 'CREDITOS OTORGADOS',     680,  'credit_score',    'A', 3, 6, '/reportes/creditos-otorgados'),
        (683, 'MOROSIDAD',              680,  'warning',         'A', 3, 6, '/reportes/morosidad'),
        (684, 'BALANCE DE APORTES',     680,  'bar_chart',       'A', 3, 6, '/reportes/balance-aportes'),
        (685, 'ESTADO FINANCIERO',      680,  'pie_chart',       'A', 3, 6, '/reportes/estado-financiero'),

        -- Configuración
        (690, 'CONFIGURACION',          NULL, 'settings',        'A', 1, 6, '/configuracion'),
        (691, 'TASAS DE INTERES',       690,  'percent',         'A', 3, 6, '/configuracion/tasas-interes'),
        (692, 'POLITICAS DE CREDITO',   690,  'policy',          'A', 3, 6, '/configuracion/politicas'),
        (693, 'DATOS DEL FONDO',        690,  'store',           'A', 3, 6, '/configuracion/datos-negocio'),
        (694, 'PERIODOS DE LIQUIDACION', 690, 'date_range',      'A', 3, 6, '/configuracion/periodos'),

        -- ╔══════════════════════════════════════════════════════════════╗
        -- ║  FINANCIERA DE PRESTAMOS (id_tipo_negocio = 7)  · IDs 700+ ║
        -- ╚══════════════════════════════════════════════════════════════╝

        -- Autenticación
        (700, 'AUTENTICACION',          NULL, 'lock',            'A', 1, 7, '/auth'),
        (701, 'LOGIN',                  700,  'login',           'A', 3, 7, '/auth/login'),
        (702, 'RECUPERAR CONTRASEÑA',   700,  'lock_reset',      'A', 3, 7, '/auth/recuperar-password'),
        (703, 'CAMBIO DE CONTRASEÑA',   700,  'password',        'A', 3, 7, '/auth/cambiar-password'),

        -- Dashboard
        (710, 'DASHBOARD',              NULL, 'dashboard',       'A', 1, 7, '/dashboard'),
        (711, 'RESUMEN DE CARTERA',     710,  'account_balance', 'A', 3, 7, '/dashboard/resumen-cartera'),
        (712, 'PRESTAMOS ACTIVOS',      710,  'credit_score',    'A', 3, 7, '/dashboard/prestamos-activos'),
        (713, 'COBROS DEL DIA',         710,  'today',           'A', 3, 7, '/dashboard/cobros-dia'),
        (714, 'MOROSIDAD',              710,  'warning',         'A', 3, 7, '/dashboard/morosidad'),

        -- Clientes
        (720, 'CLIENTES',               NULL, 'people',          'A', 1, 7, '/clientes'),
        (721, 'REGISTRO DE CLIENTES',   720,  'person_add',      'A', 3, 7, '/clientes/registro'),
        (722, 'EVALUACION CREDITICIA',  720,  'fact_check',      'A', 3, 7, '/clientes/evaluacion'),
        (723, 'HISTORIAL DEL CLIENTE',  720,  'history',         'A', 3, 7, '/clientes/historial'),
        (724, 'DOCUMENTACION',          720,  'folder',          'A', 3, 7, '/clientes/documentacion'),

        -- Préstamos
        (730, 'PRESTAMOS',              NULL, 'credit_score',    'A', 1, 7, '/prestamos'),
        (731, 'SOLICITUD DE PRESTAMO',  730,  'note_add',        'A', 3, 7, '/prestamos/solicitud'),
        (732, 'APROBACION',             730,  'check_circle',    'A', 3, 7, '/prestamos/aprobacion'),
        (733, 'DESEMBOLSO',             730,  'paid',            'A', 3, 7, '/prestamos/desembolso'),
        (734, 'PLAN DE PAGOS',          730,  'event_repeat',    'A', 3, 7, '/prestamos/plan-pagos'),
        (735, 'ESTADO DE PRESTAMOS',    730,  'swap_vert',       'A', 3, 7, '/prestamos/estado'),
        (736, 'REFINANCIAMIENTO',       730,  'autorenew',       'A', 3, 7, '/prestamos/refinanciamiento'),

        -- Cobranza
        (740, 'COBRANZA',               NULL, 'request_quote',   'A', 1, 7, '/cobranza'),
        (741, 'REGISTRO DE PAGOS',      740,  'paid',            'A', 3, 7, '/cobranza/pagos'),
        (742, 'GESTION DE MORA',        740,  'warning',         'A', 3, 7, '/cobranza/mora'),
        (743, 'GESTION DE COBRO',       740,  'call',            'A', 3, 7, '/cobranza/gestion'),
        (744, 'HISTORIAL DE PAGOS',     740,  'history',         'A', 3, 7, '/cobranza/historial'),
        (745, 'ACUERDOS DE PAGO',       740,  'handshake',       'A', 3, 7, '/cobranza/acuerdos'),

        -- Caja
        (750, 'CAJA',                   NULL, 'payments',        'A', 1, 7, '/caja'),
        (751, 'APERTURA DE CAJA',       750,  'lock_open',       'A', 3, 7, '/caja/apertura'),
        (752, 'CIERRE DE CAJA',         750,  'lock',            'A', 3, 7, '/caja/cierre'),
        (753, 'INGRESOS',               750,  'arrow_downward',  'A', 3, 7, '/caja/ingresos'),
        (754, 'EGRESOS',                750,  'arrow_upward',    'A', 3, 7, '/caja/egresos'),
        (755, 'HISTORIAL DE MOVIMIENTOS', 750, 'history',        'A', 3, 7, '/caja/historial'),

        -- Gestión de Usuarios
        (760, 'GESTION DE USUARIOS',    NULL, 'manage_accounts', 'A', 1, 7, '/usuarios'),
        (761, 'CREAR USUARIO',          760,  'person_add',      'A', 3, 7, '/usuarios/crear'),
        (762, 'ASIGNAR ROL',            760,  'admin_panel_settings', 'A', 3, 7, '/usuarios/asignar-rol'),
        (763, 'ACTIVAR / DESACTIVAR',   760,  'toggle_on',       'A', 3, 7, '/usuarios/activar-desactivar'),

        -- Reportes
        (770, 'REPORTES',               NULL, 'assessment',      'A', 1, 7, '/reportes'),
        (771, 'CARTERA POR PERIODO',    770,  'date_range',      'A', 3, 7, '/reportes/cartera-periodo'),
        (772, 'PRESTAMOS OTORGADOS',    770,  'credit_score',    'A', 3, 7, '/reportes/prestamos-otorgados'),
        (773, 'RECAUDO POR DIA',        770,  'today',           'A', 3, 7, '/reportes/recaudo-dia'),
        (774, 'INDICE DE MOROSIDAD',    770,  'warning',         'A', 3, 7, '/reportes/morosidad'),
        (775, 'RENTABILIDAD',           770,  'trending_up',     'A', 3, 7, '/reportes/rentabilidad'),
        (776, 'CARTERA POR ASESOR',     770,  'person',          'A', 3, 7, '/reportes/cartera-asesor'),

        -- Configuración
        (780, 'CONFIGURACION',          NULL, 'settings',        'A', 1, 7, '/configuracion'),
        (781, 'TASAS DE INTERES',       780,  'percent',         'A', 3, 7, '/configuracion/tasas-interes'),
        (782, 'POLITICAS DE PRESTAMO',  780,  'policy',          'A', 3, 7, '/configuracion/politicas'),
        (783, 'METODOS DE PAGO',        780,  'credit_card',     'A', 3, 7, '/configuracion/metodos-pago'),
        (784, 'DATOS DE LA FINANCIERA', 780,  'store',           'A', 3, 7, '/configuracion/datos-negocio'),
        (785, 'PENALIZACIONES',         780,  'gavel',           'A', 3, 7, '/configuracion/penalizaciones')

        ON CONFLICT (id_nivel) DO NOTHING;
        `, { transaction: t });

        // Ajustar la secuencia para futuros inserts
        await sequelize.query(`
            SELECT setval('general.gener_nivel_id_nivel_seq', (SELECT MAX(id_nivel) FROM general.gener_nivel), true);
        `, { transaction: t });

        await t.commit();

        // ─── Verificar ───
        const [counts] = await sequelize.query(`
            SELECT tn.nombre as tipo_negocio,
                   COUNT(*) as total_niveles,
                   SUM(CASE WHEN n.id_tipo_nivel = 1 THEN 1 ELSE 0 END) as modulos,
                   SUM(CASE WHEN n.id_tipo_nivel = 2 THEN 1 ELSE 0 END) as submodulos,
                   SUM(CASE WHEN n.id_tipo_nivel = 3 THEN 1 ELSE 0 END) as vistas
            FROM general.gener_nivel n
            JOIN general.gener_tipo_negocio tn ON n.id_tipo_negocio = tn.id_tipo_negocio
            GROUP BY tn.nombre, tn.id_tipo_negocio
            ORDER BY tn.id_tipo_negocio;
        `);
        console.log('\n=== Resumen de niveles insertados ===');
        counts.forEach(c => {
            console.log(`${c.tipo_negocio}: ${c.total_niveles} niveles (${c.modulos} módulos, ${c.submodulos} submódulos, ${c.vistas} vistas)`);
        });

        const [tiposNivel] = await sequelize.query('SELECT * FROM general.gener_tipo_nivel ORDER BY id_tipo_nivel;');
        console.log('\nTipos de nivel:', JSON.stringify(tiposNivel, null, 2));

        console.log('\n=== Migración completada exitosamente ===');
    } catch (error) {
        await t.rollback();
        console.error('Error en migración:', error.message);
        console.error(error);
    } finally {
        await sequelize.close();
        process.exit(0);
    }
}

migrate();
