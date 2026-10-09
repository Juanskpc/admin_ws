const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { body, param, query } = require('express-validator');
const router = express.Router();

const DashboardController  = require('../controllers/dashboardController');
const CartaController      = require('../controllers/cartaController');
const CartaAdminController = require('../controllers/cartaAdminController');
const PublicoController    = require('../controllers/publicoController');
const EventosController    = require('../controllers/eventosController');
const CuentaController     = require('../controllers/cuentaController');
const PedidoController     = require('../controllers/pedidoController');
const MesaController       = require('../controllers/mesaController');
const MesaSeccionController = require('../controllers/mesaSeccionController');
const InventarioController = require('../controllers/inventarioController');
const ReporteController    = require('../controllers/reporteController');
const ConfiguracionController = require('../controllers/configuracionController');
const BarrioController = require('../controllers/barrioController');
const CajaController       = require('../controllers/cajaController');
const PuntoCajaController  = require('../controllers/puntoCajaController');
const MetodoPagoController = require('../controllers/metodoPagoController');
const CartaDisenoController = require('../controllers/cartaDisenoController');
const HorarioController    = require('../controllers/horarioController');
const ProveedorController  = require('../controllers/proveedorController');
const { verificarToken }   = require('../../app_core/middleware/auth');
const Respuesta            = require('../../app_core/helpers/respuesta');
const { paisesParaSeleccion } = require('../../app_core/helpers/paises');

