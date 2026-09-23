const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const UsuarioController = require('../controllers/usuarioController');
const NegocioController = require('../controllers/negocioController');
const PlanController = require('../controllers/planController');
const RolController = require('../controllers/rolController');
const UsuarioAdminController = require('../controllers/usuarioAdminController');
const TipoNegocioController = require('../controllers/tipoNegocioController');
const { forgotPassword, forgotPasswordValidators } = require('../controllers/forgotPasswordController');
const { resetPassword, resetPasswordValidators }   = require('../controllers/resetPasswordController');
const { verifyOtp, verifyOtpValidators }           = require('../controllers/verifyOtpController');
const {
    enviarCodigo,
    enviarCodigoValidators,
    verificarCodigo,
    verificarCodigoValidators,
} = require('../controllers/registroVerificacionController');
const { verificarYCrear, verificarYCrearValidators } = require('../controllers/registroTrialController');
const SsoController = require('../controllers/ssoController');
const PaletaColorController = require('../controllers/paletaColorController');
const NotificacionController = require('../controllers/notificacionController');
const MetricasController = require('../controllers/metricasController');
const FichaPersonaController = require('../controllers/fichaPersonaController');
const AuditoriaController = require('../controllers/auditoriaController');
const DatosFiscalesController = require('../controllers/datosFiscalesController');
const CanalWhatsappController = require('../controllers/canalWhatsappController');
const CobranzaController = require('../controllers/cobranzaController');
const AdquirirController = require('../controllers/adquirirController');
const { verificarToken, requireSuperAdmin } = require('../../app_core/middleware/auth');
const rateLimit = require('express-rate-limit');

// Los países cuyos móviles sabemos pasar a E.164. La lista sale del propio normalizador para
// que añadir un país sea tocar un sitio y no dos. Ver app_core/helpers/telefono.js.
const PAISES = require('../../app_core/helpers/telefono').paisesSoportados();
const { paisesParaSeleccion } = require('../../app_core/helpers/paises');
const Respuesta = require('../../app_core/helpers/respuesta');

// ============================================================
// RUTAS PÚBLICAS (no requieren autenticación)
// ============================================================

// Login
router.post('/auth/login', [
    body('num_identificacion')
        .trim()
        .notEmpty().withMessage('El número de identificación es requerido'),
    body('password')
        .notEmpty().withMessage('La contraseña es requerida')
], UsuarioController.loginUsuario);

// Recuperar contraseña (genera OTP)
router.post('/auth/forgot-password', forgotPasswordValidators, forgotPassword);

// Verificar OTP (sin consumir el token — paso 1 del formulario de reset)
router.post('/auth/verify-otp', verifyOtpValidators, verifyOtp);

// Restablecer contraseña (verifica OTP y actualiza)
router.post('/auth/reset-password', resetPasswordValidators, resetPassword);

// Verificación de email para registro (landing page)
router.post('/auth/registro/enviar-codigo', enviarCodigoValidators, enviarCodigo);
router.post('/auth/registro/verificar-codigo', verificarCodigoValidators, verificarCodigo);

// Registro trial: verifica OTP y crea cuenta automáticamente
router.post('/auth/registro/prueba/verificar', verificarYCrearValidators, verificarYCrear);

// SSO de salida: canjea un código de un solo uso por la sesión del admin_app
// (permite volver al portal central autenticado desde una app vertical).
router.post('/auth/canjear-codigo', [
    body('code').trim().notEmpty().withMessage('El código es requerido'),
], SsoController.canjearCodigo);

// Rubros (público — la landing pinta sus chips con esto, sin sesión)
router.get('/rubros', TipoNegocioController.getRubros);

// Países con indicativo telefónico (público — es catálogo de plataforma, sin datos de nadie).
// Alimenta el selector de teléfono de la consola; la lista vive en helpers/paises.js.
router.get('/paises', (_req, res) => Respuesta.success(res, 'Países', paisesParaSeleccion()));

// Paletas de colores (públicas — para que la app del negocio cargue los colores)
router.get('/paletas', PaletaColorController.getListaPaletas);
router.get('/paletas/:id', PaletaColorController.paletaIdValidators, PaletaColorController.getPaletaById);
router.get('/negocios/:id/paleta', PaletaColorController.negocioIdValidators, PaletaColorController.getPaletaNegocio);

// --- Portal público de pagos: consultar y pagar la mensualidad SIN iniciar sesión ---
//
// Existe porque exigir login para pagar es la forma más eficaz de que no paguen. Pero una ruta
// que responde a «dame una cédula» es también una ruta que alguien puede recorrer con un bucle,
// así que lleva tres defensas, y ninguna es opcional:
//
//   1. **Su propio límite**, muy corto. El limitador global está APAGADO por defecto
//      (RATE_LIMIT_ENABLED), así que sin este cualquiera prueba cédulas a la velocidad de su red.
//   2. **POST y no GET**: la cédula viaja en el cuerpo y no en la URL, que es lo que acaba en los
//      logs de Caddy y de morgan.
//   3. **Respuesta mínima** (lo decide el servicio): nombre del negocio enmascarado, montos y
//      referencias. Ni correo, ni teléfono, ni fechas del plan. Y la misma forma de respuesta
//      exista o no la cédula, para no confirmarle a nadie quién es cliente nuestro.
//
// Y una cuarta que vive en el servicio y es la más importante: **pagar desde aquí nunca usa una
// tarjeta guardada**. Siempre abre un checkout donde el pagador pone su medio. Si no, bastaría
// con saberse la cédula de un cliente para cargarle un cobro.
const limitePortalPagos = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Demasiadas consultas. Intenta de nuevo en unos minutos.' },
});

const identificacionValidator = body('identificacion')
    .trim()
    .isLength({ min: 5, max: 20 }).withMessage('Número de identificación inválido')
    .matches(/^[0-9A-Za-z-]+$/).withMessage('Número de identificación inválido');

router.post('/publico/cobranza/consultar', limitePortalPagos, [
    identificacionValidator,
], CobranzaController.consultarPublico);

