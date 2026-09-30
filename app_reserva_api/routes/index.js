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
const Marca        = require('../controllers/marcaController');
const Citas        = require('../controllers/citaController');
const CodigoCita   = require('../services/codigoCita');
const Config       = require('../controllers/configController');
const Vitrina      = require('../controllers/vitrinaController');
const Categorias   = require('../controllers/categoriaController');
const Clientes     = require('../controllers/clienteController');
const { paisesSoportados, paisesParaSeleccion } = require('../../app_core/helpers/paises');
const Respuesta = require('../../app_core/helpers/respuesta');
const { verificarToken } = require('../../app_core/middleware/auth');
const { exigirAccion } = require('../middleware/exigirAccion');
const { exigirVista } = require('../middleware/exigirVista');
const { exigirFuncion } = require('../middleware/exigirFuncion');
const Perfil       = require('../controllers/perfilController');
const Estancias    = require('../controllers/estanciaController');
const ServicioGaleria = require('../controllers/servicioImagenController');
const Productos      = require('../controllers/productoController');
const VentaProductos = require('../controllers/ventaProductoController');

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

// ───────── Multer: logos y fotos de servicio ─────────
//
// A memoria, no a disco: `imagenService` decide el nombre final a partir del id de la entidad,
// y para eso necesita el buffer, no un archivo que multer ya haya escrito con un nombre suyo.
// El límite es bajo a propósito — el recorte llega del navegador ya redimensionado y en WebP
// (unos 40-120 KB); 3 MB solo cubre el caso raro de un PNG sin comprimir.
const uploadImagen = multer({
    storage: multer.memoryStorage(),
    fileFilter(_req, file, cb) {
        if (['image/webp', 'image/jpeg', 'image/png'].includes(file.mimetype)) cb(null, true);
        else cb(Object.assign(new Error('Formato no admitido. Usa WEBP, JPG o PNG.'), { statusCode: 400 }));
    },
    limits: { fileSize: 3 * 1024 * 1024 },
});

// ───────── Campos de los perfiles de rubro en una cita ─────────
//
// Variante por servicio, precio/duración acordados («a cotizar») y mascota. Todos opcionales:
// sin ellos la cita es la de siempre. Aquí solo se valida la forma; qué se permite lo decide
// `citaService` según las funciones del negocio.
const validadoresPerfilCita = [
    body('variantes').optional({ nullable: true }).custom(v => typeof v === 'object'),
    body('ajustes').optional({ nullable: true }).isArray(),
    body('ajustes.*.id_servicio').optional().isInt({ min: 1 }),
    body('ajustes.*.precio').optional({ nullable: true }).isFloat({ min: 0 }),
    body('ajustes.*.duracion_min').optional({ nullable: true }).isInt({ min: 5, max: 1440 }),
    body('id_mascota').optional({ nullable: true, checkFalsy: true }).isUUID(),
    body('mascota').optional({ nullable: true }).isObject(),
    body('mascota.nombre').optional().isString().isLength({ max: 80 }),
];

// Campos de un servicio que solo usan algunos perfiles (espera, cotizar, consentimiento, cabina,
// variantes). Con los valores por defecto el servicio es el de siempre.
const validadoresPerfilServicio = [
    body('proceso_desde_min').optional({ nullable: true }).isInt({ min: 0, max: 600 }),
    body('proceso_min').optional({ nullable: true }).isInt({ min: 0, max: 600 }),
    body('a_cotizar').optional().isBoolean(),
    body('precio_min').optional({ nullable: true, checkFalsy: true }).isFloat({ min: 0 }),
    body('precio_max').optional({ nullable: true, checkFalsy: true }).isFloat({ min: 0 }),
    body('requiere_consentimiento').optional().isBoolean(),
    body('id_tipo_recurso').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('variantes').optional({ nullable: true }).isArray({ max: 20 }),
    body('variantes.*.nombre').optional().isString().isLength({ max: 80 }),
    body('variantes.*.duracion_min').optional().isInt({ min: 5, max: 600 }),
    body('variantes.*.precio').optional().isFloat({ min: 0 }),
];

