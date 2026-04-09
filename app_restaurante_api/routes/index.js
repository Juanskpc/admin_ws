const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();

const DashboardController  = require('../controllers/dashboardController');
const CartaController      = require('../controllers/cartaController');
const CartaAdminController = require('../controllers/cartaAdminController');
const PedidoController     = require('../controllers/pedidoController');
const MesaController       = require('../controllers/mesaController');
const InventarioController = require('../controllers/inventarioController');
const { verificarToken }   = require('../../app_core/middleware/auth');

// ============================================================
// RUTAS PÚBLICAS (no requieren autenticación)
// ============================================================

// Verificar token recibido desde el admin_app (validación de sesión)
router.post('/auth/verificar-token', DashboardController.verificarTokenAcceso);

// ============================================================
// RUTAS PROTEGIDAS (requieren token JWT)
// ============================================================
router.use(verificarToken);

// --- Dashboard ---
router.get('/dashboard/resumen', DashboardController.getResumenDashboard);

// --- Perfil del usuario en contexto del restaurante ---
router.get('/perfil', DashboardController.getPerfilRestaurante);

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

router.post('/carta/admin/ingredientes',       CartaAdminController.crearIngrediente);

// --- Mesas ---
router.get('/mesas', MesaController.getMesas);
router.get('/mesas/dashboard', MesaController.getMesasDashboard);
router.post('/mesas', [
	body('id_negocio').isInt({ min: 1 }),
	body('nombre').isString().isLength({ min: 2, max: 100 }),
	body('numero').isInt({ min: 1 }),
	body('capacidad').optional().isInt({ min: 1, max: 20 }),
], MesaController.crearMesa);
router.put('/mesas/:id', [
	param('id').isInt({ min: 1 }),
	body('nombre').optional().isString().isLength({ min: 2, max: 100 }),
	body('numero').optional().isInt({ min: 1 }),
	body('capacidad').optional().isInt({ min: 1, max: 20 }),
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

// --- Pedidos (POS) ---
router.post('/pedidos',                                   PedidoController.crearOrdenValidators, PedidoController.crearOrden);
router.get('/pedidos/abiertas',                           PedidoController.getOrdenesAbiertas);
router.patch('/pedidos/:id/agregar-items', [
	param('id').isInt({ min: 1 }),
	...PedidoController.agregarItemsOrdenValidators,
], PedidoController.agregarItemsOrden);
router.patch('/pedidos/detalle/:id/completar',            PedidoController.marcarDetalleCompleto);
router.get('/pedidos/:id',                                PedidoController.getOrdenById);
router.patch('/pedidos/:id/enviar-cocina',                PedidoController.enviarACocina);
router.patch('/pedidos/:id/estado-cocina',                PedidoController.cambiarEstadoCocina);
router.patch('/pedidos/:id/cerrar',                       PedidoController.cerrarOrden);

// --- Cocina (Kitchen Display) ---
router.get('/cocina', PedidoController.getOrdenesCocina);

// --- Inventario ---
router.get('/inventario/resumen', InventarioController.getResumenInventario);
router.patch('/inventario/ingredientes/:id/ajuste', [
	param('id').isInt({ min: 1 }),
	body('id_negocio').optional().isInt({ min: 1 }),
	body('delta').optional().isNumeric(),
	body('stock_actual').optional().isNumeric(),
], InventarioController.ajustarStockIngrediente);

module.exports = router;