router.post('/publico/cobranza/pagar', limitePortalPagos, [
    identificacionValidator,
    body('referencia').trim().matches(/^EA-\d+-\d{6}$/).withMessage('Referencia inválida'),
    body('pasarela').isIn(['manual', 'dlocal', 'wompi']).withMessage('Medio de pago inválido'),
], CobranzaController.pagarPublico);

// ── Adquirir plan: comprar sin tener cuenta ──────────────────────────────────────────────
//
// Público por necesidad: quien compra todavía no es cliente y no tiene token. El límite es más
// estrecho que el del portal de pagos porque cada POST aquí **crea un usuario y un negocio**:
// cinco por cuarto de hora es de sobra para una persona comprando y poco para un script.
const limiteAdquirir = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' },
});

router.get('/publico/adquirir/catalogo', limitePortalPagos, AdquirirController.getCatalogo);

// Crear la cuenta, sin pagar todavía. La contraseña la elige el comprador y se valida como en
// el resto del sistema (8 caracteres, una mayúscula y un número).
router.post('/publico/adquirir/cuenta', limiteAdquirir, [
    body('nombres').trim().isLength({ min: 2, max: 60 }).withMessage('Nombres inválidos'),
    body('apellidos').trim().isLength({ min: 2, max: 60 }).withMessage('Apellidos inválidos'),
    body('num_identificacion').trim()
        .isLength({ min: 5, max: 20 }).withMessage('Número de identificación inválido')
        .matches(/^[0-9A-Za-z-]+$/).withMessage('Número de identificación inválido'),
    body('email').trim().isEmail().normalizeEmail().withMessage('Correo inválido'),
    body('password')
        .isLength({ min: 8 }).withMessage('La contraseña debe tener mínimo 8 caracteres')
        .matches(/(?=.*[A-Z])/).withMessage('La contraseña debe tener al menos una mayúscula')
        .matches(/(?=.*\d)/).withMessage('La contraseña debe tener al menos un número'),
    body('telefono').optional({ values: 'falsy' }).trim()
        .isLength({ min: 7, max: 20 }).withMessage('Teléfono inválido'),
    body('rubro').trim().isLength({ min: 2, max: 60 }).withMessage('Tipo de negocio inválido'),
    body('nombre_negocio').trim().isLength({ min: 2, max: 100 }).withMessage('Nombre del negocio inválido'),
    body('plan').trim().isLength({ min: 3, max: 60 }).withMessage('Plan inválido'),
    body('pasarela').optional().isIn(['dlocal', 'wompi']).withMessage('Medio de pago inválido'),
    body('complementos').optional().isArray({ max: 10 }).withMessage('Complementos inválidos'),
    body('complementos.*.codigo').isString().trim().isLength({ min: 2, max: 40 })
        .withMessage('Complemento inválido'),
    body('complementos.*.cantidad').isInt({ min: 0, max: 50 }).toInt()
        .withMessage('Cantidad de complemento inválida'),
], AdquirirController.postCuenta);

router.post('/publico/adquirir', limiteAdquirir, [
    body('nombres').trim().isLength({ min: 2, max: 60 }).withMessage('Nombres inválidos'),
    body('apellidos').trim().isLength({ min: 2, max: 60 }).withMessage('Apellidos inválidos'),
    body('num_identificacion').trim()
        .isLength({ min: 5, max: 20 }).withMessage('Número de identificación inválido')
        .matches(/^[0-9A-Za-z-]+$/).withMessage('Número de identificación inválido'),
    body('email').trim().isEmail().normalizeEmail().withMessage('Correo inválido'),
    body('telefono').optional({ values: 'falsy' }).trim()
        .isLength({ min: 7, max: 20 }).withMessage('Teléfono inválido'),
    body('rubro').trim().isLength({ min: 2, max: 60 }).withMessage('Tipo de negocio inválido'),
    body('nombre_negocio').trim().isLength({ min: 2, max: 100 }).withMessage('Nombre del negocio inválido'),
    body('plan').trim().isLength({ min: 3, max: 60 }).withMessage('Plan inválido'),
    body('pasarela').isIn(['dlocal', 'wompi']).withMessage('Medio de pago inválido'),
    // Los complementos son opcionales. Aquí solo se valida la forma; qué existe, cuánto cuesta y
    // el tope de cada uno lo decide el servicio contra el catálogo de la base.
    body('complementos').optional().isArray({ max: 10 }).withMessage('Complementos inválidos'),
    body('complementos.*.codigo').isString().trim().isLength({ min: 2, max: 40 })
        .withMessage('Complemento inválido'),
    body('complementos.*.cantidad').isInt({ min: 0, max: 50 }).toInt()
        .withMessage('Cantidad de complemento inválida'),
], AdquirirController.postCompra);

router.post('/publico/adquirir/reintentar', limitePortalPagos, [
    body('referencia').trim().matches(/^EA-\d+-\d{6}$/).withMessage('Referencia inválida'),
    body('pasarela').optional().isIn(['dlocal', 'wompi']).withMessage('Medio de pago inválido'),
], AdquirirController.postReintentar);

router.get('/publico/adquirir/estado/:referencia', limitePortalPagos, [
    param('referencia').trim().matches(/^EA-\d+-\d{6}$/).withMessage('Referencia inválida'),
], AdquirirController.getEstado);

// Vuelta desde el checkout con `?id=<transacción>`. El estado lo pregunta el backend a la
// pasarela; del navegador solo se acepta el id. Mismo límite que el resto del portal.
router.post('/publico/cobranza/confirmar', limitePortalPagos, [
    body('pasarela').isIn(['dlocal', 'wompi']).withMessage('Medio de pago inválido'),
    body('id_transaccion').trim().isLength({ min: 3, max: 120 })
        .matches(/^[A-Za-z0-9_-]+$/).withMessage('Transacción inválida'),
], CobranzaController.confirmarRetorno);

// ============================================================
// RUTAS PROTEGIDAS (requieren token JWT)
// ============================================================
router.use(verificarToken);