// ───────── Multer: imágenes de la carta (productos y categorías) ─────────
// Se guardan en admin_ws/uploads/restaurante/menu/<id_negocio>/ y se sirven
// públicamente desde /uploads/restaurante/menu (ver app.js).
const MENU_IMG_BASE = path.resolve(path.join(__dirname, '..', '..', 'uploads', 'restaurante', 'menu'));
// El archivo se nombra con el ID de la entidad (no un hash) y se separa por
// tipo (producto/categoria) para que los IDs no colisionen entre sí.
const menuImgTipo = (raw) => (raw === 'categoria' ? 'categoria' : 'producto');
const menuImgStorage = multer.diskStorage({
    destination(req, _file, cb) {
        const idNegocio = String(req.params.id_negocio || 'misc').replace(/[^\d]/g, '') || 'misc';
        const tipo = menuImgTipo(req.params.tipo);
        const dir = path.join(MENU_IMG_BASE, idNegocio, tipo);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename(req, file, cb) {
        const idEntidad = String(req.params.id_entidad || '').replace(/[^\d]/g, '') || 'tmp';
        const ext = file.mimetype === 'image/png' ? '.png'
            : file.mimetype === 'image/jpeg' ? '.jpg'
            : '.webp';
        cb(null, `${idEntidad}${ext}`);
    },
});
const menuImgFilter = (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(Object.assign(new Error('Solo se permiten imágenes JPG, PNG o WEBP'), { statusCode: 400 }));
};
const uploadMenuImg = multer({
    storage: menuImgStorage,
    fileFilter: menuImgFilter,
    limits: { fileSize: 5 * 1024 * 1024 },  // 5 MB
});

// ───────── Multer: factura adjunta de una compra a proveedor ─────────
// Se guardan en admin_ws/uploads/restaurante/compras/<id_negocio>/ y, a diferencia de las
// imágenes de la carta, **NO se sirven estáticamente**: una factura lleva precios de compra y
// datos fiscales. Se leen por `GET /proveedores/compras/:id/adjunto`, con token y negocio.
const COMPRA_ADJ_BASE = path.resolve(path.join(__dirname, '..', '..', 'uploads', 'restaurante', 'compras'));
const compraAdjStorage = multer.diskStorage({
    destination(req, _file, cb) {
        const idNegocio = String(req.body.id_negocio || '').replace(/[^\d]/g, '') || 'misc';
        const dir = path.join(COMPRA_ADJ_BASE, idNegocio);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename(req, file, cb) {
        // El nombre lo pone el servidor, nunca el cliente: un nombre de archivo que llega de
        // fuera es por donde se cuela un `../` o un `.js`.
        const idCompra = String(req.params.idCompra || '').replace(/[^\d]/g, '') || 'tmp';
        const ext = file.mimetype === 'application/pdf' ? '.pdf'
            : file.mimetype === 'image/png' ? '.png'
            : file.mimetype === 'image/webp' ? '.webp'
            : '.jpg';
        cb(null, `${idCompra}-${Date.now()}${ext}`);
    },
});
const uploadAdjuntoCompra = multer({
    storage: compraAdjStorage,
    fileFilter(_req, file, cb) {
        if (['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype)) cb(null, true);
        else cb(Object.assign(new Error('Solo se permiten imágenes JPG/PNG/WEBP o PDF'), { statusCode: 400 }));
    },
    limits: { fileSize: 8 * 1024 * 1024 },  // 8 MB: una foto de factura cabe de sobra
});

// ============================================================
// RUTAS PÚBLICAS (no requieren autenticación)
// ============================================================

// Verificar token recibido desde el admin_app (validación de sesión)
router.post('/auth/verificar-token', DashboardController.verificarTokenAcceso);

// Países con indicativo telefónico. Mismo catálogo y misma respuesta que `GET /admin/paises`:
// la lista vive en `helpers/paises.js` junto con la regla de cuántos dígitos tiene un número en
// cada país, y copiarla al frontend la dejaría vieja el día que se añada uno. Público porque es
// catálogo de plataforma, sin datos de nadie — igual que en la consola.
router.get('/paises', (_req, res) => Respuesta.success(res, 'Países', paisesParaSeleccion()));

// Code-exchange para login cross-origin (admin_app → restaurante_app).
router.post('/auth/generar-codigo',
    [body('token').notEmpty().withMessage('Token requerido')],
    DashboardController.generarCodigoAcceso,
);
router.post('/auth/canjear-codigo',
    [body('code').notEmpty().withMessage('Código requerido')],
    DashboardController.canjearCodigo,
);

// --- Carta / Menú público ---
router.get('/public/negocios/:id', [param('id').isInt({ min: 1 })], PublicoController.getNegocio);
router.get('/public/negocios/:id/paleta', [param('id').isInt({ min: 1 })], PublicoController.getPaleta);
router.get('/public/negocios/:id/barrios', [param('id').isInt({ min: 1 })], PublicoController.getBarrios);
router.get('/public/negocios/:id/mesas', [param('id').isInt({ min: 1 })], PublicoController.getMesas);
router.get('/public/carta/categorias', PublicoController.getCategorias);
router.get('/public/carta/productos', PublicoController.getProductos);
router.get('/public/carta/completa', PublicoController.getCartaCompleta);

// ============================================================
// RUTAS PROTEGIDAS (requieren token JWT)
// ============================================================
router.use(verificarToken);

// Autorizacion multi-inquilino (ADR-002, ADR-010): verifica que el usuario del token
// pertenece al id_negocio que pide. Arranca en modo observacion (audita, no bloquea).
const { exigirPertenenciaNegocio } = require('../../app_core/middleware/authzNegocio');
router.use(exigirPertenenciaNegocio);

// --- Avisos en vivo (SSE) ---
// Conexión larga: el navegador la deja abierta y el servidor le avisa cuando otro compañero
// del mismo negocio cambia algo. Va antes que el resto por claridad, no por precedencia.
router.get('/eventos', EventosController.suscribirEventos);

// --- Clientes: cuentas, tiqueteras y fiado ---
//
// `id_negocio` es obligatorio en todas y no opcional: estas rutas devuelven saldos de personas,
// y una consulta sin negocio no tiene un valor por defecto razonable que no sea adivinar.
router.get('/clientes', [
	query('id_negocio').isInt({ min: 1 }),
	query('busqueda').optional({ nullable: true }).isString().isLength({ max: 120 }),
	query('filtro').optional().isIn(['todos', 'deben', 'a_favor']),
	query('limite').optional().isInt({ min: 1, max: 500 }),
	query('offset').optional().isInt({ min: 0 }),
], CuentaController.listar);

// Directorio: todos los clientes (los que llegan pidiendo por la carta y los de tiquetera).
// Va ANTES de `/clientes/:id`, o «directorio» se leería como un id.
router.get('/clientes/directorio', [
	query('id_negocio').isInt({ min: 1 }),
	query('limite').optional().isInt({ min: 1, max: 500 }),
	query('offset').optional().isInt({ min: 0 }),
], CuentaController.directorio);

router.get('/clientes/:id', [
	param('id').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], CuentaController.detalle);

router.get('/clientes/:id/movimientos', [
	param('id').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
	query('limite').optional().isInt({ min: 1, max: 500 }),
	query('offset').optional().isInt({ min: 0 }),
], CuentaController.movimientos);

router.get('/clientes/:id/cobertura', [
	param('id').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
	query('id_orden').optional().isInt({ min: 1 }),
	query('total').optional().isFloat({ min: 0 }),
], CuentaController.cobertura);

router.post('/clientes', [
	body('id_negocio').isInt({ min: 1 }),
	body('nombre').isString().trim().isLength({ min: 2, max: 160 }),
	body('telefono').optional({ nullable: true }).isString().isLength({ max: 40 }),
	body('modo').optional().isIn(['DINERO', 'TIQUETES']),
	body('cupo').optional().isFloat({ min: 0 }),
	body('nota').optional({ nullable: true }).isString().isLength({ max: 1000 }),
], CuentaController.crear);

router.put('/clientes/:id', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('modo').optional().isIn(['DINERO', 'TIQUETES']),
	body('cupo').optional().isFloat({ min: 0 }),
	body('estado').optional().isIn(['A', 'I']),
	body('nota').optional({ nullable: true }).isString().isLength({ max: 1000 }),
], CuentaController.actualizar);

// Entra plata: exige el subnivel `clientes_abonar` (se verifica en el controlador).
// `monto` es opcional porque en una tiquetera por producto lo calcula el servidor con el precio
// de la carta; en una cuenta en dinero el servicio lo sigue exigiendo.
router.post('/clientes/:id/abonos', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('id_metodo_pago').isInt({ min: 1 }),
	body('monto').optional({ nullable: true }).isFloat({ min: 0 }),
	body('tiquetes').optional().isInt({ min: 0 }),
	body('id_producto').optional({ nullable: true }).isInt({ min: 1 }),
	body('descuento').optional({ nullable: true }).isFloat({ min: 0 }),
	body('id_punto_caja').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
	body('concepto').optional({ nullable: true }).isString().isLength({ max: 255 }),
], CuentaController.abonar);

// Quita la cuenta de la vista y del cobro, sin borrar su libro. Exige `clientes_eliminar`,
// que nace denegado para todos (se verifica en el controlador).
router.delete('/clientes/:id', [
	param('id').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], CuentaController.eliminar);

// NO entra plata: exige el subnivel `clientes_ajustar`, que el cajero no tiene.
router.post('/clientes/:id/ajustes', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('tipo').isIn(['ABONO', 'CARGO']),
	body('monto').optional().isFloat({ min: 0 }),
	body('tiquetes').optional().isInt({ min: 0 }),
	body('id_producto').optional({ nullable: true }).isInt({ min: 1 }),
	body('concepto').isString().trim().isLength({ min: 3, max: 255 }),
], CuentaController.ajustar);

// --- Dashboard ---
router.get('/dashboard/resumen', DashboardController.getResumenDashboard);

// --- Perfil del usuario en contexto del restaurante ---
router.get('/perfil', DashboardController.getPerfilRestaurante);

// --- Configuracion del negocio ---
router.get('/configuracion', [
	query('id_negocio').optional().isInt({ min: 1 }),
], ConfiguracionController.getConfiguracion);

router.patch('/configuracion', [
	body('id_negocio').optional({ nullable: true }).isInt({ min: 1 }),
	body('nombre').optional().isString().isLength({ min: 2, max: 255 }),
	body('nit').optional({ nullable: true }).isString().isLength({ max: 50 }),
	body('email_contacto').optional({ nullable: true }).isEmail(),
	body('telefono').optional({ nullable: true }).isString().isLength({ max: 50 }),
	body('direccion').optional({ nullable: true }).isString().isLength({ max: 255 }),
	body('url_whatsapp').optional({ nullable: true }).isURL({ require_protocol: true }),
	body('url_facebook').optional({ nullable: true }).isURL({ require_protocol: true }),
	body('url_instagram').optional({ nullable: true }).isURL({ require_protocol: true }),
	body('permite_multipago').optional().isBoolean(),
	body('permite_pago_domicilio').optional().isBoolean(),
	// null/vacío es una respuesta válida: «el egreso del domicilio sale de la forma de pago
	// del pedido», que es el comportamiento anterior a esta opción.
	body('id_metodo_pago_domicilio').optional({ nullable: true }).custom((v) => v === null || v === '' || Number.isInteger(Number(v))),
	body('permite_descuento').optional().isBoolean(),
	body('pregunta_cobro_envio').optional().isBoolean(),
	body('permite_cuentas_cliente').optional().isBoolean(),
	body('controla_inventario').optional().isBoolean(),
	body('muestra_iconos_productos').optional().isBoolean(),
	body('id_paleta').optional({ nullable: true }).isInt({ min: 1 }),
], ConfiguracionController.updateConfiguracion);

router.get('/paletas', ConfiguracionController.getPaletas);
router.get('/negocios/:id/paleta', [
	param('id').isInt({ min: 1 }),
], ConfiguracionController.getPaletaNegocio);

router.patch('/negocios/:id/paleta', [
	param('id').isInt({ min: 1 }),
	body('id_paleta').isInt({ min: 1 }),
], ConfiguracionController.assignPaletaNegocio);

// --- Diseño de la carta virtual (Configuración → Apariencia) ---
// El logo va a memoria y no a disco: `imagenService` fija el nombre a partir del id del
// negocio y para eso necesita el buffer. Es el mismo archivo y la misma columna que usa la
// agenda, así que el negocio tiene un solo logo en toda la plataforma. El recorte llega del
// navegador ya en WebP; 3 MB solo cubre un PNG sin comprimir.
const uploadLogoCarta = multer({
	storage: multer.memoryStorage(),
	fileFilter(_req, file, cb) {
		if (['image/webp', 'image/jpeg', 'image/png'].includes(file.mimetype)) cb(null, true);
		else cb(Object.assign(new Error('Formato no admitido. Usa WEBP, JPG o PNG.'), { statusCode: 400 }));
	},
	limits: { fileSize: 3 * 1024 * 1024 },
});

router.get('/carta/diseno', [
	query('id_negocio').isInt({ min: 1 }),
], CartaDisenoController.getDiseno);

router.put('/carta/diseno', [
	body('id_negocio').isInt({ min: 1 }),
	body('plantilla').isString().isLength({ min: 1, max: 40 }),
	body('formato').isString().isLength({ min: 1, max: 20 }),
	body('marca').optional({ nullable: true }).isObject(),
	body('opciones').optional({ nullable: true }).isObject(),
], CartaDisenoController.publicar);

// El `id_negocio` viaja en el cuerpo multipart: multer va antes del validador.
router.post('/carta/diseno/logo',
	uploadLogoCarta.single('imagen'),
	[body('id_negocio').isInt({ min: 1 })],
	CartaDisenoController.subirLogo,
);

router.delete('/carta/diseno/logo', [
	query('id_negocio').isInt({ min: 1 }),
], CartaDisenoController.eliminarLogo);

// --- Carta / Menú (lectura pública para POS) ---
router.get('/carta/categorias', CartaController.getCategorias);
router.get('/carta/productos',  CartaController.getProductos);
router.get('/carta/buscar',     CartaController.buscarProductos);

// --- Carta / Menú (ingredientes base) ---
router.get('/carta/ingredientes', CartaAdminController.getIngredientes);

// --- Carta / Menú — Administración CRUD ---
router.get('/carta/admin/categorias',          CartaAdminController.getCategoriasAdmin);
router.post('/carta/admin/categorias',         CartaAdminController.crearCategoria);
router.put('/carta/admin/categorias/:id',      CartaAdminController.editarCategoria);
router.delete('/carta/admin/categorias/:id',   CartaAdminController.eliminarCategoria);

router.get('/carta/admin/productos',           CartaAdminController.getProductosAdmin);
router.post('/carta/admin/productos',          CartaAdminController.crearProducto);
router.put('/carta/admin/productos/:id',       CartaAdminController.editarProducto);
router.delete('/carta/admin/productos/:id',    CartaAdminController.eliminarProducto);

// Subida de imágenes de carta (opcional; conviven con los íconos).
// El archivo se nombra con el ID de la entidad: <id>.webp
router.post('/carta/admin/:id_negocio/imagen/:tipo/:id_entidad',
    [
        param('id_negocio').isInt({ min: 1 }),
        param('tipo').isIn(['producto', 'categoria']),
        param('id_entidad').isInt({ min: 1 }),
    ],
    uploadMenuImg.single('imagen'),
    CartaAdminController.subirImagenCarta,
);

router.post('/carta/admin/ingredientes',       CartaAdminController.crearIngrediente);
router.put('/carta/admin/ingredientes/:id', [
    param('id').isInt({ min: 1 }),
    body('nombre').optional().isString().isLength({ min: 2, max: 100 }),
    body('unidad_medida').optional().isString().isLength({ max: 20 }),
], CartaAdminController.editarIngrediente);
router.delete('/carta/admin/ingredientes/:id', [
    param('id').isInt({ min: 1 }),
], CartaAdminController.eliminarIngrediente);

// --- Mesas ---
router.get('/mesas', MesaController.getMesas);
router.get('/mesas/dashboard', MesaController.getMesasDashboard);
// --- Secciones del salon («Piso 1», «Terraza»…) ---
// Van ANTES de `/mesas/:id`: `secciones` no es un id, y el orden de declaracion decide.
router.get('/mesas/secciones', [
	query('id_negocio').isInt({ min: 1 }),
], MesaSeccionController.listar);
router.post('/mesas/secciones', [
	body('id_negocio').isInt({ min: 1 }),
	body('nombre').isString().isLength({ min: 1, max: 120 }),
], MesaSeccionController.crear);
router.put('/mesas/secciones/orden', [
	body('id_negocio').isInt({ min: 1 }),
	body('ids').isArray(),
], MesaSeccionController.reordenar);
router.put('/mesas/secciones/:id', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('nombre').isString().isLength({ min: 1, max: 120 }),
], MesaSeccionController.renombrar);
router.put('/mesas/secciones/:id/mesas', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('ids_mesas').isArray(),
], MesaSeccionController.asignarMesas);
router.delete('/mesas/secciones/:id', [
	param('id').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], MesaSeccionController.eliminar);