// ───────── Multer: archivos de la ficha del cliente (privados) ─────────
// A memoria: `fichaService` los escribe en `uploads/reserva/fichas`, que no se sirve como
// estático. Admite PDF porque un consentimiento escaneado suele serlo.
const uploadFicha = multer({
    storage: multer.memoryStorage(),
    fileFilter(_req, file, cb) {
        if (['image/webp', 'image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype)) cb(null, true);
        else cb(Object.assign(new Error('Formato no admitido. Usa JPG, PNG, WEBP o PDF.'), { statusCode: 400 }));
    },
    limits: { fileSize: 8 * 1024 * 1024 },
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
//
// `/publico/dominio/:slug` y `/publico/verificar-dominio` van ANTES que `/publico/:id_negocio/*`:
// con el orden inverso, Express probaría a leer "dominio" como si fuera un `id_negocio`.
router.get('/publico/dominio/:slug', Publico.getPorDominio);
router.get('/publico/verificar-dominio', Publico.verificarDominio);
router.get('/publico/:id_negocio/manifest.webmanifest',
    [param('id_negocio').isInt({ min: 1 })],
    Publico.getManifest);
router.get('/publico/:id_negocio/info',
    [param('id_negocio').isInt({ min: 1 })],
    Publico.getInfoNegocio);
// Paquete completo de la portada: negocio + contacto + servicios + profesionales + horarios.
// Existe para que la página del cliente se pinte con una sola petición y no a trozos.
router.get('/publico/:id_negocio/vitrina',
    [param('id_negocio').isInt({ min: 1 })],
    Publico.getVitrina);
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

// Qué días atiende un profesional en un rango. El servicio limita el rango a 92 días.
router.get('/publico/:id_negocio/dias', [
    param('id_negocio').isInt({ min: 1 }),
    query('id_profesional').optional().isInt({ min: 1 }),
    query('desde').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('desde YYYY-MM-DD requerida'),
    query('hasta').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('hasta YYYY-MM-DD requerida'),
], Publico.getDiasDisponibles);

// Agenda de un servicio concreto: días con alguien libre y huecos por profesional. Las dos
// alimentan la página del servicio, que resuelve la reserva entera en una sola vista.
router.get('/publico/:id_negocio/servicio/:id_servicio/dias', [
    param('id_negocio').isInt({ min: 1 }),
    param('id_servicio').isInt({ min: 1 }),
    query('desde').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('desde YYYY-MM-DD requerida'),
    query('hasta').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('hasta YYYY-MM-DD requerida'),
    query('id_variante').optional().isInt({ min: 1 }),
], Publico.getDiasDeServicio);

router.get('/publico/:id_negocio/servicio/:id_servicio/slots', [
    param('id_negocio').isInt({ min: 1 }),
    param('id_servicio').isInt({ min: 1 }),
    query('fecha').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('fecha YYYY-MM-DD requerida'),
    query('id_variante').optional().isInt({ min: 1 }),
], Publico.getSlotsDeServicio);

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

// Consultar / cancelar por código.
//
// Ya no es `isUUID`: desde que el código son 8 caracteres legibles, esa validación rechazaba
// con un 422 todos los códigos nuevos. `esValido` acepta las dos formas —el formato corto,
// con guiones o sin ellos, y los UUID que ya están en manos de clientes— y el servicio se
// encarga de normalizar antes de buscar.
const codigoValido = param('codigo_publico').custom(v => CodigoCita.esValido(v))
    .withMessage('Código de reserva inválido');

// Estancias desde el portal (alojamiento, hotel de mascotas): qué hay libre para unas fechas y
// reservar con el comprobante del anticipo. El servicio responde 403 si el negocio no usa
// estancias.
const fechaISO = (campo, donde = query) => donde(campo).matches(/^\d{4}-\d{2}-\d{2}$/).withMessage(`${campo} AAAA-MM-DD`);
router.get('/publico/:id_negocio/estancias/disponibilidad', [
    param('id_negocio').isInt({ min: 1 }),
    fechaISO('entrada'), fechaISO('salida'),
    query('huespedes').optional().isInt({ min: 1, max: 50 }),
], Estancias.publicoDisponibilidad);
router.post('/publico/:id_negocio/estancia',
    uploadComprobante.single('comprobante'),
    [
        param('id_negocio').isInt({ min: 1 }),
        body('id_unidad_tipo').isInt({ min: 1 }),
        fechaISO('fecha_entrada', body), fechaISO('fecha_salida', body),
        body('huespedes').optional().isInt({ min: 1, max: 50 }),
        body('cliente_nombre').trim().notEmpty().isLength({ max: 150 }),
        body('cliente_telefono').trim().notEmpty().isLength({ max: 30 }),
        body('cliente_email').optional({ nullable: true, checkFalsy: true }).isEmail(),
        body('cliente_documento').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 30 }),
        body('notas').optional({ nullable: true }).isString().isLength({ max: 2000 }),
    ],
    Estancias.publicoCrear,
);
// Comprar productos sin cita, para recoger en el local (ver `docs/productos-en-reserva.md`).
router.post('/publico/:id_negocio/venta-producto', [
    param('id_negocio').isInt({ min: 1 }),
    body('items').isArray({ min: 1 }),
    body('items.*.id_producto').isInt({ min: 1 }),
    body('items.*.cantidad').optional().isFloat({ gt: 0 }),
    body('cliente_nombre').trim().notEmpty().isLength({ max: 150 }),
    body('cliente_telefono').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 30 }),
    body('notas').optional({ nullable: true }).isString(),
], exigirFuncion('productos'), Publico.crearVentaProductoPublica);

// Calendario exportado de una unidad, para pegar en Airbnb/Booking. El token es el secreto.
router.get('/publico/ical/:token', Estancias.icalExportar);

router.get('/publico/cita/:codigo_publico', [codigoValido], Publico.consultarCita);
router.post('/publico/cita/:codigo_publico/cancelar', [codigoValido], Publico.cancelarCitaPublica);

// Catálogo de países: código, nombre, indicativo telefónico y moneda.
//
// Existe como ruta suelta porque el selector de indicativo del teléfono vive en Usuarios y en
// Profesionales, que no cargan la configuración del negocio — y también en el portal público al
// agendar, que no tiene sesión. La alternativa era escribir la lista de prefijos en el frontend,
// y entonces añadir un país en `helpers/paises.js` dejaría de bastar. No lleva `id_negocio`: es
// catálogo de plataforma, igual para todos. Va ANTES de `verificarToken` a propósito: sin
// sesión el portal público también necesita pintar el selector con bandera e indicativo.
router.get('/paises', (_req, res) => Respuesta.success(res, 'Países', paisesParaSeleccion()));

// ═════════ RUTAS PROTEGIDAS ═════════
router.use(verificarToken);

// Autorizacion multi-inquilino (ADR-002, ADR-010): verifica que el usuario del token
// pertenece al id_negocio que pide. Arranca en modo observacion (audita, no bloquea).
const { exigirPertenenciaNegocio } = require('../../app_core/middleware/authzNegocio');
router.use(exigirPertenenciaNegocio);

// --- Avisos en vivo (SSE) ---
// La Agenda se entera sola de las citas que entran por el asistente, el portal o un compañero.
// Los hooks de ReservaCita/ReservaBloqueo emiten el aviso tras el commit (ver avisoService).
require('../services/avisoService').registrarHooks();
router.get('/eventos', require('../controllers/eventosController').suscribirEventos);

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
    body('id_categoria').optional({ nullable: true }).isInt({ min: 1 }),
    ...validadoresPerfilServicio,
], Servicios.crear);
router.put('/servicios/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').optional().trim().notEmpty().isLength({ max: 150 }),
    body('duracion_min').optional().isInt({ min: 5, max: 600 }),
    body('precio').optional().isFloat({ min: 0 }),
    body('id_categoria').optional({ nullable: true }).isInt({ min: 1 }),
    ...validadoresPerfilServicio,
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
    body('telefono_pais').optional({ nullable: true, checkFalsy: true }).isIn(paisesSoportados()),
    body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('foto_url').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('color_hex').optional({ nullable: true }).matches(/^#?[0-9a-fA-F]{6}$/),
    body('id_usuario').optional({ nullable: true }).isInt({ min: 1 }),
], Profesionales.crear);
router.put('/profesionales/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').optional().trim().notEmpty().isLength({ max: 150 }),
    body('telefono').optional({ nullable: true }).isString().isLength({ max: 30 }),
    body('telefono_pais').optional({ nullable: true, checkFalsy: true }).isIn(paisesSoportados()),
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
    query('excluir_cita').optional().isInt({ min: 1 }),
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

