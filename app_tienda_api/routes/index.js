const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const Dashboard   = require('../controllers/dashboardController');
const Categorias  = require('../controllers/categoriaController');
const Productos   = require('../controllers/productoController');
const Movimientos = require('../controllers/movimientoController');
const Proveedores = require('../controllers/proveedorController');
const Ventas      = require('../controllers/ventaController');
const Clientes    = require('../controllers/clienteController');
const { verificarToken } = require('../../app_core/middleware/auth');

// ═════════ RUTAS PÚBLICAS ═════════
router.post('/auth/verificar-token', Dashboard.verificarTokenAcceso);
router.post('/auth/generar-codigo',
    [body('token').notEmpty().withMessage('Token requerido')],
    Dashboard.generarCodigoAcceso,
);
router.post('/auth/canjear-codigo',
    [body('code').notEmpty().withMessage('Código requerido')],
    Dashboard.canjearCodigo,
);

// ═════════ RUTAS PROTEGIDAS ═════════
router.use(verificarToken);

// Dashboard / perfil
router.get('/dashboard/resumen', [query('id_negocio').isInt({ min: 1 })], Dashboard.getResumen);
router.get('/perfil', Dashboard.getPerfil);

// Categorías
router.get('/categorias', [query('id_negocio').isInt({ min: 1 })], Categorias.listar);
router.get('/categorias/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Categorias.getById);
router.post('/categorias', [
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').trim().notEmpty().isLength({ max: 120 }),
    body('descripcion').optional({ nullable: true }).isString(),
    body('icono').optional({ nullable: true }).isString().isLength({ max: 20 }),
    body('orden').optional({ nullable: true }).isInt({ min: 0 }),
], Categorias.crear);
router.put('/categorias/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').optional().trim().notEmpty().isLength({ max: 120 }),
], Categorias.actualizar);
router.patch('/categorias/:id/inactivar', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Categorias.inactivar);

// Productos
router.get('/productos', [query('id_negocio').isInt({ min: 1 })], Productos.listar);
router.get('/productos/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Productos.getById);
router.post('/productos', [
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').trim().notEmpty().isLength({ max: 200 }),
    body('precio_venta').isFloat({ min: 0 }),
    body('id_categoria').optional({ nullable: true }).isInt({ min: 1 }),
    body('id_proveedor').optional({ nullable: true }).isInt({ min: 1 }),
    body('sku').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 80 }),
    body('codigo_barras').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 80 }),
    body('precio_costo').optional({ nullable: true }).isFloat({ min: 0 }),
    body('stock_actual').optional({ nullable: true }).isFloat({ min: 0 }),
    body('stock_minimo').optional({ nullable: true }).isFloat({ min: 0 }),
    body('unidad_medida').optional({ nullable: true }).isString().isLength({ max: 30 }),
    body('es_servicio').optional({ nullable: true }).isBoolean(),
    body('ubicacion').optional({ nullable: true }).isString().isLength({ max: 120 }),
], Productos.crear);
router.put('/productos/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('precio_venta').optional().isFloat({ min: 0 }),
    body('id_categoria').optional({ nullable: true }).isInt({ min: 1 }),
    body('id_proveedor').optional({ nullable: true }).isInt({ min: 1 }),
], Productos.actualizar);
router.patch('/productos/:id/inactivar', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Productos.inactivar);
router.patch('/productos/:id/stock', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('delta').isFloat(),
], Productos.ajustarStock);

// Movimientos
router.get('/movimientos', [query('id_negocio').isInt({ min: 1 })], Movimientos.listar);
router.get('/movimientos/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Movimientos.getById);
router.post('/movimientos', [
    body('id_negocio').isInt({ min: 1 }),
    body('tipo').isIn(['ENTRADA', 'SALIDA', 'AJUSTE', 'DEVOLUCION', 'TRASLADO']),
    body('referencia').optional({ nullable: true }).isString().isLength({ max: 80 }),
    body('observacion').optional({ nullable: true }).isString(),
    body('items').isArray({ min: 1 }),
    body('items.*.id_producto').isInt({ min: 1 }),
    body('items.*.cantidad').isFloat({ gt: 0 }),
    body('items.*.costo_unitario').optional({ nullable: true }).isFloat({ min: 0 }),
], Movimientos.crear);
router.patch('/movimientos/:id/confirmar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Movimientos.confirmar);
router.patch('/movimientos/:id/anular', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Movimientos.anular);

// Proveedores
router.get('/proveedores', [query('id_negocio').isInt({ min: 1 })], Proveedores.listar);
router.get('/proveedores/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Proveedores.getById);
router.post('/proveedores', [
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').trim().notEmpty().isLength({ max: 160 }),
    body('nit_rut').optional({ nullable: true }).isString().isLength({ max: 40 }),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('telefono').optional({ nullable: true }).isString().isLength({ max: 40 }),
    body('direccion').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('contacto').optional({ nullable: true }).isString().isLength({ max: 120 }),
    body('notas').optional({ nullable: true }).isString(),
], Proveedores.crear);
router.put('/proveedores/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').optional().trim().notEmpty().isLength({ max: 160 }),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
], Proveedores.actualizar);
router.patch('/proveedores/:id/inactivar', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Proveedores.inactivar);

// Ventas
router.get('/ventas', [query('id_negocio').isInt({ min: 1 })], Ventas.listar);
router.get('/ventas/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Ventas.getById);
router.post('/ventas', [
    body('id_negocio').isInt({ min: 1 }),
    body('metodo_pago').isIn(['EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'OTRO']),
    body('id_cliente').optional({ nullable: true }).isInt({ min: 1 }),
    body('descuento').optional({ nullable: true }).isFloat({ min: 0 }),
    body('notas').optional({ nullable: true }).isString(),
    body('items').isArray({ min: 1 }),
    body('items.*.id_producto').isInt({ min: 1 }),
    body('items.*.cantidad').isFloat({ gt: 0 }),
    body('items.*.precio_unitario').optional({ nullable: true }).isFloat({ min: 0 }),
    body('items.*.descuento').optional({ nullable: true }).isFloat({ min: 0 }),
], Ventas.crear);
router.patch('/ventas/:id/anular', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Ventas.anular);

// Clientes
router.get('/clientes', [query('id_negocio').isInt({ min: 1 })], Clientes.listar);
router.get('/clientes/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Clientes.getById);
router.post('/clientes', [
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').trim().notEmpty().isLength({ max: 160 }),
    body('tipo_doc').optional({ nullable: true }).isString().isLength({ max: 20 }),
    body('num_doc').optional({ nullable: true }).isString().isLength({ max: 40 }),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('telefono').optional({ nullable: true }).isString().isLength({ max: 40 }),
    body('direccion').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('notas').optional({ nullable: true }).isString(),
], Clientes.crear);
router.put('/clientes/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').optional().trim().notEmpty().isLength({ max: 160 }),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
], Clientes.actualizar);

module.exports = router;