router.post('/mesas', [
	body('id_negocio').isInt({ min: 1 }),
	body('nombre').isString().isLength({ min: 2, max: 100 }),
	body('numero').optional().isInt({ min: 1 }),
	body('capacidad').optional().isInt({ min: 1, max: 20 }),
	body('id_seccion').optional({ nullable: true }).isInt({ min: 1 }),
], MesaController.crearMesa);
router.put('/mesas/:id', [
	param('id').isInt({ min: 1 }),
	body('nombre').optional().isString().isLength({ min: 2, max: 100 }),
	body('numero').optional().isInt({ min: 1 }),
	body('capacidad').optional().isInt({ min: 1, max: 20 }),
	body('id_seccion').optional({ nullable: true }).isInt({ min: 1 }),
], MesaController.editarMesa);
router.patch('/mesas/:id/estado', [
	param('id').isInt({ min: 1 }),
	body('estado').isIn(['A', 'I']),
], MesaController.cambiarEstado);
router.patch('/mesas/:id/estado-servicio', [
	param('id').isInt({ min: 1 }),
	body('estado_servicio').isIn(['DISPONIBLE', 'OCUPADA', 'POR_COBRAR']),
], MesaController.cambiarEstadoServicio);
router.patch('/mesas/:id/liberar', [
	param('id').isInt({ min: 1 }),
], MesaController.liberarMesa);
router.delete('/mesas/:id', [
	param('id').isInt({ min: 1 }),
], MesaController.eliminarMesa);