// ───────── Clientes ─────────
//
// La cartera del negocio: `platform.persona_negocio` (ADR-006/ADR-025), la misma entidad que
// resuelven las citas por teléfono. Todas pasan por `exigirVista('/clientes')` porque lo que
// devuelven son datos personales de terceros, no el estado del negocio: esconder la entrada
// del menú no cierra la ruta.
router.get('/clientes/buscar', [
    query('id_negocio').isInt({ min: 1 }),
    query('telefono').trim().notEmpty().isLength({ max: 30 }),
], exigirVista('/clientes'), Clientes.buscarPorTelefono);

router.get('/clientes', [
    query('id_negocio').isInt({ min: 1 }),
    query('buscar').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 100 }),
    query('limite').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
], exigirVista('/clientes'), Clientes.listar);

// Antes de `/clientes/:id`: si no, «exportar» se tomaría por un id y fallaría el isUUID.
router.get('/clientes/exportar', [
    query('id_negocio').isInt({ min: 1 }),
    query('formato').isIn(['xlsx', 'pdf']),
    query('buscar').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 100 }),
], exigirVista('/clientes'), Clientes.exportar);

router.get('/clientes/:id', [
    param('id').isUUID(),
    query('id_negocio').isInt({ min: 1 }),
], exigirVista('/clientes'), Clientes.detalle);

router.put('/clientes/:id', [
    param('id').isUUID(),
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').optional({ nullable: true }).trim().isLength({ min: 1, max: 150 }),
    body('notas').optional({ nullable: true }).isString().isLength({ max: 2000 }),
], exigirVista('/clientes'), Clientes.actualizar);

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
    ...validadoresPerfilCita,
], Citas.crearManual);

// Editar una cita ya agendada: servicios, profesional y hora. `id_servicios` es la lista
// completa que debe quedar, no un delta.
router.put('/citas/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('id_servicios').isArray({ min: 1 }),
    body('id_servicios.*').isInt({ min: 1 }),
    body('id_profesional').optional({ nullable: true }).isInt({ min: 1 }),
    body('fecha_hora_inicio').optional({ nullable: true, checkFalsy: true }).notEmpty(),
    ...validadoresPerfilCita,
], exigirAccion('citas_editar'), Citas.actualizar);

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
    // Por dónde llegó el abono (perfiles con depósito). Opcional.
    body('id_metodo_pago').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
], exigirAccion('citas_validar_pago'), Citas.aprobarPago);
// Abonos: asentar el retenido de una cita que no se completará, o devolverlo. Mueven la caja.
router.post('/citas/:id/abono/asentar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('id_metodo_pago').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
], exigirAccion('citas_abonos'), Citas.asentarAbono);
router.post('/citas/:id/abono/devolver', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('id_metodo_pago').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
], exigirAccion('citas_abonos'), Citas.devolverAbono);
router.post('/citas/:id/pago/rechazar', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('motivo').optional({ nullable: true }).isString(),
], exigirAccion('citas_validar_pago'), Citas.rechazarPago);
router.get('/citas/:id/comprobante', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Citas.descargarComprobante);
// Borrado definitivo. No sustituye a `cancelar`: esto es para el registro que no debería
// existir. `agenda_eliminar` es la acción que lo gobierna y de fábrica solo la tiene el
// administrador; el servicio deja evento en auditoría.
router.delete('/citas/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], exigirAccion('agenda_eliminar'), Citas.eliminar);

// ── Identidad visual (logo y colores) ──
router.get('/marca', [query('id_negocio').isInt({ min: 1 })], Marca.getMarca);
router.put('/marca/colores', [
    body('id_negocio').isInt({ min: 1 }),
    body('primario').isString().isLength({ min: 6, max: 7 }),
    body('acento').isString().isLength({ min: 6, max: 7 }),
], exigirAccion('configuracion_cobros'), Marca.guardarColores);
router.put('/marca/paleta', [
    body('id_negocio').isInt({ min: 1 }),
    body('id_paleta').isInt({ min: 1 }),
], exigirAccion('configuracion_cobros'), Marca.aplicarPaleta);
router.delete('/marca/colores', [
    query('id_negocio').isInt({ min: 1 }),
], exigirAccion('configuracion_cobros'), Marca.restablecerColores);
// El `id_negocio` viaja en el cuerpo multipart, así que multer va antes del validador.
router.post('/marca/logo',
    uploadImagen.single('imagen'),
    [body('id_negocio').isInt({ min: 1 })],
    exigirAccion('configuracion_cobros'),
    Marca.subirLogo,
);
router.delete('/marca/logo', [
    query('id_negocio').isInt({ min: 1 }),
], exigirAccion('configuracion_cobros'), Marca.eliminarLogo);
// URL propia del negocio (`<slug>.escalapp.cloud`). La forma se valida otra vez en el servicio
// (`esSlugValido`); aquí solo se exige longitud y que no llegue vacío.
router.put('/marca/slug', [
    body('id_negocio').isInt({ min: 1 }),
    body('slug').isString().trim().isLength({ min: 2, max: 63 }),
], exigirAccion('configuracion_cobros'), Marca.actualizarSlug);

// ── Imagen de un servicio ──
router.post('/servicios/:id/imagen',
    uploadImagen.single('imagen'),
    [param('id').isInt({ min: 1 }), body('id_negocio').isInt({ min: 1 })],
    Marca.subirImagenServicio,
);
router.delete('/servicios/:id/imagen', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Marca.eliminarImagenServicio);

// ── Galería de un servicio (varias fotos, aparte de la portada de arriba) ──
router.get('/servicios/:id/galeria', [
    param('id').isInt({ min: 1 }), query('id_negocio').isInt({ min: 1 }),
], ServicioGaleria.listar);
router.post('/servicios/:id/galeria', uploadImagen.single('imagen'), [
    param('id').isInt({ min: 1 }), body('id_negocio').isInt({ min: 1 }),
    body('descripcion').optional({ nullable: true }).isString().isLength({ max: 200 }),
], exigirVista('/servicios'), ServicioGaleria.agregar);
router.delete('/servicios/galeria/:idImagen', [
    param('idImagen').isInt({ min: 1 }), query('id_negocio').isInt({ min: 1 }),
], exigirVista('/servicios'), ServicioGaleria.eliminar);

// ── Categorías del catálogo ──
//
// `orden` va antes que `/:id` a propósito: con el orden inverso, Express haría coincidir
// `/categorias/orden` con `/categorias/:id` y `id` valdría la cadena "orden".
router.get('/categorias', [query('id_negocio').isInt({ min: 1 })], Categorias.listar);
router.put('/categorias/orden', [
    body('id_negocio').isInt({ min: 1 }),
    body('id_categorias').isArray({ min: 1 }),
], Categorias.reordenar);
router.post('/categorias', [
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').trim().notEmpty().isLength({ max: 120 }),
    body('descripcion').optional({ nullable: true }).isString().isLength({ max: 500 }),
], Categorias.crear);
router.put('/categorias/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('nombre').optional().trim().notEmpty().isLength({ max: 120 }),
    body('descripcion').optional({ nullable: true }).isString().isLength({ max: 500 }),
], Categorias.actualizar);
router.patch('/categorias/:id/inactivar', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Categorias.inactivar);

