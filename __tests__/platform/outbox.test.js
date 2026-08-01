/**
 * Tests del outbox transaccional (ADR-012).
 *
 * Van contra la BD local a propósito. Las garantías que justifican este patrón —que el
 * evento exista si y solo si la transacción de dominio confirmó, el backoff, el dead
 * letter— son propiedades del motor, no de JavaScript: con mocks no se probaría nada.
 *
 * Requiere una BD local con el esquema platform y un negocio id=1:
 *   npm run migrate:platform-persona && npm run migrate:platform-outbox
 *   node scripts/seed_dev_local.js
 *
 * Correr con:  npx jest __tests__/platform/outbox.test.js --runInBand
 */
require('dotenv').config();
const db = require('../../app_core/models/conection');
const outboxDao = require('../../app_core/dao/outboxDao');
const relay = require('../../app_core/outbox/outboxRelay');

const sequelize = db.sequelize;
const NEGOCIO = 1;
const TIPO = 'prueba.emitida.v1';
const OTRO_TIPO = 'prueba.ignorada.v1';

async function limpiar() {
    await sequelize.query(`DELETE FROM platform.outbox WHERE tipo LIKE 'prueba.%';`);
}

async function leer(idEvento) {
    const [[fila]] = await sequelize.query(
        `SELECT * FROM platform.outbox WHERE id_evento = :id;`,
        { replacements: { id: idEvento } }
    );
    return fila;
}

/** Deja el evento listo para el siguiente intento sin esperar al backoff real. */
async function adelantarBackoff(idEvento) {
    await sequelize.query(
        `UPDATE platform.outbox SET proximo_intento_en = now() - interval '1 second'
          WHERE id_evento = :id;`,
        { replacements: { id: idEvento } }
    );
}

beforeEach(async () => {
    relay.limpiarConsumidores();
    await limpiar();
});

afterAll(async () => {
    relay.detener();
    await limpiar();
    await sequelize.close();
});

describe('outboxDao.emitir', () => {
    it('exige transacción: emitir sin ella es un error de uso, no un fallback', async () => {
        await expect(
            outboxDao.emitir({ tipo: TIPO, idNegocio: NEGOCIO })
        ).rejects.toThrow(/requiere una transacción/i);
    });

    it.each([
        ['citaCreada', 'camelCase'],
        ['cita.creada', 'sin versión'],
        ['Cita.Creada.v1', 'con mayúsculas'],
        ['cita.creada.v', 'versión vacía'],
        ['cita.creada.v1.extra', 'segmento de más'],
    ])('rechaza el tipo "%s" (%s)', async (tipo) => {
        // try/finally: si la aserción falla, la transacción DEBE cerrarse igualmente. Sin
        // esto, un test roto deja una transacción abierta que bloquea a todos los demás.
        const t = await sequelize.transaction();
        try {
            await expect(
                outboxDao.emitir({ tipo, idNegocio: NEGOCIO }, { transaction: t })
            ).rejects.toThrow(/Tipo de evento inválido/);
        } finally {
            await t.rollback();
        }
    });

    it('valida la FORMA del nombre, no el idioma: "compra.realizada.v1" pasa y un nombre en inglés bien formado también', async () => {
        // La convención de ADR-013 exige español, pero eso ninguna expresión regular puede
        // comprobarlo. La base garantiza la forma <agregado>.<hecho>.v<n>; que el nombre
        // esté en español es una regla humana, se sostiene en la revisión del catálogo.
        const t = await sequelize.transaction();
        try {
            await expect(
                outboxDao.emitir({ tipo: 'prueba.realizada.v1', idNegocio: NEGOCIO }, { transaction: t })
            ).resolves.toEqual(expect.any(String));
        } finally {
            await t.rollback();
        }
    });

    it('ATOMICIDAD: si la transacción de dominio revierte, el evento no existe', async () => {
        const t = await sequelize.transaction();
        let id;
        try {
            id = await outboxDao.emitir(
                { tipo: TIPO, idNegocio: NEGOCIO, payload: { x: 1 } },
                { transaction: t }
            );
        } finally {
            await t.rollback();
        }

        expect(await leer(id)).toBeUndefined();
    });

    it('ATOMICIDAD: si la transacción confirma, el evento existe y queda pendiente', async () => {
        const t = await sequelize.transaction();
        let id;
        try {
            id = await outboxDao.emitir(
                { tipo: TIPO, idNegocio: NEGOCIO, payload: { id_orden: 7 } },
                { transaction: t }
            );
            await t.commit();
        } catch (error) {
            await t.rollback();
            throw error;
        }

        const fila = await leer(id);
        expect(fila.estado).toBe('pendiente');
        expect(fila.intentos).toBe(0);
        expect(fila.payload).toEqual({ id_orden: 7 });
        expect(fila.id_negocio).toBe(NEGOCIO);
    });

    it('la base también rechaza un tipo mal formado (defensa en profundidad)', async () => {
        await expect(
            sequelize.query(
                `INSERT INTO platform.outbox (tipo, id_negocio) VALUES ('MalNombre', :n);`,
                { replacements: { n: NEGOCIO } }
            )
        ).rejects.toThrow(/chk_outbox_tipo/);
    });
});

