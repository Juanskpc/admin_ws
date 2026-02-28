const express = require('express');
const { param } = require('express-validator');
const router = express.Router();

const DashboardController = require('../controllers/dashboardController');
const { verificarToken } = require('../../app_core/middleware/auth');

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

module.exports = router;
