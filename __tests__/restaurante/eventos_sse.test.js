/**
 * El canal de avisos en vivo (SSE) de restaurante.
 *
 * Lo que estas pruebas sostienen —y son justo las tres formas en que esto puede salir mal:
 *
 *   1. **Un negocio NO oye lo de otro.** Es la razón por la que esta ruta comprueba la
 *      pertenencia ella misma en vez de confiar en `exigirPertenenciaNegocio`, que por defecto
 *      está en modo observación y deja pasar. Aquí no se responde una vez: se abre un grifo
 *      que va soltando la operación del negocio durante horas.
 *   2. **Un aviso emitido dentro de una transacción que se deshace no debe salir.** El Policy
 *      Gate de Intelligence simula pedidos y los revierte; si el aviso escapara, las pantallas
 *      correrían a buscar un pedido que nunca existió.
 *   3. **Un navegador muerto no puede tumbar un cobro.** `emitir()` se llama justo después de
 *      confirmar una operación de negocio: si escribir en un socket caído lanzara, el cobro
 *      fallaría por culpa de una tablet que alguien apagó.
 *
 * Se prueba contra el módulo y contra un servidor HTTP de verdad —no un `res` fingido—, porque
 * la mitad de lo que puede fallar aquí son las cabeceras y el cierre del socket, y eso un doble
 * no lo reproduce.
 */
'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const realtime = require('../../app_core/realtime');
const { avisar, avisarTrasCommit, TEMAS, CANAL } = require('../../app_restaurante_api/services/avisoService');
const Models = require('../../app_core/models/conection');