// Autorizacion multi-inquilino (ADR-002, ADR-010): verifica que el usuario del token
// pertenece al id_negocio que pide. Arranca en modo observacion (audita, no bloquea).
const { exigirPertenenciaNegocio } = require('../../app_core/middleware/authzNegocio');
router.use(exigirPertenenciaNegocio);

// --- Usuarios ---
router.post('/usuarios', [
    body('primer_nombre')
        .trim()
        .notEmpty().withMessage('El primer nombre es requerido')
        .isLength({ max: 100 }).withMessage('Máximo 100 caracteres'),
    body('primer_apellido')
        .trim()
        .notEmpty().withMessage('El primer apellido es requerido')
        .isLength({ max: 100 }).withMessage('Máximo 100 caracteres'),
    body('num_identificacion')
        .trim()
        .notEmpty().withMessage('El número de identificación es requerido'),
    // Opcional: el login va por identificación y el correo es solo un dato de contacto.
    body('email')
        .optional({ nullable: true, checkFalsy: true })
        .isEmail().withMessage('El email no es válido')
        .normalizeEmail(),
    body('password')
        .isLength({ min: 8 }).withMessage('La contraseña debe tener mínimo 8 caracteres')
        .matches(/(?=.*[A-Z])/).withMessage('La contraseña debe tener al menos una mayúscula')
        .matches(/(?=.*\d)/).withMessage('La contraseña debe tener al menos un número')
], UsuarioController.createUsuario);

router.get('/usuarios/perfil', UsuarioController.getPerfil);
router.put('/usuarios/perfil', [
    body('primer_nombre').trim().notEmpty().withMessage('El primer nombre es requerido').isLength({ max: 100 }),
    body('primer_apellido').trim().notEmpty().withMessage('El primer apellido es requerido').isLength({ max: 100 }),
    body('segundo_nombre').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('segundo_apellido').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('num_identificacion').trim().notEmpty().withMessage('El número de identificación es requerido'),
], UsuarioController.updatePerfil);
router.post('/auth/change-password', [
    body('currentPassword').notEmpty().withMessage('La contraseña actual es requerida'),
    body('newPassword').isLength({ min: 8 }).withMessage('Mínimo 8 caracteres')
        .matches(/(?=.*[A-Z])/).withMessage('Debe tener al menos una mayúscula')
        .matches(/(?=.*\d)/).withMessage('Debe tener al menos un número'),
], UsuarioController.changePassword);
router.get('/usuarios/mis-negocios-planes', UsuarioController.getMisNegociosPlanInfo);
router.get('/roles', UsuarioController.getListaRoles);


// --- Administración de usuarios y permisos ---
router.get('/usuarios/buscar', requireSuperAdmin, [
    query('q').optional().isString().isLength({ max: 100 }),
], UsuarioAdminController.buscarUsuarios);

// Impersonación: super admin obtiene un token de sesión de cualquier usuario (auditado)
router.post('/auth/impersonar', requireSuperAdmin, [
    body('id_usuario').notEmpty().withMessage('El id_usuario objetivo es requerido'),
], UsuarioController.impersonarUsuario);
router.get('/usuarios/admin', UsuarioAdminController.usuarioAdminValidators.list, UsuarioAdminController.listUsuarios);
router.post('/usuarios/admin', UsuarioAdminController.usuarioAdminValidators.create, UsuarioAdminController.createUsuario);
router.put('/usuarios/admin/:id', UsuarioAdminController.usuarioAdminValidators.update, UsuarioAdminController.updateUsuario);
router.put('/usuarios/admin/:id/perfil', UsuarioAdminController.usuarioAdminValidators.updatePerfil, UsuarioAdminController.updatePerfilUsuario);
router.patch('/usuarios/admin/:id/estado', UsuarioAdminController.usuarioAdminValidators.setEstado, UsuarioAdminController.setEstadoUsuario);
router.delete('/usuarios/admin/:id', UsuarioAdminController.usuarioAdminValidators.remove, UsuarioAdminController.deleteUsuario);
router.get('/usuarios/admin/:id/permisos', UsuarioAdminController.usuarioAdminValidators.getPermisosUsuario, UsuarioAdminController.getPermisosUsuario);

router.get('/roles/admin/lista', UsuarioAdminController.getRoles);
router.get('/roles/admin/:id/permisos', UsuarioAdminController.usuarioAdminValidators.getPermisosRol, UsuarioAdminController.getPermisosRol);
router.put('/roles/admin/:id/permisos', UsuarioAdminController.usuarioAdminValidators.savePermisosRol, UsuarioAdminController.savePermisosRol);

// --- Roles ---
router.get('/roles/lista', RolController.getListaRoles);
router.get('/roles/:id', [
    param('id').isInt({ min: 1 }).withMessage('ID de rol inválido')
], RolController.getRolById);
router.post('/roles', [
    body('descripcion')
        .trim()
        .notEmpty().withMessage('La descripción del rol es requerida')
        .isLength({ max: 255 }).withMessage('Máximo 255 caracteres'),
    body('id_tipo_negocio')
        .optional({ nullable: true })
        .isInt({ min: 1 }).withMessage('ID de tipo de negocio inválido')
], RolController.createRol);
router.patch('/roles/:id/inactivar', [
    param('id').isInt({ min: 1 }).withMessage('ID de rol inválido')
], RolController.inactivarRol);