// --- Pedidos (POS) ---
router.post('/pedidos',                                   PedidoController.crearOrdenValidators, PedidoController.crearOrden);
router.get('/pedidos/abiertas',                           PedidoController.getOrdenesAbiertas);
router.patch('/pedidos/:id/agregar-items', [
	param('id').isInt({ min: 1 }),
	...PedidoController.agregarItemsOrdenValidators,
], PedidoController.agregarItemsOrden);
router.patch('/pedidos/:id/quitar-items', [
	param('id').isInt({ min: 1 }),
	...PedidoController.quitarItemsOrdenValidators,
], PedidoController.quitarItemsOrden);
router.patch('/pedidos/detalle/:id/completar',            PedidoController.marcarDetalleCompleto);
router.get('/pedidos/:id',                                PedidoController.getOrdenById);
router.patch('/pedidos/:id/enviar-cocina',                PedidoController.enviarACocina);
router.patch('/pedidos/:id/estado-cocina',                PedidoController.cambiarEstadoCocina);
router.patch('/pedidos/:id/marcar-pagado', [
	param('id').isInt({ min: 1 }),
	...PedidoController.marcarPagadoValidators,
], PedidoController.marcarPagado);
router.patch('/pedidos/:id/valor-domicilio', [
	param('id').isInt({ min: 1 }),
	...PedidoController.actualizarValorDomicilioValidators,
], PedidoController.actualizarValorDomicilio);
router.patch('/pedidos/:id/descuento', [
	param('id').isInt({ min: 1 }),
	...PedidoController.actualizarDescuentoValidators,
], PedidoController.actualizarDescuento);
router.patch('/pedidos/:id/domiciliario', [
	param('id').isInt({ min: 1 }),
	...PedidoController.asignarDomiciliarioValidators,
], PedidoController.asignarDomiciliario);
router.patch('/pedidos/:id/cancelar',                     PedidoController.cancelarOrden);
router.patch('/pedidos/:id/cerrar', [
	param('id').isInt({ min: 1 }),
	...PedidoController.cerrarOrdenValidators,
], PedidoController.cerrarOrden);