// ── Banner del negocio ──
router.post('/marca/banner',
    uploadImagen.single('imagen'),
    [body('id_negocio').isInt({ min: 1 })],
    exigirAccion('configuracion_cobros'),
    Marca.subirBanner,
);
router.delete('/marca/banner', [
    query('id_negocio').isInt({ min: 1 }),
], exigirAccion('configuracion_cobros'), Marca.eliminarBanner);

// ── Foto de un profesional ──
router.post('/profesionales/:id/foto',
    uploadImagen.single('imagen'),
    [param('id').isInt({ min: 1 }), body('id_negocio').isInt({ min: 1 })],
    Marca.subirFotoProfesional,
);
router.delete('/profesionales/:id/foto', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], Marca.eliminarFotoProfesional);

// ── Página pública del negocio (edición) ──
router.get('/vitrina', [query('id_negocio').isInt({ min: 1 })], Vitrina.get);
router.put('/vitrina', [
    body('id_negocio').isInt({ min: 1 }),
    body('telefono').optional({ nullable: true }).isString().isLength({ max: 30 }),
    body('pais').optional({ nullable: true, checkFalsy: true }).isIn(paisesSoportados()),
    body('direccion').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('url_whatsapp').optional({ nullable: true }).isString().isLength({ max: 300 }),
    body('url_facebook').optional({ nullable: true }).isString().isLength({ max: 300 }),
    body('url_instagram').optional({ nullable: true }).isString().isLength({ max: 300 }),
    body('url_tiktok').optional({ nullable: true }).isString().isLength({ max: 300 }),
    body('descripcion_publica').optional({ nullable: true }).isString().isLength({ max: 1200 }),
    body('publico_activo').optional().isBoolean(),
], exigirAccion('configuracion_vitrina'), Vitrina.actualizar);

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
    // El correo es opcional: quien inicia sesión es el documento, no el email. Un empleado
    // sin cuenta de correo —lo normal en un salón— no puede quedarse sin acceso por eso.
    body('email').optional({ nullable: true, checkFalsy: true }).trim().isEmail().isLength({ max: 120 }),
    body('telefono').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 30 }),
    // El indicativo viaja aparte del número: el formulario tiene un selector de país y el
    // servicio normaliza a E.164 con él. Ausente = el país del negocio, que es lo que había.
    body('telefono_pais').optional({ nullable: true, checkFalsy: true }).isIn(paisesSoportados()),
    body('id_rol').isInt({ min: 1 }),
    body('password').optional({ nullable: true, checkFalsy: true }).isLength({ min: 8 }),
    body('id_profesional').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    // Atender citas es una capacidad aparte del rol: un administrador o un cajero también
    // pueden prestar servicios. Ver `atiendeCitas` en el servicio.
    body('es_profesional').optional().isBoolean(),
    body('especialidad').optional({ nullable: true }).isString().isLength({ max: 150 }),
], Usuarios.crear);
router.put('/usuarios/:id', [
    param('id').isInt({ min: 1 }),
    body('id_negocio').isInt({ min: 1 }),
    body('primer_nombre').optional().trim().notEmpty().isLength({ max: 100 }),
    body('primer_apellido').optional().trim().notEmpty().isLength({ max: 100 }),
    // "" y null son «borrar el correo», no un email inválido: el servicio lo guarda como NULL.
    body('email').optional({ nullable: true, checkFalsy: true }).trim().isEmail().isLength({ max: 120 }),
    body('telefono').optional({ nullable: true }).isString().isLength({ max: 30 }),
    body('telefono_pais').optional({ nullable: true, checkFalsy: true }).isIn(paisesSoportados()),
    body('id_rol').optional().isInt({ min: 1 }),
    body('password').optional({ nullable: true, checkFalsy: true }).isLength({ min: 8 }),
    body('es_profesional').optional().isBoolean(),
    body('especialidad').optional({ nullable: true }).isString().isLength({ max: 150 }),
    body('id_profesional').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
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
    // Obligatoria en ingreso y egreso: sin forma de pago no hay de qué método restar o sumar al
    // cuadrar el cajón, y el movimiento quedaba huérfano en «Sin forma de pago».
    body('id_metodo_pago').isInt({ min: 1 }),
], exigirAccion('caja_movimiento'), Caja.registrarMovimiento);
// Anular un movimiento del turno abierto: el error de dedo que descuadra la caja. Va antes de
// `/caja/:id` para que Express no lea «movimiento» como un id.
router.delete('/caja/movimiento/:id', [
    param('id').isInt({ min: 1 }),
    query('id_negocio').isInt({ min: 1 }),
], exigirAccion('caja_eliminar'), Caja.eliminarMovimiento);
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

