require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const db = require('./app_core/models/conection');
const adminRoutes = require('./app_admin_api/routes/index');
const restauranteRoutes = require('./app_restaurante_api/routes/index');
const { errorHandler, notFound } = require('./app_core/middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// ========================
// Seguridad y Middlewares
// ========================

// Protección de cabeceras HTTP
app.use(helmet());

// Logging de peticiones HTTP
if (process.env.NODE_ENV !== 'production') {
    app.use(morgan('dev'));
} else {
    app.use(morgan('combined'));
}

// Rate limiting global: máx 100 peticiones por IP cada 15 min
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Demasiadas peticiones, intente más tarde' }
});
app.use(limiter);

// Rate limiting específico para login (más restrictivo): máx 10 intentos cada 15 min
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Demasiados intentos de login, intente más tarde' }
});
app.use('/admin/auth/login', loginLimiter);

// CORS configurado para los frontends Angular (admin + negocio)
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:4002,http://localhost:6002')
    .split(',')
    .map(o => o.trim());

app.use(cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Parser JSON con límite de tamaño
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ========================
// Rutas
// ========================
app.use('/admin', adminRoutes);
app.use('/restaurante', restauranteRoutes);

// Ruta de salud / health check
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'Admin WS funcionando correctamente',
        timestamp: new Date().toISOString()
    });
});

// ========================
// Manejo de errores
// ========================
app.use(notFound);
app.use(errorHandler);

// ========================
// Conexión a BD y arranque del servidor
// ========================
(async () => {
    try {
        await db.sequelize.authenticate();
        console.log('Conectado correctamente a la base de datos');

        app.listen(PORT, () => {
            console.log(`Servidor corriendo en: http://localhost:${PORT}`);
            console.log(`Entorno: ${process.env.NODE_ENV || 'development'}`);

            // Verificar SMTP al arrancar (solo en development)
            if (process.env.NODE_ENV !== 'production' && process.env.MAIL_USER) {
                const { verifyTransport } = require('./app_admin_api/services/mailService');
                verifyTransport();
            }
        });
    } catch (error) {
        console.error('Error al iniciar el servidor:', error.message);
        process.exit(1);
    }
})();