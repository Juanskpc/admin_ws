const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const DashboardController   = require('../controllers/dashboardController');
const ParqueaderoController = require('../controllers/parqueaderoController');
const { verificarToken }    = require('../../app_core/middleware/auth');

// ═══════════════ RUTAS PÚBLICAS ═══════════════
router.post('/auth/verificar-token', DashboardController.verificarTokenAcceso);

// Genera un código de acceso de un solo uso (30 s) a partir del JWT del admin_app
router.post('/auth/generar-codigo',
  [body('token').notEmpty().withMessage('Token requerido')],
  DashboardController.generarCodigoAcceso,
);

// Canjea el código y devuelve datos completos de acceso (usuario + negocios + niveles)
router.post('/auth/canjear-codigo',
  [body('code').notEmpty().withMessage('Código requerido')],
  DashboardController.canjearCodigo,
);

// ═══════════════ RUTAS PROTEGIDAS ═══════════════
router.use(verificarToken);

// ── Dashboard ──
router.get('/dashboard/resumen', DashboardController.getResumenDashboard);
router.get('/perfil', DashboardController.getPerfilParqueadero);

// ── Vehículos ──
router.post('/vehiculos/entrada', [
  body('placa').notEmpty().withMessage('Placa requerida'),
  body('id_tipo_vehiculo').isInt().withMessage('Tipo de vehículo requerido'),
  body('id_negocio').isInt().withMessage('id_negocio requerido'),
], ParqueaderoController.registrarEntrada);

router.put('/vehiculos/:id/salida', [
  param('id').isInt(),
  body('id_negocio').isInt().withMessage('id_negocio requerido'),
  body('valor_cobrado').isNumeric().withMessage('Valor cobrado requerido'),
], ParqueaderoController.registrarSalida);

router.get('/vehiculos/actuales', ParqueaderoController.getVehiculosActuales);
router.get('/vehiculos/historial', ParqueaderoController.getHistorialVehiculos);

// ── Tarifas ──
router.get('/tarifas', ParqueaderoController.getTarifas);
router.post('/tarifas', [
  body('id_tipo_vehiculo').isInt(),
  body('id_negocio').isInt(),
  body('tipo_cobro').isIn(['HORA', 'FRACCION', 'DIA', 'MES']),
  body('valor').isNumeric(),
], ParqueaderoController.createTarifa);
router.put('/tarifas/:id', ParqueaderoController.updateTarifa);
router.delete('/tarifas/:id', ParqueaderoController.deleteTarifa);

// ── Tipos de vehículo ──
router.get('/tipos-vehiculo', ParqueaderoController.getTiposVehiculo);
router.post('/tipos-vehiculo', [
  body('nombre').notEmpty(),
  body('id_negocio').isInt(),
], ParqueaderoController.createTipoVehiculo);
router.put('/tipos-vehiculo/:id', ParqueaderoController.updateTipoVehiculo);

// ── Capacidad ──
router.get('/capacidad', ParqueaderoController.getCapacidad);
router.put('/capacidad', [
  body('id_negocio').isInt(),
  body('id_tipo_vehiculo').isInt(),
  body('espacios_total').isInt({ min: 0 }),
], ParqueaderoController.upsertCapacidad);

// ── Configuración ──
router.get('/configuracion', ParqueaderoController.getConfiguracion);
router.put('/configuracion', [
  body('id_negocio').isInt(),
], ParqueaderoController.upsertConfiguracion);

// ── Abonados ──
router.get('/abonados', ParqueaderoController.getAbonados);
router.post('/abonados', [
  body('nombre').notEmpty(),
  body('placa').notEmpty(),
  body('id_tipo_vehiculo').isInt(),
  body('id_negocio').isInt(),
  body('fecha_inicio').isDate(),
  body('fecha_fin').isDate(),
  body('valor_mensualidad').isNumeric(),
], ParqueaderoController.createAbonado);
router.put('/abonados/:id', ParqueaderoController.updateAbonado);

// ── Caja ──
router.get('/caja/abierta', ParqueaderoController.getCajaAbierta);
router.post('/caja/abrir', [
  body('id_negocio').isInt(),
], ParqueaderoController.abrirCaja);
router.put('/caja/:id/cerrar', [
  body('id_negocio').isInt(),
], ParqueaderoController.cerrarCaja);
router.get('/caja/:id/movimientos', ParqueaderoController.getMovimientosCaja);
router.post('/caja/movimientos', [
  body('id_caja').isInt(),
  body('tipo').isIn(['INGRESO', 'EGRESO']),
  body('monto').isNumeric(),
], ParqueaderoController.registrarMovimientoCaja);

module.exports = router;