// --- Cocina (Kitchen Display) ---
router.get('/cocina', PedidoController.getOrdenesCocina);

// --- Despacho ---
router.get('/despacho', [
	query('id_negocio').isInt({ min: 1 }),
], PedidoController.getOrdenesDespacho);
router.get('/despacho/cancelados', [
	query('id_negocio').isInt({ min: 1 }),
], PedidoController.getOrdenesCanceladasRecientes);
router.post('/despacho/:id/avisar-listo', [
	param('id').isInt({ min: 1 }),
	...PedidoController.avisarPedidoListoValidators,
], PedidoController.avisarPedidoListo);
router.post('/despacho/:id/confirmar', [
	param('id').isInt({ min: 1 }),
	...PedidoController.confirmarPedidoAsistenteValidators,
], PedidoController.confirmarPedidoAsistente);
router.get('/domiciliarios', [
	query('id_negocio').isInt({ min: 1 }),
], PedidoController.getDomiciliarios);

// --- Barrios con precio de domicilio (Configuración; escribe solo el administrador) ---
router.get('/barrios-domicilio', [query('id_negocio').optional().isInt({ min: 1 })], BarrioController.listar);
router.post('/barrios-domicilio', [
	body('id_negocio').optional({ nullable: true }).isInt({ min: 1 }),
	body('nombre').isString().trim().isLength({ min: 2, max: 100 }),
	body('valor').isFloat({ min: 0, max: 1000000 }),
], BarrioController.crear);
router.put('/barrios-domicilio/:id', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').optional({ nullable: true }).isInt({ min: 1 }),
	body('nombre').optional().isString().trim().isLength({ min: 2, max: 100 }),
	body('valor').optional().isFloat({ min: 0, max: 1000000 }),
], BarrioController.editar);
router.delete('/barrios-domicilio/:id', [
	param('id').isInt({ min: 1 }),
	query('id_negocio').optional().isInt({ min: 1 }),
], BarrioController.eliminar);

// --- Horarios (del negocio y de sus domiciliarios) ---
router.get('/horarios', [query('id_negocio').isInt({ min: 1 })], HorarioController.listar);
router.put('/horarios', [
	body('id_negocio').isInt({ min: 1 }),
	body('id_usuario').optional({ nullable: true }).isInt({ min: 1 }),
	body('bloques').isArray(),
	body('bloques.*.dia_semana').isInt({ min: 0, max: 6 }),
	body('bloques.*.hora_inicio').matches(/^\d{2}:\d{2}(:\d{2})?$/),
	body('bloques.*.hora_fin').matches(/^\d{2}:\d{2}(:\d{2})?$/),
], HorarioController.reemplazar);

// --- Inventario ---
router.get('/inventario/resumen', InventarioController.getResumenInventario);
router.patch('/inventario/ingredientes/:id/ajuste', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').optional().isInt({ min: 1 }),
	body('delta').optional().isNumeric(),
	body('stock_actual').optional().isNumeric(),
], InventarioController.ajustarStockIngrediente);
// Deja el stock de un insumo en 0 como un ajuste con historia (auditoría con usuario y motivo).
router.post('/inventario/ingredientes/:id/restablecer', [
	param('id').isInt({ min: 1 }).withMessage('Insumo inválido'),
	body('id_negocio').isInt({ min: 1 }).withMessage('id_negocio inválido'),
], InventarioController.restablecerStockACero);

// --- Proveedores de insumos ---
//
// OJO CON EL ORDEN: `/proveedores/categorias`, `/proveedores/comparador`, `/proveedores/compras`
// e `/proveedores/insumos/...` van ANTES que `/proveedores/:id`, o Express leería «categorias»
// como un id y devolvería 400 en todas.
router.get('/proveedores/categorias', ProveedorController.categorias);

router.get('/proveedores/comparador', [
	query('id_negocio').isInt({ min: 1 }),
	query('busqueda').optional({ nullable: true }).isString().isLength({ max: 120 }),
	query('id_ingrediente').optional({ nullable: true }).isInt({ min: 1 }),
], ProveedorController.comparar);