// ═════════ Perfiles de rubro (docs/perfiles-de-reserva.md) ═════════
//
// Cada grupo cuelga de la función que lo sostiene (`exigirFuncion`): si el negocio no la tiene
// encendida, la ruta responde 403 aunque el rol tenga la vista.
const idNeg = (donde = 'query') => (donde === 'body' ? body('id_negocio') : query('id_negocio')).isInt({ min: 1 });

router.get('/perfil-negocio', [idNeg()], Perfil.getPerfil);

// Catálogo de arranque (solo sobre vacío).
router.get('/catalogo/vista-previa', [idNeg()], Perfil.catalogoVistaPrevia);
router.post('/catalogo/servicios', [idNeg('body')],
    exigirVista('/servicios'), Perfil.catalogoSembrarServicios);
router.post('/catalogo/unidades', [idNeg('body')],
    exigirVista('/unidades'), exigirFuncion('estancias'), Perfil.catalogoSembrarUnidades);

// Cabinas y equipos.
router.get('/recursos', [idNeg()], exigirFuncion('recursos'), Perfil.recursosListar);
router.post('/recursos', [
    idNeg('body'),
    body('nombre').trim().notEmpty().isLength({ max: 80 }),
    body('cantidad').optional().isInt({ min: 1, max: 50 }),
], exigirVista('/recursos'), exigirFuncion('recursos'), Perfil.recursosCrearTipo);
router.put('/recursos/:id', [param('id').isInt({ min: 1 }), idNeg('body')],
    exigirVista('/recursos'), exigirFuncion('recursos'), Perfil.recursosActualizarTipo);
router.delete('/recursos/:id', [param('id').isInt({ min: 1 }), idNeg()],
    exigirVista('/recursos'), exigirFuncion('recursos'), Perfil.recursosInactivarTipo);
router.post('/recursos/:id/unidades', [
    param('id').isInt({ min: 1 }), idNeg('body'), body('nombre').trim().notEmpty().isLength({ max: 80 }),
], exigirVista('/recursos'), exigirFuncion('recursos'), Perfil.recursosCrearUnidad);
router.put('/recursos/unidades/:id', [param('id').isInt({ min: 1 }), idNeg('body')],
    exigirVista('/recursos'), exigirFuncion('recursos'), Perfil.recursosActualizarUnidad);
router.delete('/recursos/unidades/:id', [param('id').isInt({ min: 1 }), idNeg()],
    exigirVista('/recursos'), exigirFuncion('recursos'), Perfil.recursosInactivarUnidad);

// Mascotas. Las del cliente las necesita quien agenda (formulario de cita), aunque no tenga la
// vista Mascotas; el listado completo y la edición sí la piden.
router.get('/mascotas', [idNeg(), query('q').optional().isString().isLength({ max: 80 })],
    exigirVista('/mascotas'), exigirFuncion('mascotas'), Perfil.mascotasListar);
router.get('/clientes/:id_persona/mascotas', [param('id_persona').isUUID(), idNeg()],
    exigirFuncion('mascotas'), Perfil.mascotasDeCliente);
router.post('/mascotas', [
    idNeg('body'),
    body('id_persona_negocio').isUUID(),
    body('nombre').trim().notEmpty().isLength({ max: 80 }),
], exigirFuncion('mascotas'), Perfil.mascotasCrear);
router.put('/mascotas/:id', [param('id').isUUID(), idNeg('body')],
    exigirVista('/mascotas'), exigirFuncion('mascotas'), Perfil.mascotasActualizar);
router.delete('/mascotas/:id', [param('id').isUUID(), idNeg()],
    exigirVista('/mascotas'), exigirFuncion('mascotas'), Perfil.mascotasInactivar);

// Ficha del cliente. Se lee desde Clientes (`clientes_ficha_ver`) o desde la cita que se atiende
// (`agenda_ficha`); la usan la ficha, el consentimiento y las vacunas de las mascotas.
const FUNCIONES_FICHA = ['ficha', 'consentimiento', 'mascotas'];
router.get('/ficha', [
    idNeg(),
    query('id_persona_negocio').optional().isUUID(),
    query('id_mascota').optional().isUUID(),
    query('id_cita').optional().isInt({ min: 1 }),
], exigirAccion(['clientes_ficha_ver', 'agenda_ficha']), exigirFuncion(FUNCIONES_FICHA), Perfil.fichaListar);
router.post('/ficha', uploadFicha.single('archivo'), [
    idNeg('body'),
    body('tipo').isIn(['NOTA', 'FORMULA', 'CONTRAINDICACION', 'CONSENTIMIENTO', 'VACUNA', 'REFERENCIA']),
    body('id_persona_negocio').optional({ checkFalsy: true }).isUUID(),
    body('id_mascota').optional({ checkFalsy: true }).isUUID(),
    body('id_cita').optional({ checkFalsy: true }).isInt({ min: 1 }),
    body('titulo').optional({ nullable: true }).isString().isLength({ max: 150 }),
    body('contenido').optional({ nullable: true }).isString().isLength({ max: 5000 }),
    body('vence_en').optional({ checkFalsy: true }).isISO8601(),
], exigirAccion(['clientes_ficha_editar', 'agenda_ficha']), exigirFuncion(FUNCIONES_FICHA), Perfil.fichaCrear);
router.delete('/ficha/:id', [param('id').isInt({ min: 1 }), idNeg()],
    exigirAccion('clientes_ficha_editar'), exigirFuncion(FUNCIONES_FICHA), Perfil.fichaEliminar);
