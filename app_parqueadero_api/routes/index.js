const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const DashboardController   = require('../controllers/dashboardController');
const ParqueaderoController = require('../controllers/parqueaderoController');
const ReporteController     = require('../controllers/reporteController');
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

// Descarga de archivo (JWT firmado en ?token= — no requiere sesión)
router.get('/reportes/:reporteId/descargar',   ReporteController.descargarReporte);

// ═══════════════ RUTAS PROTEGIDAS ═══════════════
router.use(verificarToken);

// ── Dashboard ──
router.get('/dashboard/resumen', DashboardController.getResumenDashboard);
router.get('/perfil', DashboardController.getPerfilParqueadero);

// ── Vehículos ──
router.get('/vehiculos/buscar', ParqueaderoController.buscarVehiculo); // ?placa=&id_negocio=
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

router.get('/vehiculos/:id/calcular-costo', ParqueaderoController.calcularCosto);
router.get('/vehiculos/actuales',  ParqueaderoController.getVehiculosActuales);
router.get('/vehiculos/historial', ParqueaderoController.getHistorialVehiculos);

// ── Facturas ──
router.get('/facturas/:id',      ParqueaderoController.getFactura);    // ?id_negocio=
router.get('/facturas/:id/html', ParqueaderoController.getFacturaPdf); // ?id_negocio=&con_salida=true

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

// ── Impresión silenciosa ──
router.post('/imprimir/recibo', [
  body('id_negocio').isInt().withMessage('id_negocio requerido'),
  body('vehiculoData').notEmpty().withMessage('vehiculoData requerido'),
  body('esSalida').isBoolean(),
], ParqueaderoController.imprimirRecibo);
router.get('/imprimir/impresoras', ParqueaderoController.listarImpresoras);

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

// ═══════════════ REPORTES ═══════════════
// Validadores comunes (params en camelCase, igual que envía el frontend)
const qNegocio  = query('idNegocio').isInt().withMessage('idNegocio requerido');
const qFechas   = [
  query('fechaDesde').isDate().withMessage('fechaDesde debe ser YYYY-MM-DD'),
  query('fechaHasta').isDate().withMessage('fechaHasta debe ser YYYY-MM-DD'),
];

// Resumen KPIs
router.get('/reportes/resumen',        [qNegocio, ...qFechas], ReporteController.getResumenPeriodo);

// Serie temporal de ingresos
router.get('/reportes/ingresos/agregado', [qNegocio, ...qFechas], ReporteController.getIngresosAgregado);

// Transacciones paginadas
router.get('/reportes/transacciones',  [qNegocio, ...qFechas], ReporteController.getTransacciones);

// Ocupación
router.get('/reportes/ocupacion',      [qNegocio, ...qFechas], ReporteController.getOcupacion);

// Horas pico
router.get('/reportes/horas-pico',     [qNegocio, ...qFechas], ReporteController.getHorasPico);

// Distribución por tipo de vehículo
router.get('/reportes/tipos-vehiculo-mix', [qNegocio, ...qFechas], ReporteController.getDistribucionTipos);

// Reconciliación de caja / turno
router.get('/reportes/turno/:idCaja',  [query('id_negocio').isInt()], ReporteController.getReconciliacionCaja);

// Anomalías
router.get('/reportes/anomalias',      [qNegocio, ...qFechas], ReporteController.getAnomalias);

// Preview de un reporte
router.get('/reportes/preview', [
  query('tipo_reporte').notEmpty().withMessage('tipo_reporte requerido'),
  qNegocio,
], ReporteController.previewReporte);

// Generar reporte (síncrono o asíncrono)
router.post('/reportes/generar', [
  body('tipo_reporte').notEmpty().withMessage('tipo_reporte requerido'),
  body('id_negocio').isInt().withMessage('id_negocio requerido'),
  body('fecha_desde').optional().isDate(),
  body('fecha_hasta').optional().isDate(),
  body('formato').optional().isIn(['json', 'csv', 'xlsx', 'pdf']),
], ReporteController.generarReporte);

// ── Reportes Programados (deben ir ANTES del comodín :reporteId) ──
router.get('/reportes/programados', [query('id_negocio').isInt().withMessage('id_negocio requerido')], ReporteController.listarProgramaciones);

// Estado de un reporte generado
router.get('/reportes/:reporteId',             ReporteController.getEstadoReporte);

// (descarga movida a rutas públicas, ver arriba)

router.post('/reportes/programados', [
  body('id_negocio').isInt(),
  body('nombre').notEmpty(),
  body('tipo_reporte').notEmpty(),
  body('cron_expression').notEmpty(),
  body('formato').isIn(['pdf', 'csv', 'xlsx']),
  body('email_destinatarios').isArray({ min: 1 }),
], ReporteController.crearProgramacion);

router.delete('/reportes/programados/:scheduleId', [
  query('id_negocio').isInt().withMessage('id_negocio requerido'),
], ReporteController.eliminarProgramacion);

module.exports = router;
