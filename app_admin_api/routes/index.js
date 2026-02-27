const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();

const UsuarioController = require('../controllers/usuarioController');
const NegocioController = require('../controllers/negocioController');
const PlanController = require('../controllers/planController');
const { verificarToken } = require('../../app_core/middleware/auth');

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

// ============================================================
// RUTAS PROTEGIDAS (requieren token JWT)
// ============================================================
router.use(verificarToken);

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
    body('email')
        .isEmail().withMessage('El email no es válido')
        .normalizeEmail(),
    body('password')
        .isLength({ min: 8 }).withMessage('La contraseña debe tener mínimo 8 caracteres')
        .matches(/(?=.*[A-Z])/).withMessage('La contraseña debe tener al menos una mayúscula')
        .matches(/(?=.*\d)/).withMessage('La contraseña debe tener al menos un número')
], UsuarioController.createUsuario);

router.get('/usuarios/perfil', UsuarioController.getPerfil);
router.get('/roles', UsuarioController.getListaRoles);

// --- Negocios ---
router.get('/negocios', NegocioController.getListaNegocios);
router.get('/negocios/:id', [
    param('id').isInt({ min: 1 }).withMessage('ID de negocio inválido')
], NegocioController.getNegocioById);
router.post('/negocios', [
    body('nombre')
        .trim()
        .notEmpty().withMessage('El nombre del negocio es requerido'),
    body('email_contacto')
        .optional()
        .isEmail().withMessage('El email de contacto no es válido')
], NegocioController.createNegocio);

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

module.exports = router;