router.get('/ficha/:id/archivo', [param('id').isInt({ min: 1 }), idNeg()],
    exigirAccion(['clientes_ficha_ver', 'agenda_ficha']), Perfil.fichaArchivo);

// Portafolio por profesional (público en el portal; se edita desde Profesionales).
router.get('/profesionales/:id/portafolio', [param('id').isInt({ min: 1 }), idNeg()],
    exigirFuncion('portafolio'), Perfil.portafolioListar);
router.post('/profesionales/:id/portafolio', uploadImagen.single('imagen'), [
    param('id').isInt({ min: 1 }), idNeg('body'),
    body('descripcion').optional({ nullable: true }).isString().isLength({ max: 200 }),
], exigirVista('/profesionales'), exigirFuncion('portafolio'), Perfil.portafolioAgregar);
router.delete('/portafolio/:id', [param('id').isInt({ min: 1 }), idNeg()],
    exigirVista('/profesionales'), exigirFuncion('portafolio'), Perfil.portafolioEliminar);

// Venta de productos, disponible en los siete perfiles y apagada de fábrica
// (`docs/productos-en-reserva.md`). Todo cuelga de `exigirFuncion('productos')`.
const FX_PRODUCTOS = exigirFuncion('productos');
const VISTA_PRODUCTOS = exigirVista('/productos');

router.get('/productos/categorias', [idNeg()], VISTA_PRODUCTOS, FX_PRODUCTOS, Productos.listarCategorias);
router.post('/productos/categorias', [
    idNeg('body'), body('nombre').trim().notEmpty().isLength({ max: 120 }),
], VISTA_PRODUCTOS, exigirAccion('productos_editar'), FX_PRODUCTOS, Productos.crearCategoria);
router.put('/productos/categorias/:id', [param('id').isInt({ min: 1 }), idNeg('body')],
    VISTA_PRODUCTOS, exigirAccion('productos_editar'), FX_PRODUCTOS, Productos.actualizarCategoria);
router.patch('/productos/categorias/:id/inactivar', [param('id').isInt({ min: 1 }), idNeg()],
    VISTA_PRODUCTOS, exigirAccion('productos_editar'), FX_PRODUCTOS, Productos.inactivarCategoria);

router.get('/productos', [idNeg()], VISTA_PRODUCTOS, FX_PRODUCTOS, Productos.listar);
router.post('/productos', [
    idNeg('body'),
    body('nombre').trim().notEmpty().isLength({ max: 150 }),
    body('precio').isFloat({ min: 0 }),
    body('id_categoria').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('controla_stock').optional().isBoolean(),
    body('stock_actual').optional().isFloat({ min: 0 }),
    body('publico_activo').optional().isBoolean(),
], VISTA_PRODUCTOS, exigirAccion('productos_editar'), FX_PRODUCTOS, Productos.crear);
router.put('/productos/:id', [param('id').isInt({ min: 1 }), idNeg('body'), body('precio').optional().isFloat({ min: 0 })],
    VISTA_PRODUCTOS, exigirAccion('productos_editar'), FX_PRODUCTOS, Productos.actualizar);
router.patch('/productos/:id/inactivar', [param('id').isInt({ min: 1 }), idNeg()],
    VISTA_PRODUCTOS, exigirAccion('productos_editar'), FX_PRODUCTOS, Productos.inactivar);
router.post('/productos/:id/imagen', uploadImagen.single('imagen'), [param('id').isInt({ min: 1 }), idNeg('body')],
    VISTA_PRODUCTOS, exigirAccion('productos_editar'), FX_PRODUCTOS, Productos.subirImagen);
router.delete('/productos/:id/imagen', [param('id').isInt({ min: 1 }), idNeg()],
    VISTA_PRODUCTOS, exigirAccion('productos_editar'), FX_PRODUCTOS, Productos.eliminarImagen);

// Ventas de productos: mostrador (con o sin cita) y pedidos que llegaron del portal.
const productoItems = [
    body('items').isArray({ min: 1 }),
    body('items.*.id_producto').isInt({ min: 1 }),
    body('items.*.cantidad').optional().isFloat({ gt: 0 }),
];
const pagosVentaProducto = [
    body('id_metodo_pago').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('pagos').optional().isArray({ min: 1 }),
    body('pagos.*.id_metodo_pago').optional().isInt({ min: 1 }),
    body('pagos.*.valor').optional().isFloat({ gt: 0 }),
];
router.get('/ventas-productos', [
    idNeg(), query('estado').optional().isIn(['PENDIENTE', 'COMPLETADA', 'CANCELADA']),
    query('canal').optional().isIn(['MOSTRADOR', 'PORTAL']),
], VISTA_PRODUCTOS, FX_PRODUCTOS, VentaProductos.listar);
router.get('/ventas-productos/:id', [param('id').isInt({ min: 1 }), idNeg()],
    VISTA_PRODUCTOS, FX_PRODUCTOS, VentaProductos.getById);
router.post('/ventas-productos', [idNeg('body'), ...productoItems],
    VISTA_PRODUCTOS, exigirAccion('productos_vender'), FX_PRODUCTOS, VentaProductos.crear);
router.post('/ventas-productos/vender', [idNeg('body'), ...productoItems, ...pagosVentaProducto],
    VISTA_PRODUCTOS, exigirAccion('productos_vender'), FX_PRODUCTOS, VentaProductos.vender);
router.post('/ventas-productos/:id/cobrar', [param('id').isInt({ min: 1 }), idNeg('body'), ...pagosVentaProducto],
    VISTA_PRODUCTOS, exigirAccion('productos_vender'), FX_PRODUCTOS, VentaProductos.cobrar);
router.post('/ventas-productos/:id/cancelar', [param('id').isInt({ min: 1 }), idNeg('body')],
    VISTA_PRODUCTOS, exigirAccion('productos_vender'), FX_PRODUCTOS, VentaProductos.cancelar);