// --- Negocios ---
router.get('/mis-negocios', NegocioController.getMisNegocios);
router.get('/negocios', NegocioController.getListaNegocios);
// '/negocios/admin' debe ir ANTES de '/negocios/:id' para no colisionar.
router.get('/negocios/admin', requireSuperAdmin, NegocioController.getListaNegociosAdmin);
router.get('/negocios/:id', [
    param('id').isInt({ min: 1 }).withMessage('ID de negocio inválido')
], NegocioController.getNegocioById);
router.post('/negocios', [
    body('nombre')
        .trim()
        .notEmpty().withMessage('El nombre del negocio es requerido'),
    body('email_contacto')
        .optional()
        .isEmail().withMessage('El email de contacto no es válido'),
    // El país decide cómo se normaliza el teléfono de los clientes del negocio
    // (app_core/helpers/telefono.js). Se restringe a los que sabemos normalizar.
    body('pais').optional({ nullable: true }).isIn(PAISES).withMessage('País no soportado'),
    body('id_rubro').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Rubro inválido')
], NegocioController.createNegocio);
router.patch('/negocios/:id/plan', requireSuperAdmin, [
    param('id').isInt({ min: 1 }).withMessage('ID de negocio inválido'),
    // `prueba: true` asigna la prueba de 7 días con el Plan Básico y no necesita id_plan.
    body('prueba').optional().isBoolean().withMessage('«prueba» debe ser verdadero o falso'),
    body('id_plan')
        .if((_, { req }) => req.body.prueba !== true && req.body.prueba !== 'true')
        .isInt({ min: 1 }).withMessage('ID de plan inválido'),
    body('meses').optional().isInt({ min: 1, max: 60 }).withMessage('La duración en meses no es válida'),
    body('fecha_inicio').optional({ nullable: true }).isISO8601().withMessage('Fecha de inicio inválida'),
    body('fecha_fin').optional({ nullable: true }).isISO8601().withMessage('Fecha de fin inválida')
], NegocioController.cambiarPlan);
router.put('/negocios/:id', requireSuperAdmin, [
    param('id').isInt({ min: 1 }).withMessage('ID de negocio inválido'),
    body('nombre').trim().notEmpty().withMessage('El nombre del negocio es requerido'),
    body('email_contacto').optional({ nullable: true }).isEmail().withMessage('Email de contacto inválido'),
    body('id_tipo_negocio').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Tipo de negocio inválido'),
    body('pais').optional({ nullable: true }).isIn(PAISES).withMessage('País no soportado'),
    body('id_rubro').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Rubro inválido')
], NegocioController.updateNegocio);
router.patch('/negocios/:id/estado', requireSuperAdmin, [
    param('id').isInt({ min: 1 }).withMessage('ID de negocio inválido'),
    body('estado').isIn(['A', 'I']).withMessage('Estado inválido')
], NegocioController.setEstadoNegocio);
// --- Datos fiscales del negocio (FE-1) ---
//
// El parámetro se llama `id_negocio` a propósito: `exigirPertenenciaNegocio` solo reconoce ese
// nombre, y por aquí pasan el NIT y la dirección fiscal del inquilino. Con `:id` —como el resto
// de rutas de negocio— quedarían fuera de esa comprobación. El controlador la repite a mano
// porque el middleware todavía va en modo observación.
router.get('/facturacion/catalogos', DatosFiscalesController.getCatalogos);

const idNegocioValidator = [
    param('id_negocio').isInt({ min: 1 }).withMessage('ID de negocio inválido'),
];

router.get(
    '/negocios/:id_negocio/datos-fiscales',
    idNegocioValidator,
    DatosFiscalesController.getDatosFiscales
);

// Todos los campos son opcionales: la ficha se llena en varias tandas, no de una sentada.
router.put(
    '/negocios/:id_negocio/datos-fiscales',
    [
        ...idNegocioValidator,
        body('tipo_persona').optional({ nullable: true })
            .isIn(['1', '2']).withMessage('Tipo de persona inválido (1 jurídica, 2 natural)'),
        body('tipo_documento').optional({ nullable: true })
            .isLength({ min: 2, max: 2 }).withMessage('Tipo de documento inválido'),
        body('numero_documento').optional({ nullable: true })
            .trim().isLength({ min: 5, max: 20 }).withMessage('Número de documento inválido'),
        body('dv').optional({ nullable: true })
            .matches(/^[0-9]$/).withMessage('El dígito de verificación es un solo número'),
        body('razon_social').optional({ nullable: true })
            .trim().isLength({ max: 255 }).withMessage('Razón social demasiado larga'),
        body('nombre_comercial').optional({ nullable: true }).trim().isLength({ max: 255 }),
        body('primer_apellido').optional({ nullable: true }).trim().isLength({ max: 100 }),
        body('segundo_apellido').optional({ nullable: true }).trim().isLength({ max: 100 }),
        body('primer_nombre').optional({ nullable: true }).trim().isLength({ max: 100 }),
        body('otros_nombres').optional({ nullable: true }).trim().isLength({ max: 100 }),
        // La lista definitiva de códigos sale del RUT y la publica cada proveedor; validamos
        // forma y tamaño, no un catálogo que no tenemos.
        body('responsabilidades_fiscales').optional({ nullable: true })
            .isArray({ max: 20 }).withMessage('Responsabilidades fiscales inválidas'),
        body('tributos').optional({ nullable: true })
            .isArray({ max: 10 }).withMessage('Tributos inválidos'),
        body('responsable_iva').optional({ nullable: true }).isBoolean(),
        body('responsable_inc').optional({ nullable: true }).isBoolean(),
        body('regimen').optional({ nullable: true })
            .isIn(['ORDINARIO', 'SIMPLE']).withMessage('Régimen inválido'),
        body('tipo_contribuyente').optional({ nullable: true })
            .isIn(['GRAN_CONTRIBUYENTE', 'DECLARANTE', 'NO_DECLARANTE'])
            .withMessage('Tipo de contribuyente inválido'),
        body('actividad_ciiu').optional({ nullable: true }).trim().isLength({ max: 10 }),
        body('matricula_mercantil').optional({ nullable: true }).trim().isLength({ max: 50 }),
        body('direccion_fiscal').optional({ nullable: true }).trim().isLength({ max: 255 }),
        body('municipio_dane').optional({ nullable: true })
            .matches(/^[0-9]{5}$/).withMessage('El municipio va en código DANE de 5 dígitos'),
        body('departamento_dane').optional({ nullable: true })
            .matches(/^[0-9]{2}$/).withMessage('El departamento va en código DANE de 2 dígitos'),
        body('codigo_postal').optional({ nullable: true }).trim().isLength({ max: 10 }),
        body('correo_facturacion').optional({ nullable: true })
            .isEmail().withMessage('Correo de facturación inválido'),
        body('telefono_facturacion').optional({ nullable: true }).trim().isLength({ max: 30 }),
    ],
    DatosFiscalesController.putDatosFiscales
);

