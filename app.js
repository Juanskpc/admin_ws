require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

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

// Se resuelve por petición (forma `cors(fn)`) para poder comparar el Origin con el host real
// que atendió la petición, cosa que la forma estática no permite.
app.use(cors((req, callback) => {
    // Una petición cuyo Origin es el propio servidor NO es cross-origin: el navegador ya la
    // permite y CORS no gobierna ese caso. Hay que declararlo porque el widget del WebChat se
    // sirve desde este mismo backend (/intelligence/webchat/) y Chrome manda Origin también en
    // un POST del mismo origen — así que el servidor se rechazaba a sí mismo. Meter
    // "http://localhost:3000" en el allowlist habría tapado el síntoma en local y repetido el
    // fallo en producción, donde el origen propio es otro. Detrás de Caddy esto depende de
    // `trust proxy` (ya activo más abajo) para que req.protocol sea el de fuera, no el interno.
    const origenPropio = `${req.protocol}://${req.headers.host}`;

    callback(null, {
        origin: (origin, cb) => {
            // Peticiones sin origin: Postman, curl, server-to-server.
            if (!origin) return cb(null, true);
            if (origin === origenPropio) return cb(null, true);
            if (allowedOrigins.includes(origin)) return cb(null, true);
            // Subdominio propio de un negocio (dalex-barberia.escalapp.cloud): son ilimitados y
            // se crean solos (ver migrate_negocio_slug.js), así que no pueden vivir en la lista
            // fija de CORS_ORIGIN — habría que tocarla por cada negocio nuevo, justo lo que esta
            // función existe para evitar. Solo HTTPS y solo bajo escalapp.cloud, nunca un dominio
            // cualquiera que decida llamarse igual.
            if (/^https:\/\/[a-z0-9-]+\.escalapp\.cloud$/i.test(origin)) return cb(null, true);

            const error = new Error(`CORS: origen no permitido — ${origin}`);
            error.code = 'CORS_ORIGEN_NO_PERMITIDO';
            // 403, no 500: un origen fuera del allowlist es un cliente equivocado, no una
            // avería del servidor. Como 500, ensuciaba los logs de errores y cualquier alerta
            // basada en 5xx con lo que en realidad es una configuración de frontend.
            error.statusCode = 403;
            cb(error);
        },
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true,
    });
}));

// Rate limiting — ENCENDIDO por defecto desde 2026-10-04.
//
// Estuvo apagado desde la migración a Vultr con el diagnóstico equivocado (se creyó que el
// conteo iba contra la IP de Caddy; no era eso, era que 200/15min queda por debajo del tráfico
// normal de un restaurante). El por qué completo, las mediciones que fijan los números y la
// razón de que el límite de login vaya aparte están en `app_core/middleware/limites.js`.
//
// Para apagarlo en una emergencia: RATE_LIMIT_ENABLED=false en el .env.

// ========================
// Los webhooks de cobranza van ANTES del rate limiter y del parser JSON
// ========================
// Dos motivos, ninguno estético (el detalle está en el propio router):
//   1. dLocal y Wompi firman el CUERPO CRUDO; `express.json()` se lo come y la firma deja de
//      casar. Mismo caso que el webhook de WhatsApp, más abajo.
//   2. El límite global es para humanos con navegador. Una pasarela reintentando una ráfaga lo
//      agota, se lleva un 429 y los pagos se quedan sin confirmar. El router trae su propio
//      límite, mucho más holgado.
app.use('/admin/cobranza/webhook', require('./app_admin_api/webhooks/cobranzaWebhook'));

// Apagado solo si se pide explícitamente: un `.env` al que le falte la variable debe quedar
// protegido, no a la intemperie. Es la elección contraria a la de antes, y a propósito.
const rateLimitEnabled = process.env.RATE_LIMIT_ENABLED !== 'false';
const isDev = process.env.NODE_ENV !== 'production';

if (rateLimitEnabled) {
    const { limitadorGeneral } = require('./app_core/middleware/limites');

    // En desarrollo el techo sube: SSR, recarga en caliente y las suites de pruebas generan
    // ráfagas que no se parecen en nada al uso real.
    app.use(limitadorGeneral({ max: isDev ? 20000 : undefined }));

    // El límite estrecho del login NO va aquí: necesita leer la identificación del cuerpo para
    // no dejar que quien prueba cédulas estrene cubo con cada una, y `express.json()` todavía no
    // ha corrido en este punto. Vive en `app_admin_api/routes/index.js`, sobre cada ruta de
    // autenticación.
    console.log('🛡️  Rate limiting activo (general por IP; el de login va en sus rutas)');
} else {
    console.log('⚠️  Rate limiting DESACTIVADO (RATE_LIMIT_ENABLED=false)');
}