// ═════════ Estancias por noches (alojamiento, hotel de mascotas) ═════════
//
// Todo cuelga de la función `estancias` del perfil. Las acciones que mueven dinero o cierran la
// estancia llevan su propio permiso (`migrate_reserva_subniveles.js`).
const FX_ESTANCIAS = exigirFuncion('estancias');
const idParam = param('id').isInt({ min: 1 });
const pagosValidos = [
    body('id_metodo_pago').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('pagos').optional().isArray({ min: 1 }),
    body('pagos.*.id_metodo_pago').optional().isInt({ min: 1 }),
    body('pagos.*.valor').optional().isFloat({ gt: 0 }),
];

router.get('/estancias/disponibilidad', [idNeg(), fechaISO('entrada'), fechaISO('salida'), query('huespedes').optional().isInt({ min: 1 })],
    exigirVista('/estancias'), FX_ESTANCIAS, Estancias.disponibilidad);
router.get('/estancias/ocupacion', [idNeg(), fechaISO('desde'), fechaISO('hasta')],
    exigirVista('/ocupacion'), FX_ESTANCIAS, Estancias.ocupacion);
router.get('/estancias/resumen-dia', [idNeg()], FX_ESTANCIAS, Estancias.resumenDia);
router.get('/estancias/informe', [idNeg(), fechaISO('desde'), fechaISO('hasta')],
    exigirVista('/informes'), FX_ESTANCIAS, Estancias.informe);
router.get('/estancias', [
    idNeg(),
    query('desde').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    query('hasta').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    query('estado').optional().isIn(['pendiente', 'confirmada', 'en_curso', 'finalizada', 'cancelada', 'no_show']),
    query('q').optional().isString().isLength({ max: 80 }),
], exigirVista('/estancias'), FX_ESTANCIAS, Estancias.listar);
router.get('/estancias/:id', [idParam, idNeg()], FX_ESTANCIAS, Estancias.getById);
router.get('/estancias/:id/comprobante', [idParam, idNeg()], FX_ESTANCIAS, Estancias.comprobante);
router.post('/estancias', [
    idNeg('body'),
    body('id_unidad_tipo').isInt({ min: 1 }),
    body('id_unidad').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    fechaISO('fecha_entrada', body), fechaISO('fecha_salida', body),
    body('huespedes').optional().isInt({ min: 1, max: 50 }),
    body('cliente_nombre').trim().notEmpty().isLength({ max: 150 }),
    body('cliente_email').optional({ nullable: true, checkFalsy: true }).isEmail(),
    body('id_mascota').optional({ nullable: true, checkFalsy: true }).isUUID(),
], exigirAccion('estancias_crear'), FX_ESTANCIAS, Estancias.crear);
router.put('/estancias/:id', [
    idParam, idNeg('body'),
    body('fecha_entrada').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    body('fecha_salida').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    body('huespedes').optional().isInt({ min: 1, max: 50 }),
    body('id_unidad').optional().isInt({ min: 1 }),
], exigirAccion('estancias_crear'), FX_ESTANCIAS, Estancias.actualizar);
router.post('/estancias/:id/confirmar', [idParam, idNeg('body')], exigirAccion('estancias_crear'), FX_ESTANCIAS, Estancias.confirmar);
router.post('/estancias/:id/checkin', [idParam, idNeg('body')], exigirAccion('estancias_checkin'), FX_ESTANCIAS, Estancias.checkin);
router.post('/estancias/:id/no-show', [idParam, idNeg('body')], exigirAccion('estancias_checkin'), FX_ESTANCIAS, Estancias.noShow);
router.post('/estancias/:id/checkout', [idParam, idNeg('body'), ...pagosValidos],
    exigirAccion('estancias_checkout'), FX_ESTANCIAS, Estancias.checkout);
router.post('/estancias/:id/pagos', [idParam, idNeg('body'), ...pagosValidos, body('valor').optional().isFloat({ gt: 0 })],
    exigirAccion('estancias_checkout'), FX_ESTANCIAS, Estancias.registrarPago);
router.post('/estancias/:id/cargos', [
    idParam, idNeg('body'), body('concepto').trim().notEmpty().isLength({ max: 150 }), body('valor').isFloat({ gt: 0 }),
], exigirAccion('estancias_checkout'), FX_ESTANCIAS, Estancias.agregarCargo);
router.delete('/estancias/:id/cargos/:idCargo', [idParam, param('idCargo').isInt({ min: 1 }), idNeg()],
    exigirAccion('estancias_checkout'), FX_ESTANCIAS, Estancias.eliminarCargo);
router.post('/estancias/:id/cancelar', [idParam, idNeg('body'), body('motivo').optional({ nullable: true }).isString()],
    exigirAccion('estancias_cancelar'), FX_ESTANCIAS, Estancias.cancelar);
router.post('/estancias/:id/devolver', [idParam, idNeg('body'), body('valor').optional().isFloat({ gt: 0 }),
    body('id_metodo_pago').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 })],
exigirAccion('estancias_cancelar'), FX_ESTANCIAS, Estancias.devolver);
router.post('/estancias/:id/pago/aprobar', [idParam, idNeg('body'), body('id_metodo_pago').optional({ checkFalsy: true }).isInt({ min: 1 })],
    exigirAccion('estancias_validar_pago'), FX_ESTANCIAS, Estancias.aprobarPago);
router.post('/estancias/:id/pago/rechazar', [idParam, idNeg('body'), body('motivo').optional({ nullable: true }).isString()],
    exigirAccion('estancias_validar_pago'), FX_ESTANCIAS, Estancias.rechazarPago);

// Unidades: tipos (con tarifas y temporadas), unidades, bloqueos y calendarios externos.
const VISTA_UNIDADES = exigirVista('/unidades');
router.get('/unidades', [idNeg()], FX_ESTANCIAS, Estancias.unidadesListar);
router.post('/unidades/tipos', [
    idNeg('body'), body('nombre').trim().notEmpty().isLength({ max: 100 }),
    body('tarifa_base').isFloat({ min: 0 }), body('capacidad_max').optional().isInt({ min: 1, max: 50 }),
    body('cantidad').optional().isInt({ min: 1, max: 100 }), body('unidades').optional().isArray({ max: 100 }),
], VISTA_UNIDADES, exigirAccion('unidades_tarifas'), FX_ESTANCIAS, Estancias.tipoCrear);
router.put('/unidades/tipos/:id', [idParam, idNeg('body'), body('tarifa_base').optional().isFloat({ min: 0 })],
    VISTA_UNIDADES, exigirAccion('unidades_tarifas'), FX_ESTANCIAS, Estancias.tipoActualizar);