// La declaración va aparte de los datos: no es lo mismo corregir una dirección que declarar la
// situación legal del negocio. Esta deja firma —quién y cuándo— porque es lo único que nos
// respalda si el cliente declara algo que no es.
router.put(
    '/negocios/:id_negocio/datos-fiscales/declaracion',
    [
        ...idNegocioValidator,
        body('estado_registro').optional({ nullable: true })
            .isIn(['NO_DECLARADO', 'SIN_REGISTRO', 'REGISTRADO'])
            .withMessage('Estado de registro inválido'),
        body('modo_facturacion').optional({ nullable: true })
            .isIn(['NINGUNO', 'POS', 'COMPLETO']).withMessage('Modo de facturación inválido'),
        body('obligado_a_facturar').optional({ nullable: true })
            .isBoolean().withMessage('«Obligado a facturar» debe ser verdadero o falso'),
    ],
    DatosFiscalesController.putDeclaracion
);

// --- Canal de WhatsApp propio (F8-D, Embedded Signup — Opción B del panel) ---
//
// Mismo motivo que datos-fiscales para nombrar el parámetro `id_negocio`: por aquí pasa el
// estado de conexión de un negocio y, al canjear, un secreto de Meta. Montada tras
// `verificarToken` (línea 136) — no es pública: el JWT del admin ya autentica, y el `code` de
// Meta caduca en 30s pero no reemplaza la sesión.
router.get(
    '/negocios/:id_negocio/canal-whatsapp',
    idNegocioValidator,
    CanalWhatsappController.getEstado
);

router.post(
    '/negocios/:id_negocio/canal-whatsapp/embedded-signup/canjear',
    [
        ...idNegocioValidator,
        body('code').trim().notEmpty().withMessage('Falta el code de Embedded Signup'),
        body('phoneNumberId').trim().notEmpty().withMessage('Falta el phoneNumberId'),
        body('numeroE164').optional({ nullable: true }).trim().isLength({ max: 20 }),
        body('businessId').optional({ nullable: true }).trim().isLength({ max: 100 }),
    ],
    CanalWhatsappController.postCanjear
);

router.post(
    '/negocios/:id_negocio/canal-whatsapp/desconectar',
    idNegocioValidator,
    CanalWhatsappController.postDesconectar
);

router.post('/negocios/registrar-cliente', requireSuperAdmin, [
    body('negocio.nombre').trim().notEmpty().withMessage('El nombre del negocio es requerido'),
    // Se acepta el oficio (`id_rubro`) o, por compatibilidad, el módulo a secas. El DAO
    // traduce lo que llegue; lo que no puede es faltar los dos.
    body('negocio.id_tipo_negocio').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Tipo de negocio inválido'),
    body('negocio.id_rubro').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Rubro inválido'),
    body('negocio').custom((v) => {
        if (!v?.id_rubro && !v?.id_tipo_negocio) throw new Error('El tipo de negocio es requerido');
        return true;
    }),
    body('negocio.email_contacto').optional({ nullable: true }).isEmail().withMessage('Email de contacto inválido'),
    // El país decide cómo se normaliza el teléfono de los clientes del negocio
    // (app_core/helpers/telefono.js). Se restringe a los que sabemos normalizar.
    body('negocio.pais').optional({ nullable: true }).isIn(PAISES).withMessage('País no soportado'),
    body('plan.id_plan').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Plan inválido'),
    body('plan.meses').optional({ nullable: true }).isInt({ min: 1, max: 60 }).withMessage('Duración inválida'),
    // Con plan: empieza aquí y dura `meses`. Sin plan: la prueba de 7 días empieza aquí.
    body('plan.fecha_inicio').optional({ nullable: true }).isISO8601().withMessage('Fecha de inicio inválida'),
    // Modo A: usuario existente
    body('id_usuario_existente').optional({ nullable: true }).isInt({ min: 1 }).withMessage('ID de usuario inválido'),
    // Modo B: crear usuario nuevo (campos requeridos solo cuando no viene id_usuario_existente)
    body('admin.primer_nombre')
        .if((_, { req }) => !req.body.id_usuario_existente)
        .trim().notEmpty().withMessage('El nombre del administrador es requerido'),
    body('admin.primer_apellido')
        .if((_, { req }) => !req.body.id_usuario_existente)
        .trim().notEmpty().withMessage('El apellido del administrador es requerido'),
    body('admin.num_identificacion')
        .if((_, { req }) => !req.body.id_usuario_existente)
        .trim().notEmpty().withMessage('La identificación del administrador es requerida'),
    // Opcional: el login va por identificación. Llega `null` cuando no se escribe correo, y sin
    // `optional` el `isEmail` lo rechazaba («Email del administrador inválido»).
    body('admin.email')
        .if((_, { req }) => !req.body.id_usuario_existente)
        .optional({ nullable: true, checkFalsy: true })
        .isEmail().withMessage('Email del administrador inválido'),
    body('admin.password')
        .if((_, { req }) => !req.body.id_usuario_existente)
        .isLength({ min: 8 }).withMessage('La contraseña debe tener mínimo 8 caracteres')
        .matches(/(?=.*[A-Z])/).withMessage('La contraseña debe tener al menos una mayúscula')
        .matches(/(?=.*\d)/).withMessage('La contraseña debe tener al menos un número'),
    // Validación cruzada: debe venir exactamente uno de los dos modos
    body().custom((_, { req }) => {
        if (!req.body.id_usuario_existente && !req.body.admin?.primer_nombre) {
            throw new Error('Debe crear un usuario nuevo o seleccionar uno existente');
        }
        return true;
    }),
], NegocioController.registrarCliente);

// --- Métricas (Super Admin) ---
router.get('/metricas/resumen', requireSuperAdmin, MetricasController.getResumen);

