/**
 * Límites de peticiones (auditoría 2026-10-04).
 *
 * El limitador llevaba apagado desde agosto, así que el login no tenía ningún freno — con
 * cuentas cuya contraseña es la cédula, eso es probar cédulas hasta acertar. Se vuelve a
 * encender con dos techos distintos y números medidos sobre tráfico real; el razonamiento está
 * en `app_core/middleware/limites.js`.
 *
 * Lo que se prueba aquí es sobre todo **la forma de la clave**, que es donde fallan los
 * limitadores de login: agrupar solo por identificación deja que quien prueba cédulas estrene
 * cubo con cada intento, y agrupar solo por IP deja a un local entero fuera por culpa de un
 * compañero despistado.
 *
 * Ejecutar: npx jest __tests__/authz/limites.test.js --forceExit
 */
'use strict';

const express = require('express');
const {
    limitadorGeneral,
    limitadorAutenticacion,
    claveIp,
    SIN_LIMITE,
} = require('../../app_core/middleware/limites');

/**
 * Un servidor mínimo con el limitador puesto, para hablarle con `fetch`.
 *
 * `estado` es lo que contesta la ruta protegida, y en estas pruebas no es un detalle: el
 * limitador de credenciales solo cuenta las respuestas que NO son 2xx, así que para ver si
 * frena hay que devolver 401 como lo haría un login con la contraseña mal. Con 200 no cuenta
 * nada — exactamente el fallo que estas pruebas encontraron en la primera versión.
 */
function servidorCon(middleware, ruta = '/probar', estado = 401) {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(middleware);
    app.post(ruta, (req, res) => res.status(estado).json({ ok: estado < 400 }));
    app.post('/admin/cobranza/webhook', (req, res) => res.status(200).json({ ok: true }));

    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                server,
                async pedir(cuerpo = {}, { ip = '203.0.113.7', path = ruta } = {}) {
                    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
                        body: JSON.stringify(cuerpo),
                    });
                    return res.status;
                },
                cerrar: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

describe('claveIp', () => {
    test('una IPv4 se usa tal cual', () => {
        expect(claveIp({ ip: '191.95.163.11' })).toBe('191.95.163.11');
    });

    // Un cliente con IPv6 tiene direcciones de sobra del mismo prefijo: sin agrupar, estrena
    // cubo con cada petición y el límite no sirve de nada.
    test('dos IPv6 del mismo /64 comparten cubo', () => {
        const a = claveIp({ ip: '2001:db8:85a3:1::8a2e:370:7334' });
        const b = claveIp({ ip: '2001:db8:85a3:1::ffff:1' });
        expect(a).toBe(b);
    });

    test('dos IPv6 de prefijos distintos no', () => {
        const a = claveIp({ ip: '2001:db8:85a3:1::1' });
        const b = claveIp({ ip: '2001:db8:85a3:2::1' });
        expect(a).not.toBe(b);
    });
});

describe('límite de autenticación', () => {
    let ctx;
    afterEach(async () => { if (ctx) await ctx.cerrar(); ctx = null; });

    test('al tercer fallo con la misma cédula desde la misma IP responde 429', async () => {
        ctx = await servidorCon(limitadorAutenticacion({ max: 2 }), '/auth/login');

        const cuerpo = { num_identificacion: '1004437516', password: 'mal' };
        expect(await ctx.pedir(cuerpo, { path: '/auth/login' })).toBe(401);
        expect(await ctx.pedir(cuerpo, { path: '/auth/login' })).toBe(401);
        expect(await ctx.pedir(cuerpo, { path: '/auth/login' })).toBe(429);
    });

    // Es el agujero clásico: quien recorre un listado de cédulas manda una distinta cada vez.
    // Si la clave fuera solo la identificación, nunca gastaría un cubo.
    test('cambiar de cédula NO estrena cubo: la IP sigue contando', async () => {
        // El techo por IP es el que corta aquí: cada cédula tiene su propio cubo por cuenta,
        // así que sin el cubo por IP esto no se pararía nunca.
        process.env.RATE_LIMIT_AUTH_IP_MAX = '2';
        ctx = await servidorCon(limitadorAutenticacion({ max: 50 }), '/auth/login');
        delete process.env.RATE_LIMIT_AUTH_IP_MAX;

        expect(await ctx.pedir({ num_identificacion: '111' }, { path: '/auth/login' })).toBe(401);
        expect(await ctx.pedir({ num_identificacion: '222' }, { path: '/auth/login' })).toBe(401);
        expect(await ctx.pedir({ num_identificacion: '333' }, { path: '/auth/login' })).toBe(429);
    });

    // Y la otra mitad: un local con varios equipos tras el mismo NAT no se queda fuera porque
    // un compañero se equivoque de contraseña.
    test('otra IP tiene su propio cubo', async () => {
        ctx = await servidorCon(limitadorAutenticacion({ max: 1 }), '/auth/login');

        const cuerpo = { num_identificacion: '111' };
        expect(await ctx.pedir(cuerpo, { path: '/auth/login', ip: '198.51.100.1' })).toBe(401);
        expect(await ctx.pedir(cuerpo, { path: '/auth/login', ip: '198.51.100.1' })).toBe(429);
        expect(await ctx.pedir(cuerpo, { path: '/auth/login', ip: '198.51.100.2' })).toBe(401);
    });

    // Entrar bien no acerca al límite: un cajero que abre sesión en tres equipos no se queda
    // fuera del cuarto.
    test('los aciertos no cuentan en las rutas de credenciales', async () => {
        ctx = await servidorCon(limitadorAutenticacion({ max: 1 }), '/auth/login', 200);

        const cuerpo = { num_identificacion: '111' };
        for (let i = 0; i < 5; i += 1) {
            expect(await ctx.pedir(cuerpo, { path: '/auth/login' })).toBe(200);
        }
    });
});

