'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { body, param, query } = require('express-validator');
const router = express.Router();

const Dashboard    = require('../controllers/dashboardController');
const Publico      = require('../controllers/publicoController');
const Servicios    = require('../controllers/servicioController');
const Profesionales = require('../controllers/profesionalController');
const Horarios     = require('../controllers/horarioController');
const Bloqueos     = require('../controllers/bloqueoController');
const Disponibilidad = require('../controllers/disponibilidadController');
const Informes     = require('../controllers/informeController');
const Caja         = require('../controllers/cajaController');
const MetodosPago  = require('../controllers/metodoPagoController');
const Usuarios     = require('../controllers/usuarioController');
const Citas        = require('../controllers/citaController');
const Config       = require('../controllers/configController');
const { verificarToken } = require('../../app_core/middleware/auth');
const { exigirAccion } = require('../middleware/exigirAccion');

// ───────── Multer: comprobantes de pago ─────────
const COMPROBANTES_BASE = path.resolve(path.join(__dirname, '..', '..', 'uploads', 'reserva', 'comprobantes'));
const storage = multer.diskStorage({
    destination(req, _file, cb) {
        const idNegocio = String(req.params.id_negocio || 'misc').replace(/[^\d]/g, '') || 'misc';
        const dir = path.join(COMPROBANTES_BASE, idNegocio);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename(_req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase().slice(0, 8) || '.bin';
        cb(null, `${uuidv4()}${ext}`);
    },
});
const fileFilter = (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(Object.assign(new Error('Solo se permiten imágenes JPG, PNG o WEBP'), { statusCode: 400 }));
};
const uploadComprobante = multer({
    storage, fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 },  // 5 MB
});

// ═════════ RUTAS PÚBLICAS (sin token) ═════════
router.post('/auth/verificar-token', Dashboard.verificarTokenAcceso);
router.post('/auth/generar-codigo',
    [body('token').notEmpty().withMessage('Token requerido')],
    Dashboard.generarCodigoAcceso,
);
router.post('/auth/canjear-codigo',
    [body('code').notEmpty().withMessage('Código requerido')],
    Dashboard.canjearCodigo,
);

// Flujo cliente público
router.get('/publico/:id_negocio/info',
    [param('id_negocio').isInt({ min: 1 })],
    Publico.getInfoNegocio);
router.get('/publico/:id_negocio/servicios',
    [param('id_negocio').isInt({ min: 1 })],
    Publico.listarServicios);
router.get('/publico/:id_negocio/profesionales',
    [param('id_negocio').isInt({ min: 1 }),
     query('id_servicio').optional().isInt({ min: 1 })],
    Publico.listarProfesionales);
// `id_servicio` o `id_servicios`: uno de los dos. El primero es el contrato viejo (un solo
// servicio); el segundo permite pedir la disponibilidad de un combo, que es lo que la creación
// de la cita reserva de verdad. Si no llega ninguno, el servicio responde 400.
router.get('/publico/:id_negocio/disponibilidad', [
    param('id_negocio').isInt({ min: 1 }),
    query('fecha').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('fecha YYYY-MM-DD requerida'),
    query('id_servicio').optional().isInt({ min: 1 }),
    query('id_servicios').optional().matches(/^\d+(,\d+)*$/).withMessage('id_servicios debe ser una lista de ids separada por comas'),
    query('id_profesional').isInt({ min: 1 }),
], Publico.getDisponibilidad);

// Crear cita: multipart si lleva comprobante; multer.single tolera ambos casos.
router.post('/publico/:id_negocio/cita',
    uploadComprobante.single('comprobante'),
    [
        param('id_negocio').isInt({ min: 1 }),
        body('id_profesional').isInt({ min: 1 }),
        body('fecha_hora_inicio').notEmpty(),
        body('cliente_nombre').trim().notEmpty().isLength({ max: 150 }),
        body('cliente_email').optional({ nullable: true, checkFalsy: true }).isEmail(),
        body('cliente_telefono').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 30 }),
        body('notas').optional({ nullable: true }).isString(),
    ],
    Publico.crearCitaPublica,
);

// Consultar / cancelar por código
router.get('/publico/cita/:codigo_publico',
    [param('codigo_publico').isUUID()],
    Publico.consultarCita);