// --- Auditoría (Super Admin) ---
const auditoriaFiltrosComunes = [
    query('id_negocio').optional().isInt({ min: 1 }).withMessage('id_negocio inválido'),
    query('id_usuario').optional().isInt({ min: 1 }).withMessage('id_usuario inválido'),
    query('desde').optional().isISO8601().withMessage('Fecha desde inválida (YYYY-MM-DD)'),
    query('hasta').optional().isISO8601().withMessage('Fecha hasta inválida (YYYY-MM-DD)'),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
];
router.get('/auditoria/datos', requireSuperAdmin, [
    ...auditoriaFiltrosComunes,
    query('operacion').optional().isIn(['I', 'U', 'D', 'B']).withMessage('Operación inválida'),
], AuditoriaController.getDatos);
router.get('/auditoria/eventos', requireSuperAdmin, auditoriaFiltrosComunes, AuditoriaController.getEventos);
router.get('/auditoria/catalogo', requireSuperAdmin, AuditoriaController.getCatalogo);
router.get('/auditoria/datos/export', requireSuperAdmin, AuditoriaController.exportDatos);
router.get('/auditoria/eventos/export', requireSuperAdmin, AuditoriaController.exportEventos);

// --- Cobranza: el cobro de NUESTRAS mensualidades (docs/cobro-mensualidades.md) ---
//
// Dos audiencias:
//   - El ADMINISTRADOR del negocio ve y paga lo suyo (`mi-suscripcion`, `mis-cobros`, `pagar`). Sin
//     requireSuperAdmin, pero el controlador comprueba contra la base que el negocio sea suyo:
//     creerle al parámetro sería enseñarle la facturación de otro cliente.
//   - Todo lo que confirma dinero o cambia lo que se cobra es super-admin sin excepción.
//
// El webhook (`/admin/cobranza/webhook/:pasarela`) NO se declara aquí: va montado en app.js antes
// del parser JSON, porque las pasarelas firman el cuerpo crudo.
router.get('/cobranza/mi-suscripcion', [
    query('id_negocio').isInt({ min: 1 }).withMessage('id_negocio inválido'),
], CobranzaController.getMiSuscripcion);

router.get('/cobranza/mis-cobros', CobranzaController.getMisCobros);

// Lo que el negocio tiene contratado, en solo lectura, para el administrador del propio negocio.
router.get('/cobranza/mi-plan', [
    query('id_negocio').isInt({ min: 1 }).withMessage('id_negocio inválido'),
], CobranzaController.getMiPlan);

// Cambiar plan y/o complementos: lo hace el administrador del negocio desde «Mis pagos». Los dos
// campos son opcionales por separado —se puede cambiar solo el plan, solo los complementos, o
// ambos— pero al menos uno tiene que venir. La validación de qué existe y qué cuesta vive en el
// servicio; aquí solo la forma.
router.post('/cobranza/mi-plan', [
    body('id_negocio').isInt({ min: 1 }).withMessage('id_negocio inválido'),
    body('id_plan').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Plan inválido'),
    body('complementos').optional({ nullable: true }).isArray().withMessage('Complementos inválidos'),
    body('complementos.*.codigo').isString().trim().isLength({ min: 2, max: 40 }),
    body('complementos.*.cantidad').isInt({ min: 0, max: 99 }),
    body().custom((cuerpo) => {
        if (cuerpo.id_plan == null && !Array.isArray(cuerpo.complementos)) {
            throw new Error('Indica un plan, unos complementos, o los dos.');
        }
        return true;
    }),
], CobranzaController.elegirPlan);

router.post('/cobranza/facturas/:id/pagar', [
    param('id').isInt({ min: 1 }).withMessage('ID de factura inválido'),
    body('pasarela').isIn(['manual', 'dlocal', 'wompi']).withMessage('Medio de pago inválido'),
], CobranzaController.pagarFactura);

router.get('/cobranza/cartera', requireSuperAdmin, [
    query('estado').optional().isIn(['trial', 'activa', 'en_gracia', 'suspendida', 'cancelada'])
        .withMessage('Estado inválido'),
    query('q').optional().isString().trim().isLength({ max: 120 }).withMessage('Búsqueda inválida'),
], CobranzaController.getCartera);

router.get('/cobranza/ingresos', requireSuperAdmin, [
    query('meses').optional().isInt({ min: 1, max: 36 }).withMessage('Rango de meses inválido'),
], CobranzaController.getIngresos);

// Complementos de un negocio: cuántos tiene y cuántos se le cobran. Solo super-admin — es
// quien decide una cortesía, y cambia lo que el cliente paga cada mes.
router.get('/cobranza/negocios/:id_negocio/complementos', requireSuperAdmin, [
    param('id_negocio').isInt({ min: 1 }).withMessage('ID de negocio inválido'),
], CobranzaController.getComplementos);

router.put('/cobranza/negocios/:id_negocio/complementos', requireSuperAdmin, [
    param('id_negocio').isInt({ min: 1 }).withMessage('ID de negocio inválido'),
    body('complementos').isArray({ max: 20 }).withMessage('Complementos inválidos'),
    body('complementos.*.codigo').isString().trim().isLength({ min: 2, max: 40 })
        .withMessage('Complemento inválido'),
    body('complementos.*.cantidad').isInt({ min: 0, max: 100 }).toInt()
        .withMessage('Cantidad inválida'),
    body('complementos.*.cantidad_facturable').optional().isInt({ min: 0, max: 100 }).toInt()
        .withMessage('Cantidad a cobrar inválida'),
], CobranzaController.putComplementos);

router.put('/cobranza/negocios/:id_negocio/suscripcion', requireSuperAdmin, [
    param('id_negocio').isInt({ min: 1 }).withMessage('ID de negocio inválido'),
    body('id_plan').isInt({ min: 1 }).withMessage('Plan inválido'),
    body('ciclo').optional().isIn(['mensual', 'anual']).withMessage('Ciclo inválido'),
    body('moneda').optional().isLength({ min: 3, max: 3 }).withMessage('Moneda inválida (ISO 4217)'),
    body('pasarela').optional().isString().trim().isLength({ max: 20 }).withMessage('Pasarela inválida'),
    body('es_retenedor').optional().isBoolean().withMessage('es_retenedor debe ser booleano'),
    body('dia_cobro').optional({ nullable: true }).isInt({ min: 1, max: 31 }).withMessage('Día de cobro inválido'),
    body('notas').optional({ nullable: true }).isString().isLength({ max: 2000 }).withMessage('Notas demasiado largas'),
], CobranzaController.configurarSuscripcion);