/**
 * Las rutas que MANDAN CORREO se cuentan al revés, y es la diferencia que hacía inútil la
 * primera versión de este limitador: `forgot-password` y `registro/enviar-codigo` responden 200
 * cuando el correo sale, así que contando solo fallos pedir mil códigos era gratis. Lo que se
 * agota ahí no es CPU: es la cuota de envío de la cuenta de correo.
 */
describe('límite de los códigos por correo', () => {
    let ctx;
    afterEach(async () => { if (ctx) await ctx.cerrar(); ctx = null; });

    test('un acierto SÍ cuenta: pedir códigos en ráfaga se corta', async () => {
        ctx = await servidorCon(
            limitadorAutenticacion({ max: 2, contarAciertos: true }),
            '/auth/registro/enviar-codigo',
            200
        );

        const cuerpo = { email: 'alguien@correo.com' };
        const path = '/auth/registro/enviar-codigo';
        expect(await ctx.pedir(cuerpo, { path })).toBe(200);
        expect(await ctx.pedir(cuerpo, { path })).toBe(200);
        expect(await ctx.pedir(cuerpo, { path })).toBe(429);
    });

    test('cambiar de correo tampoco estrena cubo', async () => {
        ctx = await servidorCon(
            limitadorAutenticacion({ max: 2, contarAciertos: true }),
            '/auth/registro/enviar-codigo',
            200
        );

        // Aquí la clave es solo la IP, justo para que cambiar de correo no sirva de nada.
        const path = '/auth/registro/enviar-codigo';
        expect(await ctx.pedir({ email: 'a@a.com' }, { path })).toBe(200);
        expect(await ctx.pedir({ email: 'b@b.com' }, { path })).toBe(200);
        expect(await ctx.pedir({ email: 'c@c.com' }, { path })).toBe(429);
    });
});

describe('límite general', () => {
    let ctx;
    afterEach(async () => { if (ctx) await ctx.cerrar(); ctx = null; });

    // El general cuenta TODO, acierto o fallo: es una red para abuso, no un control de login.
    test('corta cuando se pasa del techo', async () => {
        ctx = await servidorCon(limitadorGeneral({ max: 2 }), '/probar', 200);

        expect(await ctx.pedir()).toBe(200);
        expect(await ctx.pedir()).toBe(200);
        expect(await ctx.pedir()).toBe(429);
    });

    // Una pasarela reintentando en ráfaga se llevaría un 429 justo cuando no se le puede
    // fallar: lo que se pierde es la confirmación de un pago. Van firmados con HMAC, que
    // protege más que contar peticiones.
    test('los webhooks quedan fuera del conteo', async () => {
        ctx = await servidorCon(limitadorGeneral({ max: 1 }), '/probar', 200);

        for (let i = 0; i < 5; i += 1) {
            expect(await ctx.pedir({}, { path: '/admin/cobranza/webhook' })).toBe(200);
        }
    });

    test('la lista de exentos incluye las dos entradas firmadas', () => {
        expect(SIN_LIMITE).toContain('/admin/cobranza/webhook');
        expect(SIN_LIMITE).toContain('/intelligence/whatsapp/webhook');
    });
});
