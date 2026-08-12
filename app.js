require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const db = require('./app_core/models/conection');
const adminRoutes = require('./app_admin_api/routes/index');
const restauranteRoutes = require('./app_restaurante_api/routes/index');
const parqueaderoRoutes = require('./app_parqueadero_api/routes/index');
const gymRoutes = require('./app_gym_api/routes/index');
const tiendaRoutes = require('./app_tienda_api/routes/index');
const reservaRoutes = require('./app_reserva_api/routes/index');
const { errorHandler, notFound } = require('./app_core/middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// ========================
// Seguridad y Middlewares
// ========================

// Detrás de Caddy (VPS Vultr) la IP del socket siempre es 127.0.0.1. Sin esto,
// req.ip es la del proxy y cualquier limitador por IP agrupa a TODOS los
// clientes en un mismo cubo. 1 = confiar sólo en el primer proxy (Caddy local).
app.set('trust proxy', 1);

// Protección de cabeceras HTTP
app.use(helmet());

// Logging de peticiones HTTP
if (process.env.NODE_ENV !== 'production') {
    app.use(morgan('dev'));
} else {
    app.use(morgan('combined'));
}

// ⚠️  CORS debe ir ANTES del rate limiter para que los headers
// Access-Control-Allow-Origin se incluyan incluso en respuestas 429.
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:4002,http://localhost:6002,http://localhost:4003,http://localhost:4004,http://localhost:4005,http://localhost:4006')
    .split(',')
    .map(o => o.trim());

app.use(cors({
    origin: (origin, callback) => {
        // Permitir peticiones sin origin (Postman, curl, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`CORS: origen no permitido — ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

// ⚠️  Rate limiting DESACTIVADO por defecto (migración AWS → VPS Vultr).
//
// En el VPS único todo el tráfico entra por Caddy, y el conteo por IP se hacía
// sobre la IP del proxy: los 200 req/15min de producción se repartían entre
// TODOS los clientes a la vez, no por usuario. Resultado: "Demasiadas
// peticiones" en el login de clientes legítimos.
//
// Se deja apagado hasta rediseñarlo para la nueva arquitectura (clave por
// usuario/negocio + almacén compartido, no en memoria del proceso).
// Para reactivarlo temporalmente: RATE_LIMIT_ENABLED=true en el .env
const rateLimitEnabled = process.env.RATE_LIMIT_ENABLED === 'true';
const isDev = process.env.NODE_ENV !== 'production';

if (rateLimitEnabled) {
    // Rate limiting global:
    //   - Producción: 200 peticiones por IP cada 15 min
    //   - Desarrollo:  2 000 peticiones por IP cada 15 min (SSR + HMR generan muchas)
    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: isDev ? 2000 : 200,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, message: 'Demasiadas peticiones, intente más tarde' }
    });
    app.use(limiter);

    // Rate limiting específico para login (más restrictivo)
    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 1000,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, message: 'Demasiados intentos de login, intente más tarde' }
    });
    app.use('/admin/auth/login', loginLimiter);
} else {
    console.log('⚠️  Rate limiting DESACTIVADO (RATE_LIMIT_ENABLED != true)');
}

// Parser JSON con límite de tamaño
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Contexto de auditoría por request (AsyncLocalStorage) — debe ir ANTES de las
// rutas para que las transacciones abiertas en services hereden el actor JWT.
const { auditContext } = require('./app_core/middleware/auditContext');
app.use(auditContext);

// ========================
// Archivos estáticos públicos
// ========================
// Imágenes del menú (carta) del restaurante. Se sirve SOLO esta subcarpeta
// (no todo /uploads) para no exponer comprobantes de pago ni reportes privados.
// CORP cross-origin: el menú digital vive en otro origen (escalapp.cloud) y
// debe poder cargar estas imágenes servidas desde api.escalapp.cloud.
app.use(
    '/uploads/restaurante/menu',
    express.static(path.join(__dirname, 'uploads', 'restaurante', 'menu'), {
        maxAge: '7d',
        setHeaders(res) {
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        },
    })
);

// ========================
// Rutas
// ========================
app.use('/admin', adminRoutes);
app.use('/restaurante', restauranteRoutes);
app.use('/parqueadero', parqueaderoRoutes);
app.use('/gym', gymRoutes);
app.use('/tienda', tiendaRoutes);
app.use('/reserva', reservaRoutes);

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

            // Iniciar scheduler de vencimientos de plan
            const planScheduler = require('./app_admin_api/services/planVencimientoScheduler');
            planScheduler.iniciar();

            // Iniciar scheduler de particiones de auditoría
            const auditScheduler = require('./app_core/helpers/auditParticionScheduler');
            auditScheduler.iniciar();
        });
    } catch (error) {
        console.error('Error al iniciar el servidor:', error.message);
        process.exit(1);
    }
})();