// Compras — el resumen y la evolución van antes que `/compras/:idCompra`.
router.get('/proveedores/compras/resumen', [
	query('id_negocio').isInt({ min: 1 }),
	query('desde').optional({ nullable: true }).isISO8601(),
	query('hasta').optional({ nullable: true }).isISO8601(),
], ProveedorController.resumenCompras);

router.get('/proveedores/compras/evolucion-precio', [
	query('id_negocio').isInt({ min: 1 }),
	query('id_proveedor_insumo').optional({ nullable: true }).isInt({ min: 1 }),
	query('id_ingrediente').optional({ nullable: true }).isInt({ min: 1 }),
], ProveedorController.evolucionPrecio);

router.get('/proveedores/compras', [
	query('id_negocio').isInt({ min: 1 }),
	query('id_proveedor').optional({ nullable: true }).isInt({ min: 1 }),
	query('id_ingrediente').optional({ nullable: true }).isInt({ min: 1 }),
	query('busqueda').optional({ nullable: true }).isString().isLength({ max: 120 }),
	query('desde').optional({ nullable: true }).isISO8601(),
	query('hasta').optional({ nullable: true }).isISO8601(),
	query('limite').optional().isInt({ min: 1, max: 200 }),
	query('offset').optional().isInt({ min: 0 }),
], ProveedorController.listarCompras);

router.post('/proveedores/compras', [
	body('id_negocio').isInt({ min: 1 }),
	body('id_proveedor').isInt({ min: 1 }),
	body('fecha').optional({ nullable: true }).isISO8601(),
	body('referencia').optional({ nullable: true }).isString().isLength({ max: 60 }),
	body('descuento').optional({ nullable: true }).isFloat({ min: 0 }),
	body('impuesto').optional({ nullable: true }).isFloat({ min: 0 }),
	body('id_metodo_pago').optional({ nullable: true }).isInt({ min: 1 }),
	body('observaciones').optional({ nullable: true }).isString().isLength({ max: 2000 }),
	body('afecta_inventario').optional().isBoolean(),
	body('detalles').isArray({ min: 1, max: 100 }),
	body('detalles.*.cantidad').isFloat({ gt: 0 }),
	body('detalles.*.precio_unitario').optional({ nullable: true }).isFloat({ min: 0 }),
	body('detalles.*.descuento').optional({ nullable: true }).isFloat({ min: 0 }),
	body('detalles.*.descripcion').optional({ nullable: true }).isString().isLength({ max: 160 }),
	body('detalles.*.id_proveedor_insumo').optional({ nullable: true }).isInt({ min: 1 }),
	body('detalles.*.id_ingrediente').optional({ nullable: true }).isInt({ min: 1 }),
], ProveedorController.crearCompra);

router.get('/proveedores/compras/:idCompra', [
	param('idCompra').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], ProveedorController.detalleCompra);

router.patch('/proveedores/compras/:idCompra/anular', [
	param('idCompra').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('motivo').optional({ nullable: true }).isString().isLength({ max: 200 }),
], ProveedorController.anularCompra);

// La factura escaneada. NO se sirve desde `/uploads` (lleva precios y datos fiscales): se
// sube aquí y se lee por `GET .../adjunto`, que vuelve a comprobar el negocio.
router.post('/proveedores/compras/:idCompra/adjunto',
	[param('idCompra').isInt({ min: 1 })],
	uploadAdjuntoCompra.single('archivo'),
	ProveedorController.subirAdjunto,
);
router.get('/proveedores/compras/:idCompra/adjunto', [
	param('idCompra').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], ProveedorController.descargarAdjunto);

// Insumos — `/proveedores/insumos/:idInsumo` es la ficha suelta; crear va bajo su proveedor.
router.get('/proveedores/insumos/:idInsumo/precios', [
	param('idInsumo').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], ProveedorController.historicoPrecios);

router.put('/proveedores/insumos/:idInsumo', [
	param('idInsumo').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('nombre').isString().trim().isLength({ min: 2, max: 160 }),
	body('unidad').optional().isString().isLength({ max: 10 }),
	body('precio').optional({ nullable: true }).isFloat({ min: 0 }),
	body('cantidad_presentacion').optional({ nullable: true }).isFloat({ gt: 0 }),
	body('id_ingrediente').optional({ nullable: true }).isInt({ min: 1 }),
	body('publico').optional().isBoolean(),
	body('disponible').optional().isBoolean(),
], ProveedorController.editarInsumo);

router.delete('/proveedores/insumos/:idInsumo', [
	param('idInsumo').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], ProveedorController.eliminarInsumo);

// Listado y alta de proveedores
router.get('/proveedores', [
	query('id_negocio').isInt({ min: 1 }),
	query('ambito').optional().isIn(['mios', 'directorio', 'todos']),
	query('busqueda').optional({ nullable: true }).isString().isLength({ max: 120 }),
	query('categoria').optional({ nullable: true }).isString().isLength({ max: 40 }),
	query('ciudad').optional({ nullable: true }).isString().isLength({ max: 100 }),
	query('orden').optional().isIn(['nombre', 'reciente', 'precio', 'uso', 'actualizacion']),
	query('archivados').optional().isBoolean(),
	query('limite').optional().isInt({ min: 1, max: 200 }),
	query('offset').optional().isInt({ min: 0 }),
], ProveedorController.listar);

