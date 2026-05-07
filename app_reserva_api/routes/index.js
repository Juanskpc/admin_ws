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
const Citas        = require('../controllers/citaController');
const Config       = require('../controllers/configController');
const { verificarToken } = require('../../app_core/middleware/auth');

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
router.get('/publico/:id_negocio/disponibilidad', [
    param('id_negocio').isInt({ min: 1 }),
    query('fecha').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('fecha YYYY-MM-DD requerida'),
    query('id_servicio').isInt({ min: 1 }),
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
router.post('/citas/:id/completar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Citas.completar);
router.post('/citas/:id/no-show', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Citas.noShow);
router.post('/citas/:id/cancelar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('motivo').optional({ nullable: true }).isString(),
], Citas.cancelarPorNegocio);
router.post('/citas/:id/pago/aprobar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
], Citas.aprobarPago);
router.post('/citas/:id/pago/rechazar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('motivo').optional({ nullable: true }).isString(),
], Citas.rechazarPago);
router.get('/citas/:id/comprobante', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Citas.descargarComprobante);

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
], Config.actualizar);

module.exports = router;