describe('relay', () => {
    async function emitirEvento(tipo = TIPO, payload = {}) {
        const t = await sequelize.transaction();
        try {
            const id = await outboxDao.emitir(
                { tipo, idNegocio: NEGOCIO, payload },
                { transaction: t }
            );
            await t.commit();
            return id;
        } catch (error) {
            await t.rollback();
            throw error;
        }
    }

    it('sin consumidores no marca nada: los eventos siguen pendientes, no se pierden', async () => {
        const id = await emitirEvento();

        const res = await relay.drenarUnaVez();

        expect(res).toEqual({ procesados: 0, entregados: 0, fallidos: 0 });
        expect((await leer(id)).estado).toBe('pendiente');
    });

    it('entrega el evento al consumidor y lo marca como entregado', async () => {
        const recibidos = [];
        relay.registrarConsumidor('prueba', { manejar: async (e) => recibidos.push(e) });
        const id = await emitirEvento(TIPO, { id_orden: 42 });

        const res = await relay.drenarUnaVez();

        expect(res.entregados).toBe(1);
        expect(recibidos).toHaveLength(1);
        expect(recibidos[0].tipo).toBe(TIPO);
        expect(recibidos[0].payload).toEqual({ id_orden: 42 });

        const fila = await leer(id);
        expect(fila.estado).toBe('entregado');
        expect(fila.entregado_en).not.toBeNull();
    });

    it('un evento ya entregado no se vuelve a entregar', async () => {
        let veces = 0;
        relay.registrarConsumidor('contador', { manejar: async () => { veces++; } });
        await emitirEvento();

        await relay.drenarUnaVez();
        await relay.drenarUnaVez();

        expect(veces).toBe(1);
    });

    it('respeta el patrón: un consumidor solo recibe los tipos que le interesan', async () => {
        const recibidos = [];
        relay.registrarConsumidor('selectivo', {
            patron: [TIPO],
            manejar: async (e) => recibidos.push(e.tipo),
        });
        await emitirEvento(TIPO);
        await emitirEvento(OTRO_TIPO);

        await relay.drenarUnaVez();

        expect(recibidos).toEqual([TIPO]);
    });

    it('si el consumidor falla, reprograma con backoff en vez de perder el evento', async () => {
        relay.registrarConsumidor('roto', {
            manejar: async () => { throw new Error('caída simulada'); },
        });
        const id = await emitirEvento();

        const res = await relay.drenarUnaVez();

        expect(res.fallidos).toBe(1);
        const fila = await leer(id);
        expect(fila.estado).toBe('pendiente');
        expect(fila.intentos).toBe(1);
        expect(fila.ultimo_error).toMatch(/consumidor "roto".*caída simulada/);
        expect(new Date(fila.proximo_intento_en).getTime()).toBeGreaterThan(Date.now());
    });

    it('tras agotar los reintentos manda el evento a dead letter', async () => {
        const maxOriginal = relay.CONFIG.maxIntentos;
        relay.CONFIG.maxIntentos = 3;
        try {
            relay.registrarConsumidor('roto', {
                manejar: async () => { throw new Error('siempre falla'); },
            });
            const id = await emitirEvento();

            for (let i = 0; i < 3; i++) {
                await relay.drenarUnaVez();
                await adelantarBackoff(id);
            }

            const fila = await leer(id);
            expect(fila.estado).toBe('fallido');
            expect(fila.intentos).toBe(3);
        } finally {
            relay.CONFIG.maxIntentos = maxOriginal;
        }
    });

    it('un evento en dead letter ya no se reintenta solo', async () => {
        relay.CONFIG.maxIntentos = 1;
        let veces = 0;
        try {
            relay.registrarConsumidor('roto', {
                manejar: async () => { veces++; throw new Error('falla'); },
            });
            const id = await emitirEvento();

            await relay.drenarUnaVez();
            expect((await leer(id)).estado).toBe('fallido');

            await adelantarBackoff(id);
            await relay.drenarUnaVez();

            expect(veces).toBe(1);
        } finally {
            relay.CONFIG.maxIntentos = 6;
        }
    });

    it('con dos consumidores, si uno falla el evento se reintenta entero (entrega ≥1 vez)', async () => {
        const okRecibio = [];
        let fallarSiguiente = true;
        relay.registrarConsumidor('bueno', { manejar: async (e) => okRecibio.push(e.id_evento) });
        relay.registrarConsumidor('inestable', {
            manejar: async () => {
                if (fallarSiguiente) { fallarSiguiente = false; throw new Error('fallo transitorio'); }
            },
        });
        const id = await emitirEvento();

        await relay.drenarUnaVez();
        expect((await leer(id)).estado).toBe('pendiente');

        await adelantarBackoff(id);
        await relay.drenarUnaVez();

        expect((await leer(id)).estado).toBe('entregado');
        // El consumidor sano lo recibió DOS veces: por eso ADR-012 exige idempotencia.
        expect(okRecibio).toEqual([id, id]);
    });

    it('un evento problemático no impide entregar el resto del lote', async () => {
        relay.registrarConsumidor('selectivo', {
            manejar: async (e) => {
                if (e.payload.malo) throw new Error('este no');
            },
        });
        const malo = await emitirEvento(TIPO, { malo: true });
        const bueno = await emitirEvento(TIPO, { malo: false });

        const res = await relay.drenarUnaVez();

        expect(res).toMatchObject({ procesados: 2, entregados: 1, fallidos: 1 });
        expect((await leer(bueno)).estado).toBe('entregado');
        expect((await leer(malo)).estado).toBe('pendiente');
    });
});