router.post('/proveedores', [
	body('id_negocio').isInt({ min: 1 }),
	body('nombre_comercial').isString().trim().isLength({ min: 2, max: 160 }),
	body('email').optional({ nullable: true, checkFalsy: true }).isEmail().isLength({ max: 160 }),
	body('visibilidad').optional().isIn(['PRIVADO', 'DIRECTORIO_BASICO', 'DIRECTORIO_SIN_PRECIOS', 'DIRECTORIO']),
	body('tipo_atencion').optional().isIn(['ENTREGA', 'RECOGIDA', 'AMBOS']),
	body('pedido_minimo').optional({ nullable: true }).isFloat({ min: 0 }),
	body('tiempo_entrega_hrs').optional({ nullable: true }).isInt({ min: 0, max: 8760 }),
	body('categorias').optional().isArray({ max: 15 }),
	body('zonas_cobertura').optional().isArray({ max: 30 }),
	body('dias_entrega').optional().isArray({ max: 7 }),
], ProveedorController.crear);

router.get('/proveedores/:id', [
	param('id').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], ProveedorController.detalle);

router.put('/proveedores/:id', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('nombre_comercial').isString().trim().isLength({ min: 2, max: 160 }),
	body('email').optional({ nullable: true, checkFalsy: true }).isEmail().isLength({ max: 160 }),
	body('tipo_atencion').optional().isIn(['ENTREGA', 'RECOGIDA', 'AMBOS']),
	body('pedido_minimo').optional({ nullable: true }).isFloat({ min: 0 }),
	body('tiempo_entrega_hrs').optional({ nullable: true }).isInt({ min: 0, max: 8760 }),
	body('categorias').optional().isArray({ max: 15 }),
	body('zonas_cobertura').optional().isArray({ max: 30 }),
	body('dias_entrega').optional().isArray({ max: 7 }),
], ProveedorController.editar);

router.patch('/proveedores/:id/visibilidad', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('visibilidad').isIn(['PRIVADO', 'DIRECTORIO_BASICO', 'DIRECTORIO_SIN_PRECIOS', 'DIRECTORIO']),
], ProveedorController.cambiarVisibilidad);

router.patch('/proveedores/:id/archivar', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('archivado').optional().isBoolean(),
], ProveedorController.archivar);

router.post('/proveedores/:id/vincular', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
], ProveedorController.vincular);

router.put('/proveedores/:id/privado', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('notas').optional({ nullable: true }).isString().isLength({ max: 4000 }),
	body('condiciones').optional({ nullable: true }).isString().isLength({ max: 4000 }),
	body('calificacion').optional({ nullable: true }).isInt({ min: 1, max: 5 }),
], ProveedorController.guardarPrivado);

router.post('/proveedores/:id/reportar', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('motivo').isString().trim().isLength({ min: 5, max: 500 }),
], ProveedorController.reportar);

router.get('/proveedores/:id/insumos', [
	param('id').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], ProveedorController.listarInsumos);

router.post('/proveedores/:id/insumos', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('nombre').isString().trim().isLength({ min: 2, max: 160 }),
	body('unidad').optional().isString().isLength({ max: 10 }),
	body('precio').optional({ nullable: true }).isFloat({ min: 0 }),
	body('cantidad_presentacion').optional({ nullable: true }).isFloat({ gt: 0 }),
	body('id_ingrediente').optional({ nullable: true }).isInt({ min: 1 }),
	body('publico').optional().isBoolean(),
	body('disponible').optional().isBoolean(),
], ProveedorController.crearInsumo);

// --- Reportes ---
router.get('/reportes', [
	query('tipo').optional().isIn(['ventas_periodo', 'productos_mas_vendidos', 'rendimiento_mesas', 'rendimiento_usuarios', 'estado_cocina']),
	query('id_negocio').optional().isInt({ min: 1 }),
	query('fecha_desde').optional().isISO8601(),
	query('fecha_hasta').optional().isISO8601(),
	query('page').optional().isInt({ min: 1 }),
	query('page_size').optional().isInt({ min: 1, max: 100 }),
], ReporteController.getReportes);

router.get('/reportes/ventas/:id_orden/detalle', [
	param('id_orden').isInt({ min: 1 }),
	query('id_negocio').optional().isInt({ min: 1 }),
], ReporteController.getDetalleVentaPeriodo);

router.get('/reportes/exportar', [
	query('tipo').optional().isIn(['ventas_periodo', 'productos_mas_vendidos', 'rendimiento_mesas', 'rendimiento_usuarios', 'estado_cocina']),
	query('id_negocio').optional().isInt({ min: 1 }),
	query('fecha_desde').optional().isISO8601(),
	query('fecha_hasta').optional().isISO8601(),
	query('formato').optional().isIn(['xlsx', 'pdf']),
], ReporteController.exportarReporte);

// --- Cajas del negocio (rubros de ingreso) ---
//
// '/cajas' (plural) son las cajas; '/caja' (singular) son los turnos de una de ellas.
router.get('/cajas', [
	query('id_negocio').isInt({ min: 1 }),
], PuntoCajaController.listar);

router.get('/cajas/mias', [
	query('id_negocio').isInt({ min: 1 }),
], PuntoCajaController.mias);

router.get('/cajas/asignaciones', [
	query('id_negocio').isInt({ min: 1 }),
], PuntoCajaController.asignaciones);

router.post('/cajas', [
	body('id_negocio').isInt({ min: 1 }),
	body('nombre').isString().trim().isLength({ min: 2, max: 60 }),
	body('descripcion').optional({ nullable: true }).isString().isLength({ max: 160 }),
], PuntoCajaController.crear);