router.post('/cobranza/negocios/:id_negocio/facturas', requireSuperAdmin, [
    param('id_negocio').isInt({ min: 1 }).withMessage('ID de negocio inválido'),
    body('desde').optional({ nullable: true }).isISO8601().withMessage('Fecha de inicio inválida (YYYY-MM-DD)'),
], CobranzaController.generarFactura);

// Confirmar un pago extiende el acceso del cliente: es la operación más delicada del módulo.
// `comision_pasarela` y `retencion_declarada` se teclean, no se calculan — nosotros constatamos
// lo que pasó en el banco, no lo suponemos (docs/obligaciones-escalapp.md §3).
router.post('/cobranza/facturas/:id/pago-manual', requireSuperAdmin, [
    param('id').isInt({ min: 1 }).withMessage('ID de factura inválido'),
    body('fecha_pago').optional({ nullable: true }).isISO8601().withMessage('Fecha de pago inválida'),
    body('medio_pago_texto').optional({ nullable: true }).isString().trim().isLength({ max: 120 })
        .withMessage('Medio de pago inválido'),
    body('comision_pasarela').optional().isFloat({ min: 0 }).withMessage('Comisión inválida'),
    body('retencion_declarada').optional().isFloat({ min: 0 }).withMessage('Retención inválida'),
    body('numero_factura').optional({ nullable: true }).isString().trim().isLength({ max: 40 })
        .withMessage('Número de factura inválido'),
    body('cufe').optional({ nullable: true }).isString().trim().isLength({ max: 120 }).withMessage('CUFE inválido'),
    body('nota').optional({ nullable: true }).isString().isLength({ max: 2000 }).withMessage('Nota demasiado larga'),
], CobranzaController.registrarPagoManual);

// Cobrar por la pasarela: el «reintentar» de la consola y la forma de probar una pasarela nueva
// sin esperar al cron.
router.post('/cobranza/facturas/:id/cobrar', requireSuperAdmin, [
    param('id').isInt({ min: 1 }).withMessage('ID de factura inválido'),
], CobranzaController.cobrarFactura);

router.post('/cobranza/facturas/:id/anular', requireSuperAdmin, [
    param('id').isInt({ min: 1 }).withMessage('ID de factura inválido'),
    body('motivo').isString().trim().isLength({ min: 3, max: 500 })
        .withMessage('El motivo de la anulación es obligatorio'),
], CobranzaController.anularFactura);

// Confirmar un pago de Wompi por el id de su transacción: para probar en local (el webhook y la
// vuelta con ?id= no llegan a localhost) y para el cliente que pagó y cuyo webhook se perdió.
router.post('/cobranza/wompi/verificar', requireSuperAdmin, [
    body('id_transaccion').trim().isLength({ min: 3, max: 120 })
        .matches(/^[A-Za-z0-9_-]+$/).withMessage('Transacción inválida'),
], CobranzaController.verificarPagoWompi);