router.post('/publico/cita/:codigo_publico/cancelar',
    [param('codigo_publico').isUUID()],
    Publico.cancelarCitaPublica);

// ═════════ RUTAS PROTEGIDAS ═════════
router.use(verificarToken);

// Autorizacion multi-inquilino (ADR-002, ADR-010): verifica que el usuario del token
// pertenece al id_negocio que pide. Arranca en modo observacion (audita, no bloquea).
const { exigirPertenenciaNegocio } = require('../../app_core/middleware/authzNegocio');
router.use(exigirPertenenciaNegocio);

router.get('/dashboard/resumen', [query('id_negocio').isInt({ min: 1 })], Dashboard.getResumen);
router.get('/perfil', Dashboard.getPerfil);

// Servicios
router.get('/servicios', [query('id_negocio').isInt({ min: 1 })], Servicios.listar);
router.get('/servicios/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Servicios.getById);
router.post('/servicios', [
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').trim().notEmpty().isLength({ max: 150 }),
    body('duracion_min').isInt({ min: 5, max: 600 }),
    body('precio').isFloat({ min: 0 }),
    body('descripcion').optional({ nullable: true }).isString(),
    body('color_hex').optional({ nullable: true }).matches(/^#?[0-9a-fA-F]{6}$/),
    body('imagen_url').optional({ nullable: true }).isString().isLength({ max: 500 }),
], Servicios.crear);
router.put('/servicios/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').optional().trim().notEmpty().isLength({ max: 150 }),
    body('duracion_min').optional().isInt({ min: 5, max: 600 }),
    body('precio').optional().isFloat({ min: 0 }),
], Servicios.actualizar);
router.patch('/servicios/:id/inactivar', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Servicios.inactivar);

// Profesionales
router.get('/profesionales', [query('id_negocio').isInt({ min: 1 })], Profesionales.listar);
router.get('/profesionales/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Profesionales.getById);
router.post('/profesionales', [
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').trim().notEmpty().isLength({ max: 150 }),
    body('especialidad').optional({ nullable: true }).isString().isLength({ max: 150 }),
    body('telefono').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 30 }),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('foto_url').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('color_hex').optional({ nullable: true }).matches(/^#?[0-9a-fA-F]{6}$/),
    body('id_usuario').optional({ nullable: true }).isInt({ min: 1 }),
], Profesionales.crear);
router.put('/profesionales/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').optional().trim().notEmpty().isLength({ max: 150 }),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
], Profesionales.actualizar);
router.patch('/profesionales/:id/inactivar', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Profesionales.inactivar);
router.put('/profesionales/:id/servicios', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('id_servicios').isArray(),
    body('id_servicios.*').isInt({ min: 1 }),
], Profesionales.setServicios);

// Horarios
router.get('/horarios', [query('id_negocio').isInt({ min: 1 })], Horarios.listar);
router.put('/horarios', [
    body('id_negocio').isInt({ min: 1 }),
    body('id_profesional').optional({ nullable: true }).isInt({ min: 1 }),
    body('bloques').isArray(),
    body('bloques.*.dia_semana').isInt({ min: 0, max: 6 }),
    body('bloques.*.hora_inicio').matches(/^\d{2}:\d{2}(:\d{2})?$/),
    body('bloques.*.hora_fin').matches(/^\d{2}:\d{2}(:\d{2})?$/),
], Horarios.reemplazar);

// Disponibilidad (vista negocio). `/dias` va primero por legibilidad: no hay colisión de
// rutas, ambas son literales.
router.get('/disponibilidad/dias', [
    query('id_negocio').isInt({ min: 1 }),
    query('id_profesional').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    query('desde').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('desde YYYY-MM-DD requerida'),
    query('hasta').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('hasta YYYY-MM-DD requerida'),
], Disponibilidad.getDias);
router.get('/disponibilidad', [
    query('id_negocio').isInt({ min: 1 }),
    query('id_profesional').isInt({ min: 1 }),
    query('fecha').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('fecha YYYY-MM-DD requerida'),
    query('id_servicio').optional().isInt({ min: 1 }),
    query('id_servicios').optional().matches(/^\d+(,\d+)*$/).withMessage('id_servicios debe ser una lista de ids separada por comas'),
], Disponibilidad.getSlots);