/** Abre una conexión SSE y va acumulando los eventos que llegan. */
function conectar(puerto, idNegocio) {
    return new Promise((resolve, reject) => {
        const req = http.get(
            { host: '127.0.0.1', port: puerto, path: `/eventos?id_negocio=${idNegocio}` },
            (res) => {
                const recibido = { estado: res.statusCode, eventos: [], crudo: '' };
                res.setEncoding('utf8');
                res.on('data', (trozo) => {
                    recibido.crudo += trozo;
                    for (const bloque of recibido.crudo.split('\n\n')) {
                        const m = /^event: (\w+)\ndata: (.*)$/m.exec(bloque);
                        if (m && !recibido.eventos.some((e) => e.bruto === bloque)) {
                            recibido.eventos.push({ tipo: m[1], datos: JSON.parse(m[2]), bruto: bloque });
                        }
                    }
                });
                resolve({ res, recibido, cerrar: () => req.destroy() });
            },
        );
        req.on('error', reject);
    });
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

describe('avisos en vivo del restaurante', () => {
    let servidor;
    let puerto;

    beforeAll((done) => {
        const app = express();
        // El servidor de prueba monta la ruta con un usuario ya resuelto: lo que se ejercita
        // aquí es el canal, no el JWT (que es el mismo `verificarToken` de todas las rutas).
        app.get('/eventos', (req, res) => {
            realtime.suscribir(req, res, { canal: CANAL, idNegocio: Number(req.query.id_negocio) });
        });
        servidor = http.createServer(app).listen(0, '127.0.0.1', () => {
            puerto = servidor.address().port;
            done();
        });
    });

    afterEach(() => realtime.cerrarTodo());

    afterAll((done) => {
        realtime.cerrarTodo();
        servidor.close(done);
    });

    test('al conectarse recibe la confirmación y queda contado', async () => {
        const cliente = await conectar(puerto, 12);
        await esperar(120);

        expect(cliente.recibido.estado).toBe(200);
        expect(cliente.res.headers['content-type']).toMatch(/text\/event-stream/);
        // Sin `no-transform` cualquier intermediario puede quedarse los avisos en un búfer.
        expect(cliente.res.headers['cache-control']).toMatch(/no-transform/);
        expect(cliente.recibido.eventos[0]).toMatchObject({ tipo: 'listo' });
        expect(realtime.contar(CANAL, 12)).toBe(1);

        cliente.cerrar();
        await esperar(120);
        expect(realtime.contar(CANAL, 12)).toBe(0);
    });

    test('el aviso llega a las pantallas de su negocio con los temas que cambiaron', async () => {
        const cliente = await conectar(puerto, 12);
        await esperar(120);

        const entregados = avisar(12, TEMAS.PEDIDOS, TEMAS.CAJA);
        await esperar(120);

        expect(entregados).toBe(1);
        const cambio = cliente.recibido.eventos.find((e) => e.tipo === 'cambio');
        expect(cambio.datos.temas).toEqual(['pedidos', 'caja']);

        cliente.cerrar();
    });

    test('lo de un negocio NO llega al otro', async () => {
        const mio = await conectar(puerto, 12);
        const ajeno = await conectar(puerto, 99);
        await esperar(120);

        avisar(12, TEMAS.PEDIDOS);
        await esperar(120);

        expect(mio.recibido.eventos.some((e) => e.tipo === 'cambio')).toBe(true);
        expect(ajeno.recibido.eventos.some((e) => e.tipo === 'cambio')).toBe(false);

        mio.cerrar();
        ajeno.cerrar();
    });

    test('avisar a un negocio sin nadie mirando no cuesta nada ni falla', () => {
        expect(avisar(4242, TEMAS.PEDIDOS)).toBe(0);
    });

    test('emitir nunca lanza, aunque le pasen basura', () => {
        expect(() => avisar(null, TEMAS.PEDIDOS)).not.toThrow();
        expect(() => avisar(12)).not.toThrow();
        expect(realtime.emitir({})).toBe(0);
    });

    describe('la transacción manda', () => {
        test('si la transacción confirma, el aviso sale', async () => {
            const cliente = await conectar(puerto, 12);
            await esperar(120);

            const t = await Models.sequelize.transaction();
            avisarTrasCommit(t, 12, TEMAS.PEDIDOS);
            // Todavía nada: el cambio aún puede deshacerse.
            await esperar(80);
            expect(cliente.recibido.eventos.some((e) => e.tipo === 'cambio')).toBe(false);

            await t.commit();
            await esperar(150);
            expect(cliente.recibido.eventos.some((e) => e.tipo === 'cambio')).toBe(true);

            cliente.cerrar();
        });

        test('si se deshace, el aviso NO sale (es el caso del dry-run del Policy Gate)', async () => {
            const cliente = await conectar(puerto, 12);
            await esperar(120);

            const t = await Models.sequelize.transaction();
            avisarTrasCommit(t, 12, TEMAS.PEDIDOS);
            await t.rollback();

            await esperar(200);
            expect(cliente.recibido.eventos.some((e) => e.tipo === 'cambio')).toBe(false);

            cliente.cerrar();
        });
    });

    test('un navegador que se fue no rompe la operación que estaba avisando', async () => {
        const cliente = await conectar(puerto, 12);
        await esperar(120);

        cliente.cerrar();
        await esperar(150);

        // El cobro que dispara este aviso tiene que terminar bien aunque no quede nadie oyendo.
        expect(() => avisar(12, TEMAS.CAJA)).not.toThrow();
        expect(realtime.contar(CANAL, 12)).toBe(0);
    });

    test('hay un tope de conexiones por negocio: al superarlo se rechaza, no se muere', async () => {
        const abiertas = [];
        for (let i = 0; i < realtime.MAX_POR_NEGOCIO; i += 1) {
            abiertas.push(await conectar(puerto, 77));
        }
        await esperar(200);
        expect(realtime.contar(CANAL, 77)).toBe(realtime.MAX_POR_NEGOCIO);

        const sobrante = await conectar(puerto, 77);
        expect(sobrante.estado ?? sobrante.recibido.estado).toBe(503);

        for (const c of abiertas) c.cerrar();
        sobrante.cerrar();
    });
});
