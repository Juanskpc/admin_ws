const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const Dashboard   = require('../controllers/dashboardController');
const Miembros    = require('../controllers/miembroController');
const Planes      = require('../controllers/planController');
const Membresias  = require('../controllers/membresiaController');
const Pagos       = require('../controllers/pagoController');
const Asistencias = require('../controllers/asistenciaController');
const Productos   = require('../controllers/productoController');
const Ventas      = require('../controllers/ventaController');
const Config      = require('../controllers/configuracionController');
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

// Miembros
router.get('/miembros', [query('id_negocio').isInt({ min: 1 })], Miembros.listar);
router.get('/miembros/qr/:codigo', [
    param('codigo').isString().isLength({ min: 4, max: 60 }),
    query('id_negocio').isInt({ min: 1 }),
], Miembros.getByQr);
router.get('/miembros/identificacion/:num', [
    param('num').isString().isLength({ min: 4, max: 40 }),
    query('id_negocio').isInt({ min: 1 }),
], Miembros.getByIdentificacion);
router.get('/miembros/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Miembros.getById);
router.post('/miembros', [
    body('id_negocio').isInt({ min: 1 }),
    body('primer_nombre').trim().notEmpty().isLength({ max: 80 }),
    body('primer_apellido').trim().notEmpty().isLength({ max: 80 }),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('telefono').optional({ nullable: true }).isString().isLength({ max: 40 }),
    body('fecha_nacimiento').optional({ nullable: true }).isISO8601(),
    body('sexo').optional({ nullable: true }).isIn(['M','F','O']),
    body('peso_kg').optional({ nullable: true }).isFloat({ min: 0, max: 500 }),
    body('altura_cm').optional({ nullable: true }).isFloat({ min: 0, max: 300 }),
], Miembros.crear);
router.put('/miembros/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
], Miembros.actualizar);
router.patch('/miembros/:id/estado', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('estado').isIn(['ACTIVO','SUSPENDIDO','MOROSO','INACTIVO']),
], Miembros.cambiarEstado);

// Planes
router.get('/planes', [query('id_negocio').isInt({ min: 1 })], Planes.listar);
router.post('/planes', [
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').trim().notEmpty().isLength({ max: 120 }),
    body('precio').isFloat({ min: 0 }),
    body('duracion_meses').isInt({ min: 1, max: 60 }),
    body('beneficios').optional({ nullable: true }).isString(),
], Planes.crear);
router.put('/planes/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('precio').optional().isFloat({ min: 0 }),
    body('duracion_meses').optional().isInt({ min: 1, max: 60 }),
], Planes.actualizar);
router.patch('/planes/:id/inactivar', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Planes.inactivar);

// Membresías
router.get('/membresias', [query('id_negocio').isInt({ min: 1 })], Membresias.listar);
router.post('/membresias', [
    body('id_negocio').isInt({ min: 1 }),
    body('id_miembro').isInt({ min: 1 }),
    body('id_plan').isInt({ min: 1 }),
], Membresias.asignar);
router.patch('/membresias/:id/pausar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('hasta').optional({ nullable: true }).isISO8601(),
], Membresias.pausar);
router.patch('/membresias/:id/reanudar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Membresias.reanudar);
router.patch('/membresias/:id/cancelar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Membresias.cancelar);

// Pagos
router.get('/pagos', [query('id_negocio').isInt({ min: 1 })], Pagos.listar);
router.post('/pagos', [
    body('id_negocio').isInt({ min: 1 }),
    body('id_miembro').isInt({ min: 1 }),
    body('monto').isFloat({ gt: 0 }),
    body('metodo').isIn(['EFECTIVO','TARJETA','TRANSFERENCIA','OTRO']),
    body('id_plan').optional({ nullable: true }).isInt({ min: 1 }),
    body('id_membresia').optional({ nullable: true }).isInt({ min: 1 }),
    body('concepto').optional({ nullable: true }).isString().isLength({ max: 255 }),
], Pagos.registrar);
router.patch('/pagos/:id/anular', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Pagos.anular);

// Asistencias
router.get('/asistencias', [query('id_negocio').isInt({ min: 1 })], Asistencias.listar);
router.post('/asistencias/entrada', [
    body('id_negocio').isInt({ min: 1 }),
    body('id_miembro').isInt({ min: 1 }),
    body('metodo').optional().isIn(['QR','MANUAL','HUELLA']),
], Asistencias.registrarEntrada);
router.patch('/asistencias/:id/salida', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Asistencias.registrarSalida);
router.patch('/asistencias/salida-por-miembro', [
    body('id_negocio').isInt({ min: 1 }),
    body('id_miembro').isInt({ min: 1 }),
], Asistencias.registrarSalida);

// Productos
router.get('/productos', [query('id_negocio').isInt({ min: 1 })], Productos.listar);
router.get('/productos/:id', [param('id').isInt({ min: 1 }), query('id_negocio').isInt({ min: 1 })], Productos.getById);
router.post('/productos', [
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').trim().notEmpty().isLength({ max: 160 }),
    body('precio').isFloat({ min: 0 }),
    body('sku').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 60 }),
    body('categoria').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 80 }),
    body('stock_actual').optional({ nullable: true }).isFloat({ min: 0 }),
    body('stock_minimo').optional({ nullable: true }).isFloat({ min: 0 }),
    body('costo').optional({ nullable: true }).isFloat({ min: 0 }),
], Productos.crear);
router.put('/productos/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('precio').optional().isFloat({ min: 0 }),
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

// Ventas
router.get('/ventas', [query('id_negocio').isInt({ min: 1 })], Ventas.listar);
router.post('/ventas', [
    body('id_negocio').isInt({ min: 1 }),
    body('id_miembro').optional({ nullable: true }).isInt({ min: 1 }),
    body('metodo').isIn(['EFECTIVO','TARJETA','TRANSFERENCIA','OTRO']),
    body('items').isArray({ min: 1 }),
    body('items.*.id_producto').isInt({ min: 1 }),
    body('items.*.cantidad').isFloat({ gt: 0 }),
], Ventas.registrar);
router.patch('/ventas/:id/anular', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Ventas.anular);

// Configuración + paletas
router.get('/configuracion', [query('id_negocio').isInt({ min: 1 })], Config.getConfiguracion);
router.patch('/configuracion', [body('id_negocio').isInt({ min: 1 })], Config.actualizarConfiguracion);
router.get('/paletas', Config.listarPaletas);
router.get('/negocios/:id/paleta', [param('id').isInt({ min: 1 })], Config.getPaletaNegocio);
router.patch('/negocios/:id/paleta', [
    param('id').isInt({ min: 1 }),
    body('id_paleta').optional({ nullable: true }).isInt({ min: 1 }),
], Config.asignarPaletaNegocio);

module.exports = router;