// ========================
// El webhook de WhatsApp va ANTES del parser global (F8-A)
// ========================
// No es una preferencia de orden: Meta firma el **cuerpo crudo** con HMAC-SHA256, y
// `express.json()` lee los bytes, los parsea y los descarta. Reserializar el objeto produce
// otros bytes —otro orden de claves, otro escapado— así que la firma no casa y el canal entero
// queda inservible con un error que no menciona nada de esto. El master-plan lo anticipó:
// «hace falta una rama de parseo específica *antes* del parser global; es un cambio en la
// composición del servidor, no un detalle del gateway».
//
// Las mismas dos guardas que el resto de Intelligence, para que el test del apagón siga siendo
// literal: si el directorio no está, aquí no se monta nada.
const intelligenceDisponible =
    process.env.INTELLIGENCE_HTTP_ENABLED === 'true' &&
    require('fs').existsSync(path.join(__dirname, 'intelligence'));

if (intelligenceDisponible) {
    app.use('/intelligence/whatsapp/webhook', require('./intelligence/channels/whatsapp/rutas').router);
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

// Logos, fotos de servicio y fotos de profesional del vertical `reserva`. Igual que el menú: se
// exponen SOLO estas subcarpetas, nunca `/uploads/reserva` entero — ahí viven los comprobantes
// de pago, que son privados. Cross-origin porque la página pública se sirve desde otro dominio.
// `portafolio` y `unidades` son de los perfiles de rubro (trabajos de un tatuador, fotos de
// una habitación). Las fichas de clientes (`uploads/reserva/fichas`) NO se listan aquí: llevan
// consentimientos firmados y se descargan por una ruta con token.
// `servicios_galeria` son las fotos extra de un servicio (el carrusel de su detalle). Faltaba
// aquí desde que se creó la galería: los archivos se guardaban bien pero nadie los podía pedir,
// así que el navegador pintaba el icono de imagen rota tanto en el editor como en el portal.
for (const carpeta of ['logos', 'servicios', 'servicios_galeria', 'profesionales', 'banners', 'portafolio', 'unidades']) {
    app.use(
        `/uploads/reserva/${carpeta}`,
        express.static(path.join(__dirname, 'uploads', 'reserva', carpeta), {
            maxAge: '7d',
            setHeaders(res) {
                res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            },
        })
    );
}

// ========================
// Rutas
// ========================
app.use('/admin', adminRoutes);
app.use('/restaurante', restauranteRoutes);
app.use('/parqueadero', parqueaderoRoutes);
app.use('/gym', gymRoutes);
app.use('/tienda', tiendaRoutes);
app.use('/reserva', reservaRoutes);

// ========================
// EscalApp Intelligence — WebChat (OPCIONAL — ADR-005)
// ========================
// **TRES** guardas, y la tercera se añadió en F8-C (2026-08-22) resolviendo la decisión abierta 9:
//
//   1. El directorio tiene que existir. Es lo que mantiene LITERAL el test del apagón: se
//      borra `intelligence/` y el backend arranca igual, sin un require que reviente.
//   2. `INTELLIGENCE_HTTP_ENABLED=true` — el interruptor maestro de la superficie HTTP.
//   3. `INTELLIGENCE_WEBCHAT_ENABLED=true` — **solo el WebChat**, y apagado por defecto.
//
// ## Por qué hizo falta separarlas
//
// Hasta F8-C una sola bandera montaba dos cosas con riesgos muy distintos: el **webhook de
// WhatsApp**, autenticado por la firma HMAC de Meta, y el **WebChat**, que NO está autenticado —un
// widget lo usa un cliente final anónimo y solo lo protege la feature comercial del negocio—.
// Conectar el número real obligaba a encender el webhook, y con él se encendía el WebChat: la
// decisión abierta 9 en forma de efecto colateral.
//
// Separarlas es lo mínimo que resuelve eso sin inventar autenticación que nadie ha diseñado. En
// producción se enciende (2) y NO (3): el webhook vive y el WebChat **no existe** — no responde
// 403, no está la ruta, ni el widget estático ni el simulador de fallos, que es la superficie que
// peor se ve abierta (deja inyectar duplicados y retrasos en la sesión de cualquiera).
//
// Lo que falta para que el WebChat sea público de verdad —una clave pública por negocio, orígenes
// permitidos, un límite por sesión— sigue sin hacerse, y ahora se puede posponer sin que bloquee a
// WhatsApp. La Consola no depende de esto: vive en `/admin/intelligence/*` con `requireSuperAdmin`.
//
// La flecha de dependencia no cambia: ninguna vertical importa esto ni sabe que existe.
// El webhook de WhatsApp ya se montó arriba, antes del parser global: necesita el cuerpo crudo.
if (intelligenceDisponible && process.env.INTELLIGENCE_WEBCHAT_ENABLED === 'true') {
    app.use('/intelligence', require('./intelligence/http'));
    console.log('⚠️  WebChat de Intelligence ENCENDIDO y SIN AUTENTICAR (INTELLIGENCE_WEBCHAT_ENABLED=true)');
}

// Ruta de salud / health check
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'Admin WS funcionando correctamente',
        timestamp: new Date().toISOString()
    });
});