router.put('/cajas/:id', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('nombre').optional().isString().trim().isLength({ min: 2, max: 60 }),
	body('descripcion').optional({ nullable: true }).isString().isLength({ max: 160 }),
	body('orden').optional().isInt({ min: 0 }),
	body('estado').optional().isIn(['A', 'I']),
], PuntoCajaController.actualizar);

router.put('/cajas/usuarios/:id_usuario', [
	param('id_usuario').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('id_puntos_caja').optional().isArray(),
	body('id_puntos_caja.*').isInt({ min: 1 }),
], PuntoCajaController.asignarUsuario);

// --- Caja ---
router.get('/caja/abierta', [
	query('id_negocio').isInt({ min: 1 }),
	query('id_punto_caja').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
], CajaController.getCajaAbierta);

router.get('/caja/domiciliarios', [
	query('id_negocio').isInt({ min: 1 }),
	query('id_punto_caja').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
], CajaController.getResumenDomiciliarios);

// Va antes de '/caja/:id/...' por claridad; 'historial' nunca choca con :id
// porque son rutas de distinta profundidad.
router.get('/caja/historial', [
	query('id_negocio').isInt({ min: 1 }),
	query('id_punto_caja').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
	query('desde').optional({ nullable: true, checkFalsy: true }).isISO8601(),
	query('hasta').optional({ nullable: true, checkFalsy: true }).isISO8601(),
	query('limite').optional().isInt({ min: 1, max: 100 }),
	query('offset').optional().isInt({ min: 0 }),
], CajaController.getHistorial);

// Sección «Movimientos»: seguimiento del flujo mesero → caja. Va antes de
// '/caja/:id/...' por la misma razón que 'historial'.
router.get('/caja/seguimiento', [
	query('id_negocio').isInt({ min: 1 }),
	query('id_punto_caja').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
	// Los pedidos de UN turno; manda sobre `desde`/`hasta`.
	query('id_caja').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
	query('desde').optional({ nullable: true, checkFalsy: true }).isISO8601(),
	query('hasta').optional({ nullable: true, checkFalsy: true }).isISO8601(),
	query('estado').optional({ nullable: true, checkFalsy: true }).isIn(['ABIERTA', 'CERRADA', 'CANCELADA', 'ANULADA']),
	query('q').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 60 }),
	query('limite').optional().isInt({ min: 1, max: 100 }),
	query('offset').optional().isInt({ min: 0 }),
], CajaController.getSeguimiento);

router.get('/caja/:id/detalle', [
	param('id').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], CajaController.getDetalleCaja);

router.get('/caja/:id/exportar', [
	param('id').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], CajaController.exportarCaja);

router.post('/caja/abrir', [
	body('id_negocio').isInt({ min: 1 }),
	body('id_punto_caja').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
	body('monto_apertura').optional().isFloat({ min: 0 }),
	body('observaciones').optional({ nullable: true }).isString(),
], CajaController.abrirCaja);

router.put('/caja/:id/cerrar', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('monto_reportado').optional({ nullable: true }).isFloat({ min: 0 }),
	body('observaciones').optional({ nullable: true }).isString(),
], CajaController.cerrarCaja);

router.get('/caja/:id/movimientos', [
	param('id').isInt({ min: 1 }),
], CajaController.getMovimientos);

// Los productos del pedido de una fila de caja (acordeón del listado de movimientos).
router.get('/caja/ordenes/:id/items', [
	param('id').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], CajaController.getItemsOrden);

router.post('/caja/movimientos', [
	body('id_caja').isInt({ min: 1 }),
	body('tipo').isIn(['INGRESO', 'EGRESO']),
	body('monto').isFloat({ gt: 0 }),
	body('concepto').optional({ nullable: true }).isString().isLength({ max: 255 }),
	// Con qué entra o sale la plata: suma o resta al desglose de esa forma de pago.
	// Opcional para no romper a quien ya llamaba sin ella; sin forma de pago el
	// movimiento cae en «Manual / Sin orden».
	body('id_metodo_pago').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
], CajaController.registrarMovimiento);

router.post('/caja/movimientos/:id/anular', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
], CajaController.anularMovimiento);

router.post('/caja/ordenes/:id/anular', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
], CajaController.anularPedido);

router.post('/caja/domiciliarios/transferir', [
	body('id_negocio').isInt({ min: 1 }),
	body('id_domiciliario').isInt({ min: 1 }),
	body('id_punto_caja').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
], CajaController.transferirDomiciliario);

// --- Métodos de pago ---
router.get('/metodos-pago', [
	query('id_negocio').isInt({ min: 1 }),
], MetodoPagoController.listar);

router.post('/metodos-pago', [
	body('id_negocio').isInt({ min: 1 }),
	body('nombre').trim().notEmpty().isLength({ min: 1, max: 80 }),
], MetodoPagoController.crear);

router.put('/metodos-pago/:id', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').isInt({ min: 1 }),
	body('nombre').trim().notEmpty().isLength({ min: 1, max: 80 }),
], MetodoPagoController.actualizar);

router.patch('/metodos-pago/:id/inactivar', [
	param('id').isInt({ min: 1 }),
	query('id_negocio').isInt({ min: 1 }),
], MetodoPagoController.inactivar);

module.exports = router;