router.delete('/unidades/tipos/:id', [idParam, idNeg()], VISTA_UNIDADES, FX_ESTANCIAS, Estancias.tipoInactivar);
router.post('/unidades/tipos/:id/imagen', uploadImagen.single('imagen'), [idParam, idNeg('body')],
    VISTA_UNIDADES, FX_ESTANCIAS, Estancias.tipoImagen);
router.delete('/unidades/tipos/:id/imagen', [idParam, idNeg()], VISTA_UNIDADES, FX_ESTANCIAS, Estancias.tipoImagenEliminar);
router.post('/unidades/tipos/:id/temporadas', [
    idParam, idNeg('body'), body('nombre').trim().notEmpty().isLength({ max: 80 }),
    fechaISO('desde', body), fechaISO('hasta', body), body('precio_noche').isFloat({ min: 0 }),
    body('min_noches').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
], VISTA_UNIDADES, exigirAccion('unidades_tarifas'), FX_ESTANCIAS, Estancias.temporadaCrear);
router.put('/unidades/tipos/:id/temporadas/:idTarifa', [
    idParam, param('idTarifa').isInt({ min: 1 }), idNeg('body'),
    fechaISO('desde', body), fechaISO('hasta', body), body('precio_noche').isFloat({ min: 0 }),
], VISTA_UNIDADES, exigirAccion('unidades_tarifas'), FX_ESTANCIAS, Estancias.temporadaActualizar);
router.delete('/unidades/temporadas/:id', [idParam, idNeg()],
    VISTA_UNIDADES, exigirAccion('unidades_tarifas'), FX_ESTANCIAS, Estancias.temporadaEliminar);
router.post('/unidades/tipos/:id/unidades', [idParam, idNeg('body'), body('nombre').trim().notEmpty().isLength({ max: 60 })],
    VISTA_UNIDADES, FX_ESTANCIAS, Estancias.unidadCrear);
router.put('/unidades/:id', [idParam, idNeg('body')], VISTA_UNIDADES, FX_ESTANCIAS, Estancias.unidadActualizar);
router.delete('/unidades/:id', [idParam, idNeg()], VISTA_UNIDADES, FX_ESTANCIAS, Estancias.unidadInactivar);
router.post('/unidades/:id/ical-token', [idParam, idNeg('body')], VISTA_UNIDADES, FX_ESTANCIAS, Estancias.unidadToken);
router.post('/unidades/:id/bloqueos', [
    idParam, idNeg('body'), fechaISO('fecha_desde', body), fechaISO('fecha_hasta', body),
    body('motivo').optional({ nullable: true }).isString().isLength({ max: 255 }),
], exigirAccion('estancias_crear'), FX_ESTANCIAS, Estancias.bloqueoCrear);
router.delete('/unidades/bloqueos/:id', [idParam, idNeg()], exigirAccion('estancias_crear'), FX_ESTANCIAS, Estancias.bloqueoEliminar);
router.post('/unidades/:id/calendarios', [
    idParam, idNeg('body'), body('nombre').trim().notEmpty().isLength({ max: 60 }), body('url_ical').isURL({ protocols: ['https'] }),
], VISTA_UNIDADES, FX_ESTANCIAS, Estancias.calendarioCrear);
router.delete('/unidades/calendarios/:id', [idParam, idNeg()], VISTA_UNIDADES, FX_ESTANCIAS, Estancias.calendarioEliminar);
router.post('/unidades/sincronizar', [idNeg('body'), body('id_unidad').optional().isInt({ min: 1 })],
    FX_ESTANCIAS, Estancias.sincronizar);

// Configuración
router.get('/config', [query('id_negocio').isInt({ min: 1 })], Config.get);
router.put('/config', [
    body('id_negocio').isInt({ min: 1 }),
    // En minutos desde 2026-09-29 (hasta 7 días de anticipación; 30 días de ventana, que cubre
    // los alojamientos). Las de horas se siguen aceptando por compatibilidad: el modelo las
    // traduce a minutos.
    body('anticipacion_min_minutos').optional().isInt({ min: 0, max: 10080 }),
    body('ventana_cancelacion_min').optional().isInt({ min: 0, max: 43200 }),
    body('anticipacion_min_horas').optional().isInt({ min: 0, max: 168 }),
    body('buffer_limpieza_min').optional().isInt({ min: 0, max: 240 }),
    body('ventana_cancelacion_horas').optional().isInt({ min: 0, max: 720 }),
    body('paso_slot_min').optional().isInt({ min: 5, max: 60 }),
    body('cobro_adelantado').optional().isBoolean(),
    body('instrucciones_pago').optional({ nullable: true }).isString(),
    body('permite_cobro_profesional').optional().isBoolean(),
    body('permite_multipago').optional().isBoolean(),
    // Perfiles de rubro. `funciones` es `{ clave: boolean }` y el servicio lo valida contra el
    // perfil del negocio (una función de otro rubro se rechaza con 422).
    body('funciones').optional().isObject(),
    body('funciones.*').optional().isBoolean(),
    body('deposito_pct').optional().isInt({ min: 0, max: 100 }),
    body('deposito_reembolsable').optional().isBoolean(),
    body('hora_checkin').optional().matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/),
    body('hora_checkout').optional().matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/),
    // La lista sale del catálogo, no de una constante escrita aquí: ofrecer en la pantalla un
    // país que el normalizador de teléfonos no entiende es el fallo mudo que ya se pagó una vez.
    body('pais').optional({ nullable: true, checkFalsy: true })
        .isIn(paisesSoportados()).withMessage('País no soportado'),
], Config.actualizar);

module.exports = router;