// ========================
// Sonda de salud REAL — para un monitor externo
// ========================
//
// `GET /` de arriba responde 200 mientras el proceso de Node esté vivo, y eso es justo lo que
// NO sirve para vigilar: el modo de fallo que de verdad tira el servicio es que la base no
// conteste —se cae PostgreSQL, se agota el pool, el disco se llena—, y en ese caso `/` sigue
// devolviendo 200 alegremente. Un monitor apuntado ahí nunca avisa de la avería que importa.
//
// Esta toca la base con la consulta más barata que existe y devuelve **503** si falla, porque
// es el código que todos los servicios de monitoreo entienden como «caído» sin configurar nada.
//
// Deliberadamente NO lleva autenticación y NO dice nada de dentro: ni versión, ni nombre de
// base, ni el mensaje de error de PostgreSQL. Un monitor externo necesita llegar sin
// credenciales, y el detalle del fallo se mira en `journalctl`, no se publica en internet.
app.get('/health', async (req, res) => {
    try {
        await db.sequelize.query('SELECT 1');
        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error('[health] La base no responde:', error.message);
        return res.status(503).json({ ok: false });
    }
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

            // Cobro automático de mensualidades. Nace apagado (COBRANZA_AUTO_ENABLED): un cron
            // que cobra de verdad no debe arrancar por heredar un .env — la primera vez que
            // cobre tiene que ser una decisión de una persona.
            const cobranzaScheduler = require('./app_admin_api/services/cobranzaScheduler');
            cobranzaScheduler.iniciar();

            // Importación de calendarios de Airbnb/Booking para alojamientos (cada 15 min). Sin
            // calendarios configurados no hace nada; se apaga con RESERVA_ICAL_ENABLED=false.
            require('./app_reserva_api/services/estancia/icalService').iniciar();

            // Modo de autorización multi-inquilino (ADR-002, ADR-010). Se anuncia siempre:
            // creer que se está bloqueando cuando solo se observa es el peor error posible aquí.
            const { describirModo } = require('./app_core/middleware/authzNegocio');
            console.log(describirModo());

            // Relay del outbox de eventos de dominio (ADR-012).
            //
            // El ÚNICO consumidor que existe hoy es el de recordatorios (F8-B), y lo registra
            // `intelligence.arrancarRecordatorios()`, que además llama a `relay.iniciar()`. Por
            // eso aquí solo se arranca cuando Intelligence NO está montado: el relay comprueba
            // los consumidores en `iniciar()`, así que llamarlo antes de registrarlos lo dejaba
            // inactivo para siempre — la tubería viva, y nadie bebiendo.
            if (!intelligenceDisponible) {
                require('./app_core/outbox/outboxRelay').iniciar();
            }

            // Conversation Engine + canales (F5-B, F5-C). Solo si el HTTP está encendido:
            // sin canal no puede entrarle un mensaje, así que arrancar el motor sería
            // encender un motor sin combustible.
            if (intelligenceDisponible) {
                const intelligence = require('./intelligence');

                // Registrar el catálogo va PRIMERO: el manejador determinista invoca
                // capacidades y sin esto el Policy Gate deniega con CAPACIDAD_NO_EXISTE.
                intelligence.arrancar();

                // Desde F5-D conduce la FSM determinista. Hasta 2026-08-13 esto seguía
                // montando el andamio de eco: el test e2e monta su propia composición
                // (`arrancar()` + `registrarManejador`) y nunca arranca este archivo, así que
                // la suite quedaba verde mientras el canal real contestaba «Recibí 1
                // mensaje(s)». Si algún día se añade otro manejador, este es el único sitio
                // donde se elige — el motor sigue sin decidir qué se contesta.
                // Desde F6 lo que se monta es la ESCALERA (ADR-018), no un manejador suelto:
                // Nivel 1 determinista siempre, Nivel 4 solo si hay credencial. Es el mismo
                // sitio y el mismo motivo que en F5-D — si esto vuelve a divergir de lo que
                // ejercitan los tests, el canal real contestará algo que la suite nunca vio.
                const escalera = intelligence.montarEscalera();

                intelligence
                    .arrancarMotor(escalera.manejador)
                    .then(() => {
                        const canales = intelligence.arrancarCanales();

                        // Los avisos que van al NEGOCIO y no a su cliente (2026-08-30). Hoy
                        // solo el del escalado: cuando el bot se calla y promete una persona,
                        // alguien tiene que enterarse — la Bandeja sola avisa únicamente a quien
                        // ya la está mirando. Registra el consumidor de `conversacion.escalada.v1`;
                        // sin esta línea es código muerto en el servidor real aunque la suite esté
                        // verde, que es la misma trampa que la de abajo.
                        //
                        // El orden respecto a la línea siguiente da igual (el relay lee sus
                        // consumidores en cada sondeo), pero va antes porque es antes en el tiempo:
                        // un escalado ocurre durante un turno, no dentro de una semana.
                        // Desde 2026-10-02 también vigila la **cuota de WhatsApp**: Meta cobra
                        // los mensajes de servicio pasada la asignación mensual de cada número, y
                        // sin esta revisión diaria la primera noticia sería la factura.
                        intelligence.arrancarAvisos();

                        // Recordatorios proactivos (F8-B). **Sin esta línea F8-B es código
                        // muerto en el servidor real:** aquí se registra el consumidor de
                        // `cita.creada.v1` en el relay del outbox, se enciende el relay —que
                        // llevaba inactivo desde F1 por no tener consumidores (ADR-013, regla
                        // 4)— y arranca el drenaje que relee la cita y manda la plantilla.
                        //
                        // Faltaba, y no lo cazó ni un test: la suite y `scripts/whatsapp_e2e.js`
                        // montan su propia composición y llaman a `arrancarRecordatorios()`
                        // ellos mismos, así que quedaban verdes mientras el servidor de verdad
                        // no programaba un solo recordatorio. Es exactamente la misma trampa
                        // que en F5-D con el manejador de eco: este archivo es el único sitio
                        // donde se compone de verdad, y nada lo ejercita.
                        //
                        // Va DESPUÉS de los canales a propósito: el drenaje escribe mensajes
                        // salientes y necesita el entregador ya en pie (mismo orden que el e2e).
                        intelligence.arrancarRecordatorios();
                        // El widget solo se anuncia si de verdad está montado. Anunciarlo
                        // siempre —como hacía hasta F8-C— manda a buscar una URL que devuelve
                        // 404, y peor: en producción hace creer que hay una superficie abierta
                        // que no existe, o que no la hay cuando sí. Un log que miente sobre lo
                        // que está expuesto es el que no puedes permitirte.
                        const webchatMontado = process.env.INTELLIGENCE_WEBCHAT_ENABLED === 'true';
                        console.log(
                            `[intelligence] HTTP en /intelligence — canal(es): ${canales.join(', ')}. ` +
                                `Escalera: nivel 1 + ${escalera.nivel4 || 'sin nivel 4'}. ` +
                                (webchatMontado
                                    ? 'Widget de pruebas en /intelligence/webchat/'
                                    : 'WebChat NO montado (INTELLIGENCE_WEBCHAT_ENABLED != true).')
                        );
                    })
                    .catch((error) => {
                        // Que Intelligence no arranque no puede tumbar el backend: es una
                        // capacidad opcional (ADR-005), no el producto.
                        console.error('[intelligence] No se pudo arrancar:', error.message);
                    });
            }
        });
    } catch (error) {
        // `error.message` puede venir vacio: pg deja ECONNREFUSED solo en `code` y Sequelize
        // copia el mensaje vacio tal cual, asi que el log salia como «Error al iniciar el
        // servidor:» a secas. Se imprime tambien el nombre y el codigo del error original.
        const codigo = error.original?.code || error.parent?.code || error.code;
        const detalle = [error.name, error.message, codigo && `(${codigo})`]
            .filter(Boolean)
            .join(' ');
        console.error('Error al iniciar el servidor:', detalle || error);
        if (codigo === 'ECONNREFUSED') {
            console.error(
                `  → No hay nadie escuchando en ${process.env.DB_HOST}:${process.env.DB_PORT}. ` +
                    'Si DB_PORT=5433 es la base compartida del VPS: abre el tunel con ' +
                    '`ssh -f -N -o ExitOnForwardFailure=yes -L 5433:localhost:5432 escalapp`.'
            );
        }
        process.exit(1);
    }
})();