// Bloqueos
router.get('/bloqueos', [query('id_negocio').isInt({ min: 1 })], Bloqueos.listar);
router.post('/bloqueos', [
    body('id_negocio').isInt({ min: 1 }),
    body('id_profesional').optional({ nullable: true }).isInt({ min: 1 }),
    body('fecha_inicio').notEmpty(),
    body('fecha_fin').notEmpty(),
    body('motivo').optional({ nullable: true }).isString().isLength({ max: 200 }),
], Bloqueos.crear);
router.delete('/bloqueos/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Bloqueos.eliminar);

// Citas (vista negocio)
router.get('/citas', [query('id_negocio').isInt({ min: 1 })], Citas.listar);
router.get('/citas/pendientes-pago',
    [query('id_negocio').isInt({ min: 1 })],
    Citas.listarPendientesPago);
router.get('/citas/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Citas.getById);
router.post('/citas', [
    body('id_negocio').isInt({ min: 1 }),
    body('id_profesional').isInt({ min: 1 }),
    body('id_servicios').isArray({ min: 1 }),
    body('id_servicios.*').isInt({ min: 1 }),
    body('fecha_hora_inicio').notEmpty(),
    body('cliente_nombre').trim().notEmpty().isLength({ max: 150 }),
    body('cliente_email').optional({ nullable: true, checkFalsy: true }).isEmail(),
], Citas.crearManual);
router.post('/citas/:id/confirmar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Citas.confirmar);
// Completar es cobrar: llega la forma de pago simple o el desglose multipago. El servicio
// valida que el desglose cuadre con el total y que las formas sean del negocio.
router.post('/citas/:id/completar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('id_metodo_pago').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('pagos').optional().isArray({ min: 1 }),
    body('pagos.*.id_metodo_pago').optional().isInt({ min: 1 }),
    body('pagos.*.valor').optional().isFloat({ gt: 0 }),
], exigirAccion('citas_completar'), Citas.completar);
router.post('/citas/:id/no-show', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Citas.noShow);
router.post('/citas/:id/cancelar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('motivo').optional({ nullable: true }).isString(),
], exigirAccion('citas_cancelar'), Citas.cancelarPorNegocio);
router.post('/citas/:id/pago/aprobar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], exigirAccion('citas_validar_pago'), Citas.aprobarPago);
router.post('/citas/:id/pago/rechazar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('motivo').optional({ nullable: true }).isString(),
], exigirAccion('citas_validar_pago'), Citas.rechazarPago);
router.get('/citas/:id/comprobante', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Citas.descargarComprobante);

// ── Usuarios y permisos del negocio ──
// Cada handler verifica contra la BD que el llamante pueda administrar ese `id_negocio`; el
// parámetro no se cree por sí solo. Las rutas literales van antes que `/:id`.
router.get('/usuarios', [
    query('id_negocio').isInt({ min: 1 }),
    query('search').optional().isString().isLength({ max: 100 }),
], Usuarios.listar);
router.get('/usuarios/roles', [query('id_negocio').isInt({ min: 1 })], Usuarios.listarRoles);
router.get('/usuarios/profesionales-libres', [
    query('id_negocio').isInt({ min: 1 }),
], Usuarios.profesionalesLibres);
router.get('/usuarios/roles/:id/permisos', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Usuarios.getPermisosRol);
router.put('/usuarios/roles/:id/permisos', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('modulos').isArray(),
    body('modulos.*.id_nivel').isInt({ min: 1 }),
    body('modulos.*.puede_ver').isBoolean(),
    body('modulos.*.acciones').optional().isArray(),
    body('modulos.*.acciones.*.id_nivel').optional().isInt({ min: 1 }),
    body('modulos.*.acciones.*.puede_ver').optional().isBoolean(),
], Usuarios.savePermisosRol);
router.post('/usuarios', [
    body('id_negocio').isInt({ min: 1 }),
    body('primer_nombre').trim().notEmpty().isLength({ max: 100 }),
    body('primer_apellido').trim().notEmpty().isLength({ max: 100 }),
    body('num_identificacion').trim().notEmpty().isLength({ max: 30 }),
    body('email').trim().isEmail().isLength({ max: 120 }),
    body('telefono').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 30 }),
    body('id_rol').isInt({ min: 1 }),
    body('password').optional({ nullable: true, checkFalsy: true }).isLength({ min: 8 }),
    body('id_profesional').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
], Usuarios.crear);
router.put('/usuarios/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('primer_nombre').optional().trim().notEmpty().isLength({ max: 100 }),
    body('primer_apellido').optional().trim().notEmpty().isLength({ max: 100 }),
    body('email').optional().trim().isEmail().isLength({ max: 120 }),
    body('id_rol').optional().isInt({ min: 1 }),
    body('password').optional({ nullable: true, checkFalsy: true }).isLength({ min: 8 }),
], Usuarios.actualizar);
router.patch('/usuarios/:id/estado', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('estado').isIn(['A', 'I']),
], Usuarios.cambiarEstado);
router.post('/usuarios/:id/reset-password', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Usuarios.resetPassword);