// --- Tipos de Negocio ---
router.get('/tipos-negocio', TipoNegocioController.getListaTiposNegocio);
router.get('/tipos-negocio/:id', [
    param('id').isInt({ min: 1 }).withMessage('ID de tipo de negocio inválido')
], TipoNegocioController.getTipoNegocioById);
router.post('/tipos-negocio', requireSuperAdmin, [
    body('nombre')
        .trim()
        .notEmpty().withMessage('El nombre del tipo de negocio es requerido')
        .isLength({ max: 100 }).withMessage('Máximo 100 caracteres'),
    body('descripcion').optional({ nullable: true }).trim().isLength({ max: 255 }),
    body('icono').optional({ nullable: true }).trim().isLength({ max: 50 }),
    body('color_hex').optional({ nullable: true }).trim()
        .matches(/^#?[0-9A-Fa-f]{3,8}$/).withMessage('Color hexadecimal inválido'),
], TipoNegocioController.createTipoNegocio);

// --- Planes ---
router.get('/planes', PlanController.getListaPlanes);
router.post('/planes', [
    body('nombre')
        .trim()
        .notEmpty().withMessage('El nombre del plan es requerido'),
    body('precio')
        .optional()
        .isDecimal().withMessage('El precio debe ser un número válido')
], PlanController.createPlan);
router.put('/planes/:id', [
    param('id').isInt({ min: 1 }).withMessage('ID de plan inválido')
], PlanController.updatePlan);
router.patch('/planes/:id/inactivar', [
    param('id').isInt({ min: 1 }).withMessage('ID de plan inválido')
], PlanController.inactivarPlan);

// --- Paletas de colores (asignación, protegida) ---
router.patch('/negocios/:id/paleta', PaletaColorController.assignPaletaValidators, PaletaColorController.assignPaletaNegocio);

// --- Notificaciones ---
router.get('/mis-notificaciones', NotificacionController.getMisNotificaciones);
router.get('/mis-notificaciones/no-leidas', NotificacionController.contarMisNoLeidas);
router.get('/notificaciones/:id_negocio', [
    param('id_negocio').isInt({ min: 1 }).withMessage('ID de negocio inválido')
], NotificacionController.getNotificaciones);
router.get('/notificaciones/no-leidas/:id_negocio', [
    param('id_negocio').isInt({ min: 1 }).withMessage('ID de negocio inválido')
], NotificacionController.contarNoLeidas);
router.put('/notificaciones/:id_notificacion/leida', [
    param('id_notificacion').isInt({ min: 1 }).withMessage('ID de notificación inválido'),
    body('id_negocio').isInt({ min: 1 }).withMessage('ID de negocio inválido')
], NotificacionController.marcarLeida);
router.put('/notificaciones/leer-todas/:id_negocio', [
    param('id_negocio').isInt({ min: 1 }).withMessage('ID de negocio inválido')
], NotificacionController.marcarTodasLeidas);

// --- Ficha 360 de personas (platform.persona_negocio) — solo lectura, Super Admin ---
router.get('/personas', requireSuperAdmin, [
    query('id_negocio').optional().isInt({ min: 1 }).withMessage('ID de negocio inválido'),
    query('q').optional().isLength({ max: 100 }).withMessage('Búsqueda demasiado larga'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Límite inválido'),
    query('offset').optional().isInt({ min: 0 }).withMessage('Offset inválido'),
], FichaPersonaController.listarPersonas);

router.get('/personas/:id/ficha', requireSuperAdmin, [
    param('id').isUUID().withMessage('ID de persona inválido'),
], FichaPersonaController.getFicha);

// --- Intelligence Console (F5-E) — solo lectura, Super Admin ---
// Lee el esquema `intelligence` con SQL y NO importa `intelligence/`: el test del apagón de
// ADR-005 sigue siendo literal (borrar ese directorio deja el backend, y esta consola, en pie).
const IntelligenceConsolaController = require('../controllers/intelligenceConsolaController');

const consolaFiltrosComunes = [
    query('id_negocio').optional().isInt({ min: 1 }).withMessage('ID de negocio inválido'),
    query('desde').optional().isISO8601().withMessage('Fecha "desde" inválida'),
    query('hasta').optional().isISO8601().withMessage('Fecha "hasta" inválida'),
];

router.get('/intelligence/conversaciones', requireSuperAdmin, [
    ...consolaFiltrosComunes,
    query('canal').optional().isLength({ max: 40 }).withMessage('Canal inválido'),
    query('estado').optional().isLength({ max: 30 }).withMessage('Estado inválido'),
    query('con_error').optional().isIn(['true', 'false']).withMessage('con_error debe ser true o false'),
    query('q').optional().isLength({ max: 100 }).withMessage('Búsqueda demasiado larga'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Límite inválido'),
    query('offset').optional().isInt({ min: 0 }).withMessage('Offset inválido'),
], IntelligenceConsolaController.listarConversaciones);

router.get('/intelligence/conversaciones/:id', requireSuperAdmin, [
    param('id').isUUID().withMessage('ID de conversación inválido'),
], IntelligenceConsolaController.detalleConversacion);

router.get('/intelligence/metricas', requireSuperAdmin, consolaFiltrosComunes,
    IntelligenceConsolaController.metricas);

// La única escritura de la Consola (F8-B). Un STOP es irrevocable por el cliente a propósito,
// así que deshacer una baja puesta por error exige un humano — y que quede quién y por qué.
router.post('/intelligence/conversaciones/:id/desbloquear', requireSuperAdmin, [
    param('id').isUUID().withMessage('ID de conversación inválido'),
    body('motivo').trim().isLength({ min: 5, max: 300 })
        .withMessage('El motivo es obligatorio (5 a 300 caracteres)'),
], IntelligenceConsolaController.desbloquearConversacion);

// --- Bandeja del inquilino ---
// Las mismas conversaciones, pero para el dueño del negocio y CON respuesta humana. No lleva
// `requireSuperAdmin`: el alcance lo decide `alcanceDeNegocios()` dentro del controlador,
// cruzando el usuario del token contra sus negocios. El `id_negocio` de la petición nunca se
// cree — es la frontera entre dos clientes.
const IntelligenceBandejaController = require('../controllers/intelligenceBandejaController');

router.get('/intelligence/bandeja/conversaciones', [
    query('id_negocio').optional().isInt({ min: 1 }).withMessage('ID de negocio inválido'),
    query('solo_escaladas').optional().isIn(['true', 'false'])
        .withMessage('solo_escaladas debe ser true o false'),
    query('limite').optional().isInt({ min: 1, max: 100 }).withMessage('Límite inválido'),
], IntelligenceBandejaController.listarConversaciones);

router.get('/intelligence/bandeja/conversaciones/:id', [
    param('id').isUUID().withMessage('ID de conversación inválido'),
], IntelligenceBandejaController.detalleConversacion);

// El texto se limita a 4096 porque es el máximo que acepta un mensaje de WhatsApp: cortarlo
// aquí es decirlo a tiempo, en vez de que Meta lo rechace cuando ya nadie mira.
router.post('/intelligence/bandeja/conversaciones/:id/responder', [
    param('id').isUUID().withMessage('ID de conversación inválido'),
    body('texto').isString().trim().isLength({ min: 1, max: 4096 })
        .withMessage('El texto es obligatorio (1 a 4096 caracteres)'),
], IntelligenceBandejaController.responder);

// «Ya me ocupé de esto», sin escribir nada. No todo lo que el bot escala se resuelve por el
// chat: se llama al cliente, o se le atiende en el local. NO devuelve la conversación al bot
// (ADR-023): solo deja de contar como pendiente.
router.post('/intelligence/bandeja/conversaciones/:id/atender', [
    param('id').isUUID().withMessage('ID de conversación inválido'),
], IntelligenceBandejaController.atender);

// «Ya terminé, que siga el asistente». Es el ÚNICO camino del sistema que devuelve una
// conversación escalada al bot, y existe por la Enmienda 1 de ADR-023: lo prohibido es que el bot
// vuelva SOLO, no que una persona se lo devuelva a sabiendas. Nada automático puede llamar aquí.
router.post('/intelligence/bandeja/conversaciones/:id/devolver-al-asistente', [
    param('id').isUUID().withMessage('ID de conversación inválido'),
], IntelligenceBandejaController.devolverAlAsistente);

// «Este número abusa del sistema»: el negocio le cierra la puerta al asistente sin que el
// cliente haya escrito STOP. Distinto de la baja legal —ver el comentario del controlador—,
// por eso el negocio SÍ puede deshacer su propio bloqueo con `desbloquear`, cosa que no puede
// hacer con un STOP real.
router.post('/intelligence/bandeja/conversaciones/:id/bloquear', [
    param('id').isUUID().withMessage('ID de conversación inválido'),
    body('motivo').optional().isString().trim().isLength({ max: 300 }),
], IntelligenceBandejaController.bloquear);

router.post('/intelligence/bandeja/conversaciones/:id/desbloquear', [
    param('id').isUUID().withMessage('ID de conversación inválido'),
], IntelligenceBandejaController.desbloquear);

module.exports = router;