// ── Formas de pago ──
router.get('/metodos-pago', [query('id_negocio').isInt({ min: 1 })], MetodosPago.listar);
router.post('/metodos-pago', [
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').trim().notEmpty().isLength({ max: 80 }),
    body('orden').optional().isInt({ min: 0, max: 999 }),
], MetodosPago.crear);
router.put('/metodos-pago/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').optional().trim().notEmpty().isLength({ max: 80 }),
    body('orden').optional().isInt({ min: 0, max: 999 }),
], MetodosPago.actualizar);
router.patch('/metodos-pago/:id/estado', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('estado').isIn(['A', 'I']),
], MetodosPago.cambiarEstado);

// ── Caja ──
// Las rutas literales van antes que `/caja/:id`, o Express interpretaría «historial» como un id.
router.get('/caja', [query('id_negocio').isInt({ min: 1 })], Caja.getEstado);
router.get('/caja/historial', [
    query('id_negocio').isInt({ min: 1 }),
    query('limite').optional().isInt({ min: 1, max: 100 }),
], Caja.historial);
router.get('/caja/pendientes', [query('id_negocio').isInt({ min: 1 })], Caja.pendientes);
router.post('/caja/abrir', [
    body('id_negocio').isInt({ min: 1 }),
    body('monto_apertura').optional().isFloat({ min: 0 }),
    body('observaciones').optional({ nullable: true }).isString().isLength({ max: 500 }),
], exigirAccion('caja_abrir'), Caja.abrir);
router.post('/caja/movimiento', [
    body('id_negocio').isInt({ min: 1 }),
    body('tipo').isIn(['INGRESO', 'EGRESO', 'ingreso', 'egreso']),
    body('monto').isFloat({ gt: 0 }),
    body('concepto').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('id_metodo_pago').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
], exigirAccion('caja_movimiento'), Caja.registrarMovimiento);
router.post('/caja/:id/cerrar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('monto_reportado').optional({ nullable: true }).isFloat({ min: 0 }),
    body('observaciones').optional({ nullable: true }).isString().isLength({ max: 500 }),
], exigirAccion('caja_cerrar'), Caja.cerrar);
router.get('/caja/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Caja.getDetalle);

// Informes
router.get('/informes', [
    query('id_negocio').isInt({ min: 1 }),
    query('desde').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('desde YYYY-MM-DD requerida'),
    query('hasta').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('hasta YYYY-MM-DD requerida'),
    query('id_profesional').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
], Informes.getInforme);

// Configuración
router.get('/config', [query('id_negocio').isInt({ min: 1 })], Config.get);
router.put('/config', [
    body('id_negocio').isInt({ min: 1 }),
    body('anticipacion_min_horas').optional().isInt({ min: 0, max: 168 }),
    body('buffer_limpieza_min').optional().isInt({ min: 0, max: 240 }),
    body('ventana_cancelacion_horas').optional().isInt({ min: 0, max: 168 }),
    body('paso_slot_min').optional().isInt({ min: 5, max: 60 }),
    body('cobro_adelantado').optional().isBoolean(),
    body('instrucciones_pago').optional({ nullable: true }).isString(),
    body('permite_cobro_profesional').optional().isBoolean(),
    body('permite_multipago').optional().isBoolean(),
    body('exige_caja_abierta').optional().isBoolean(),
], Config.actualizar);

module.exports = router;
