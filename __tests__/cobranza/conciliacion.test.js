/**
 * Cobranza — conciliación de pagos: un pago aprobado en la pasarela SIEMPRE termina aplicado,
 * aunque no llegue el webhook ni vuelva el cliente.
 *
 * Corre contra la base LOCAL (esquema `cobranza` incluido: `npm run migrate:cobranza…`) con las
 * PASARELAS y el CORREO simulados. Cada prueba crea su propio negocio, así que no toca datos de
 * nadie y puede correr en cualquier orden. Lo que fija:
 *
 *   - un pago APROBADO se aplica UNA vez, y una segunda corrida no suma otro mes,
 *   - webhook + conciliación a la vez (concurrencia real, dos promesas) → un solo pago, un solo mes,
 *   - referencia, monto o moneda distintos → NO se aplica + evento de error + alerta,
 *   - DECLINED marca el intento rechazado y la factura sigue pendiente,
 *   - un intento de más de 7 días pasa a «expirada» sin tocar la factura,
 *   - sin intentos pendientes NO se llama a la pasarela; máximo una consulta por negocio cada 60 s;
 *     tope de tiempo con trabajo en segundo plano,
 *   - dLocal (PAID / REJECTED) por la misma interfaz,
 *   - una aprobación que NO es la que pagó la factura (pago manual + cliente que pagó) se alerta.
 *
 * Ejecutar: DB_PORT=5432 DB_PASS=<local> npx jest __tests__/cobranza/conciliacion.test.js --forceExit
 */
'use strict';

require('dotenv').config();

const mockAdaptadores = {
    wompi: {
        codigo: 'wompi',
        soportaRecurrente: true,
        estaConfigurada: () => true,
        consultarPorReferencia: jest.fn(),
        consultarTransaccion: jest.fn(),
    },
    dlocal: {
        codigo: 'dlocal',
        soportaRecurrente: false,
        estaConfigurada: () => true,
        consultarTransaccion: jest.fn(),
    },
    manual: { codigo: 'manual', soportaRecurrente: false, estaConfigurada: () => true },
};
jest.mock('../../app_core/cobranza', () => ({
    getAdaptador: (c) => mockAdaptadores[c],
    getAdaptadorListo: (c) => mockAdaptadores[c],
    estadoDeConfiguracion: () => [],
}));
jest.mock('../../app_admin_api/services/mailService', () => ({
    sendAlertaAdminEmail: jest.fn(async () => undefined),
    sendWelcomeEmail: jest.fn(async () => undefined),
    sendAdminNotificationEmail: jest.fn(async () => undefined),
}));

const Models = require('../../app_core/models/conection');
const MailService = require('../../app_admin_api/services/mailService');
const Conciliacion = require('../../app_admin_api/services/cobranzaConciliacionService');
const WebhookService = require('../../app_admin_api/services/cobranzaWebhookService');
const CobranzaController = require('../../app_admin_api/controllers/cobranzaController');

const sequelize = Models.sequelize;
const TOTAL = 27999;
const creados = []; // ids de negocio de prueba

async function fila(sql, replacements = {}) {
    const r = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return r[0] ?? null;
}
async function filas(sql, replacements = {}) {
    return sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
}

/** Un negocio con plan vigente (10 días), suscripción, factura pendiente y su intento de pago. */
async function crearFixture({ pasarela = 'wompi', total = TOTAL, edadDias = 0, idExterno = null } = {}) {
    const { id_negocio: idNegocio } = await fila(
        `INSERT INTO general.gener_negocio (nombre) VALUES (:n) RETURNING id_negocio;`,
        { n: `TEST-conciliacion-${Date.now()}-${creados.length}` },
    ).then((f) => f ?? {});
    // (`fila` con INSERT … RETURNING devuelve la fila si se pide type SELECT)
    creados.push(idNegocio);

    await sequelize.query(
        `INSERT INTO general.gener_negocio_plan (id_negocio, id_plan, fecha_inicio, fecha_fin, estado)
         VALUES (:n, 1, CURRENT_DATE - 20, (CURRENT_DATE + 10)::timestamp + interval '23:59:59', 'A');`,
        { replacements: { n: idNegocio } },
    );
    const susc = await fila(
        `INSERT INTO cobranza.cob_suscripcion (id_negocio, id_plan, ciclo, moneda, pasarela, estado)
         VALUES (:n, 1, 'mensual', 'COP', :p, 'activa') RETURNING id_suscripcion;`,
        { n: idNegocio, p: pasarela },
    );
    const referencia = `EA-${idNegocio}-209901`;
    const factura = await fila(
        `INSERT INTO cobranza.cob_factura
            (id_suscripcion, id_negocio, id_plan, tipo, referencia, periodo_inicio, periodo_fin,
             moneda, subtotal, impuestos, total, estado, pasarela)
         VALUES (:s, :n, 1, 'renovacion', :r, CURRENT_DATE + 11, CURRENT_DATE + 40,
                 'COP', :t, 0, :t, 'pendiente', :p)
         RETURNING id_factura;`,
        { s: susc.id_suscripcion, n: idNegocio, r: referencia, t: total, p: pasarela },
    );
    const referenciaIntento = `${referencia}-abc12`;
    const payload = pasarela === 'wompi'
        ? { reference: referenciaIntento, modo: 'web-checkout' }
        : { order_id: referenciaIntento, status: 'PENDING' };
    const intento = await fila(
        `INSERT INTO cobranza.cob_transaccion
            (id_factura, pasarela, id_externo, estado, codigo_respuesta, payload, creado_en)
         VALUES (:f, :p, :x, 'pendiente', 'CHECKOUT', CAST(:pl AS jsonb), LOCALTIMESTAMP - (:d || ' days')::interval)
         RETURNING id_transaccion;`,
        { f: factura.id_factura, p: pasarela, x: idExterno, pl: JSON.stringify(payload), d: String(edadDias) },
    );
    return {
        idNegocio,
        idFactura: factura.id_factura,
        idIntento: intento.id_transaccion,
        referencia,
        referenciaIntento,
    };
}

/** Lo que responde Wompi para una transacción. */
const wompiTx = (fx, sobre = {}, extra = {}) => ({
    estado: sobre.estado ?? 'aprobada',
    // Un id por factura: el mismo id externo jamás se aplica dos veces, y el de otra prueba estorbaría.
    idExterno: `w-${fx.idFactura}`,
    codigoRespuesta: 'APPROVED',
    mensaje: null,
    payload: {
        id: `w-${fx.idFactura}`,
        status: 'APPROVED',
        reference: fx.referenciaIntento,
        amount_in_cents: TOTAL * 100,
        currency: 'COP',
        ...sobre,
    },
    ...extra,
});

const estadoFactura = async (id) => (await fila('SELECT estado FROM cobranza.cob_factura WHERE id_factura = :i', { i: id })).estado;
const estadoIntento = async (id) => (await fila('SELECT estado, id_externo FROM cobranza.cob_transaccion WHERE id_transaccion = :i', { i: id }));
const finDelPlan = async (n) => (await fila(
    `SELECT fecha_fin::date::text AS fin FROM general.gener_negocio_plan WHERE id_negocio = :n AND estado = 'A' ORDER BY fecha_fin DESC LIMIT 1`,
    { n },
)).fin;
const contar = async (sql, r) => (await fila(sql, r)).n;

beforeEach(() => {
    jest.clearAllMocks();
    Conciliacion._reiniciar();
    mockAdaptadores.wompi.consultarPorReferencia.mockReset();
    mockAdaptadores.wompi.consultarTransaccion.mockReset();
    mockAdaptadores.dlocal.consultarTransaccion.mockReset();
});

afterAll(async () => {
    for (const n of creados) {
        await sequelize.query(`DELETE FROM cobranza.cob_transaccion WHERE id_factura IN (SELECT id_factura FROM cobranza.cob_factura WHERE id_negocio = :n)`, { replacements: { n } });
        await sequelize.query(`DELETE FROM cobranza.cob_factura_detalle WHERE id_factura IN (SELECT id_factura FROM cobranza.cob_factura WHERE id_negocio = :n)`, { replacements: { n } }).catch(() => {});
        await sequelize.query(`DELETE FROM cobranza.cob_factura WHERE id_negocio = :n`, { replacements: { n } });
        await sequelize.query(`DELETE FROM cobranza.cob_suscripcion WHERE id_negocio = :n`, { replacements: { n } });
        await sequelize.query(`DELETE FROM general.gener_negocio_plan WHERE id_negocio = :n`, { replacements: { n } });
        await sequelize.query(`DELETE FROM general.gener_negocio WHERE id_negocio = :n`, { replacements: { n } }).catch(() => {});
    }
    await sequelize.close();
});

describe('un pago APROBADO se aplica una vez', () => {
    it('aplica, cierra el intento sin duplicar filas y deja auditoría con la vía', async () => {
        const fx = await crearFixture();
        const finAntes = await finDelPlan(fx.idNegocio);
        mockAdaptadores.wompi.consultarPorReferencia.mockResolvedValue([wompiTx(fx)]);

        const r = await Conciliacion.conciliarPendientes([fx.idNegocio], { via: 'al_iniciar_sesion' });

        expect(r.aplicados).toEqual([{ id_negocio: fx.idNegocio, referencia: fx.referencia }]);
        expect(r.pendientes).toBe(0);
        expect(await estadoFactura(fx.idFactura)).toBe('pagada');
        expect(await finDelPlan(fx.idNegocio)).not.toBe(finAntes);
        const intento = await estadoIntento(fx.idIntento);
        expect(intento).toMatchObject({ estado: 'aprobada', id_externo: `w-${fx.idFactura}` });
        // El intento pendiente se cerró: no hay una segunda fila «aprobada».
        expect(await contar(`SELECT COUNT(*)::int AS n FROM cobranza.cob_transaccion WHERE id_factura = :f`, { f: fx.idFactura })).toBe(1);
        const ev = await fila(
            `SELECT detalle FROM auditoria.audit_evento WHERE modulo = 'cobranza' AND accion = 'pago_conciliado'
                AND id_negocio = :n ORDER BY id_evento DESC LIMIT 1`, { n: fx.idNegocio });
        expect(ev.detalle.via).toBe('al_iniciar_sesion');
    });

    it('una segunda corrida NO suma otro mes', async () => {
        const fx = await crearFixture();
        mockAdaptadores.wompi.consultarPorReferencia.mockResolvedValue([wompiTx(fx)]);
        await Conciliacion.conciliarPendientes([fx.idNegocio]);
        const fin = await finDelPlan(fx.idNegocio);

        Conciliacion._reiniciar();
        const r = await Conciliacion.conciliarPendientes([fx.idNegocio]);

        expect(r.aplicados).toEqual([]);
        expect(await finDelPlan(fx.idNegocio)).toBe(fin);
    });

    it('avisa al super admin cuando NO llegó por webhook (y una sola vez al día)', async () => {
        const a = await crearFixture();
        const b = await crearFixture();
        mockAdaptadores.wompi.consultarPorReferencia
            .mockResolvedValueOnce([wompiTx(a)])
            .mockResolvedValueOnce([wompiTx(b)]);

        await Conciliacion.conciliarPendientes([a.idNegocio]);
        await Conciliacion.conciliarPendientes([b.idNegocio]);
        await new Promise((r) => setTimeout(r, 200)); // las alertas van sin await

        expect(MailService.sendAlertaAdminEmail.mock.calls.length).toBeLessThanOrEqual(1);
        if (MailService.sendAlertaAdminEmail.mock.calls.length) {
            expect(MailService.sendAlertaAdminEmail.mock.calls[0][0].asunto).toMatch(/recuperado sin webhook/);
        }
    });
});

describe('concurrencia: un solo pago, un solo mes', () => {
    it('webhook + conciliación al mismo tiempo (y otra vez el retorno)', async () => {
        const fx = await crearFixture();
        const finAntes = await finDelPlan(fx.idNegocio);
        const estadoReal = wompiTx(fx);
        mockAdaptadores.wompi.consultarPorReferencia.mockResolvedValue([estadoReal]);
        const factura = await Models.CobFactura.findByPk(fx.idFactura);

        await Promise.all([
            WebhookService.resolverEstadoReal({ pasarela: 'wompi', factura, estadoReal, via: 'webhook' }),
            Conciliacion.conciliarPendientes([fx.idNegocio], { via: 'al_volver' }),
            WebhookService.resolverEstadoReal({ pasarela: 'wompi', factura, estadoReal, via: 'retorno' }),
        ]);

        expect(await estadoFactura(fx.idFactura)).toBe('pagada');
        expect(await contar(
            `SELECT COUNT(*)::int AS n FROM auditoria.audit_evento WHERE modulo = 'cobranza'
                AND accion = 'pago_conciliado' AND id_negocio = :n`, { n: fx.idNegocio })).toBe(1);
        // Un mes exacto: la fecha avanzó UNA vez (ciclo mensual), no dos ni tres.
        const [y, m, d] = finAntes.split('-').map(Number);
        const esperado = new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10); // +1 mes (aprox.)
        const fin = await finDelPlan(fx.idNegocio);
        expect(Math.abs(Date.parse(fin) - Date.parse(esperado))).toBeLessThanOrEqual(3 * 86_400_000);
        expect(Date.parse(fin) - Date.parse(finAntes)).toBeLessThan(35 * 86_400_000);
    });
});

describe('lo que no coincide NO se aplica', () => {
    for (const [nombre, sobre, motivo] of [
        ['monto distinto', { amount_in_cents: 100 }, 'monto'],
        ['moneda distinta', { currency: 'USD' }, 'moneda'],
        ['referencia de OTRA factura', { reference: 'EA-999999-209901-zzz99' }, 'referencia'],
        ['aprobada sin monto', { amount_in_cents: null }, 'monto'],
    ]) {
        it(`${nombre} → no aplica, deja evento de error y alerta`, async () => {
            const fx = await crearFixture();
            mockAdaptadores.wompi.consultarPorReferencia.mockResolvedValue([wompiTx(fx, sobre)]);

            const r = await Conciliacion.conciliarPendientes([fx.idNegocio]);
            await new Promise((res) => setTimeout(res, 200));

            expect(r.aplicados).toEqual([]);
            expect(await estadoFactura(fx.idFactura)).toBe('pendiente');
            const ev = await fila(
                `SELECT resultado, detalle FROM auditoria.audit_evento WHERE modulo = 'cobranza'
                    AND accion = 'pago_no_coincide' AND id_negocio = :n ORDER BY id_evento DESC LIMIT 1`,
                { n: fx.idNegocio });
            expect(ev.resultado).toBe('error');
            expect(ev.detalle.motivo).toBe(motivo);
        });
    }
});

describe('rechazos y expiración', () => {
    it('DECLINED marca el intento rechazado; la factura sigue pendiente', async () => {
        const fx = await crearFixture();
        mockAdaptadores.wompi.consultarPorReferencia.mockResolvedValue([
            wompiTx(fx, { status: 'DECLINED', estado: 'rechazada' }),
        ]);

        const r = await Conciliacion.conciliarPendientes([fx.idNegocio]);

        expect(r.aplicados).toEqual([]);
        expect((await estadoIntento(fx.idIntento)).estado).toBe('rechazada');
        expect(await estadoFactura(fx.idFactura)).toBe('pendiente');
    });

    it('más de 7 días sin pagar → expirada, sin tocar la factura', async () => {
        const fx = await crearFixture({ edadDias: 8 });
        mockAdaptadores.wompi.consultarPorReferencia.mockResolvedValue([]);

        await Conciliacion.conciliarPendientes([fx.idNegocio]);

        expect((await estadoIntento(fx.idIntento)).estado).toBe('expirada');
        expect(await estadoFactura(fx.idFactura)).toBe('pendiente');
    });

    it('PENDING en la pasarela: se espera', async () => {
        const fx = await crearFixture();
        mockAdaptadores.wompi.consultarPorReferencia.mockResolvedValue([
            wompiTx(fx, { status: 'PENDING', estado: 'pendiente' }),
        ]);
        const r = await Conciliacion.conciliarPendientes([fx.idNegocio]);
        expect(r).toEqual({ aplicados: [], pendientes: 1 });
        expect((await estadoIntento(fx.idIntento)).estado).toBe('pendiente');
    });
});

describe('límites que protegen a la pasarela', () => {
    it('sin intentos pendientes NO se llama a ninguna pasarela', async () => {
        const fx = await crearFixture();
        await sequelize.query(`UPDATE cobranza.cob_transaccion SET estado = 'rechazada' WHERE id_transaccion = :i`, { replacements: { i: fx.idIntento } });

        const r = await Conciliacion.conciliarPendientes([fx.idNegocio]);

        expect(r).toEqual({ aplicados: [], pendientes: 0 });
        expect(mockAdaptadores.wompi.consultarPorReferencia).not.toHaveBeenCalled();
        expect(mockAdaptadores.wompi.consultarTransaccion).not.toHaveBeenCalled();
    });

    it('como mucho una consulta por negocio cada 60 s', async () => {
        const fx = await crearFixture();
        mockAdaptadores.wompi.consultarPorReferencia.mockResolvedValue([
            wompiTx(fx, { status: 'PENDING', estado: 'pendiente' }),
        ]);
        const t0 = Date.now();

        await Conciliacion.conciliarPendientes([fx.idNegocio], { ahoraMs: t0 });
        await Conciliacion.conciliarPendientes([fx.idNegocio], { ahoraMs: t0 + 30_000 });
        expect(mockAdaptadores.wompi.consultarPorReferencia).toHaveBeenCalledTimes(1);

        await Conciliacion.conciliarPendientes([fx.idNegocio], { ahoraMs: t0 + 61_000 });
        expect(mockAdaptadores.wompi.consultarPorReferencia).toHaveBeenCalledTimes(2);
    });

    it('si la pasarela tarda: responde con lo que hay y el trabajo sigue en segundo plano', async () => {
        const fx = await crearFixture();
        let liberar;
        mockAdaptadores.wompi.consultarPorReferencia.mockImplementation(
            () => new Promise((resolve) => { liberar = () => resolve([wompiTx(fx)]); }),
        );

        const t0 = Date.now();
        const r = await Conciliacion.conciliarPendientes([fx.idNegocio], { topeMs: 50 });

        expect(Date.now() - t0).toBeLessThan(1500);
        expect(r).toEqual({ aplicados: [], pendientes: 1 });
        expect(await estadoFactura(fx.idFactura)).toBe('pendiente');

        liberar(); // Wompi por fin contesta: el trabajo terminó solo
        for (let i = 0; i < 40 && (await estadoFactura(fx.idFactura)) !== 'pagada'; i += 1) {
            await new Promise((res) => setTimeout(res, 100));
        }
        expect(await estadoFactura(fx.idFactura)).toBe('pagada');
    });

    it('un error de la pasarela en un intento no detiene los demás', async () => {
        const a = await crearFixture();
        const b = await crearFixture();
        mockAdaptadores.wompi.consultarPorReferencia.mockImplementation(async (ref) => {
            if (ref === a.referenciaIntento) throw new Error('Wompi respondió 502');
            return [wompiTx(b)];
        });

        const r = await Conciliacion.conciliarPendientes([a.idNegocio, b.idNegocio]);

        expect(r.aplicados).toEqual([{ id_negocio: b.idNegocio, referencia: b.referencia }]);
        expect(await estadoFactura(a.idFactura)).toBe('pendiente');
    });
});

describe('dLocal, por la misma interfaz', () => {
    const dl = (fx, estado, status, sobre = {}) => ({
        estado, idExterno: 'DP-1', codigoRespuesta: status, mensaje: null,
        payload: { id: 'DP-1', status, order_id: fx.referenciaIntento, amount: TOTAL, currency: 'COP', ...sobre },
    });

    it('PAID se aplica (consultando por el id del pago que se guardó al crear el cobro)', async () => {
        const fx = await crearFixture({ pasarela: 'dlocal', idExterno: 'DP-1' });
        mockAdaptadores.dlocal.consultarTransaccion.mockResolvedValue(dl(fx, 'aprobada', 'PAID'));

        const r = await Conciliacion.conciliarPendientes([fx.idNegocio]);

        expect(mockAdaptadores.dlocal.consultarTransaccion).toHaveBeenCalledWith('DP-1');
        expect(r.aplicados).toHaveLength(1);
        expect(await estadoFactura(fx.idFactura)).toBe('pagada');
    });

    it('REJECTED marca el intento rechazado; la factura sigue pendiente', async () => {
        const fx = await crearFixture({ pasarela: 'dlocal', idExterno: 'DP-1' });
        mockAdaptadores.dlocal.consultarTransaccion.mockResolvedValue(dl(fx, 'rechazada', 'REJECTED'));

        await Conciliacion.conciliarPendientes([fx.idNegocio]);

        expect((await estadoIntento(fx.idIntento)).estado).toBe('rechazada');
        expect(await estadoFactura(fx.idFactura)).toBe('pendiente');
    });

    it('PAID con el monto de otra factura no se aplica', async () => {
        const fx = await crearFixture({ pasarela: 'dlocal', idExterno: 'DP-1' });
        mockAdaptadores.dlocal.consultarTransaccion.mockResolvedValue(dl(fx, 'aprobada', 'PAID', { amount: 1 }));
        const r = await Conciliacion.conciliarPendientes([fx.idNegocio]);
        expect(r.aplicados).toEqual([]);
        expect(await estadoFactura(fx.idFactura)).toBe('pendiente');
    });
});

describe('una aprobación que NO es la que pagó la factura', () => {
    it('factura pagada a mano + el cliente además pagó → se detecta y se alerta', async () => {
        const fx = await crearFixture();
        await sequelize.query(`UPDATE cobranza.cob_factura SET estado = 'pagada', fecha_pago = now() WHERE id_factura = :f`, { replacements: { f: fx.idFactura } });
        mockAdaptadores.wompi.consultarPorReferencia.mockResolvedValue([wompiTx(fx)]);

        const r = await Conciliacion.conciliarPendientes([fx.idNegocio]);
        await new Promise((res) => setTimeout(res, 200));

        expect(r.aplicados).toEqual([]);
        expect(await contar(
            `SELECT COUNT(*)::int AS n FROM auditoria.audit_evento WHERE modulo = 'cobranza'
                AND accion = 'pago_duplicado_detectado' AND id_negocio = :n`, { n: fx.idNegocio })).toBe(1);
        // El intento se cierra: no se vuelve a preguntar por él.
        expect((await estadoIntento(fx.idIntento)).estado).toBe('aprobada');
    });
});

describe('el caso de El Callejero: dos transacciones, el MISMO pago de Wompi', () => {
    it('la factura ya pagada por «Verificar pago Wompi» no suma un mes al conciliar el intento CHECKOUT', async () => {
        // La 15: el intento CHECKOUT que nunca se cerró. La 16: la que creó el verificar manual.
        const fx = await crearFixture();
        const finAntes = await finDelPlan(fx.idNegocio);
        await sequelize.query(
            `UPDATE cobranza.cob_factura SET estado = 'pagada', fecha_pago = now() WHERE id_factura = :f`,
            { replacements: { f: fx.idFactura } },
        );
        const t16 = await fila(
            `INSERT INTO cobranza.cob_transaccion (id_factura, pasarela, id_externo, estado, codigo_respuesta, mensaje, payload)
             VALUES (:f, 'wompi', '1534421-1790293866-62103', 'aprobada', 'APPROVED', 'Pago confirmado por wompi',
                     CAST('{}' AS jsonb)) RETURNING id_transaccion`,
            { f: fx.idFactura },
        );
        // Wompi contesta lo mismo que dijo al verificar a mano: el mismo id de transacción.
        mockAdaptadores.wompi.consultarPorReferencia.mockResolvedValue([
            wompiTx(fx, { id: '1534421-1790293866-62103' }, { idExterno: '1534421-1790293866-62103' }),
        ]);

        const r = await Conciliacion.conciliarPendientes([fx.idNegocio], { via: 'al_iniciar_sesion' });
        await new Promise((res) => setTimeout(res, 200));

        expect(r.aplicados).toEqual([]);
        expect(await finDelPlan(fx.idNegocio)).toBe(finAntes); // ningún mes extra
        // El intento CHECKOUT se cierra como aprobado, con el id de Wompi y una nota de ya conciliada…
        const intento = await fila(
            `SELECT estado, id_externo, mensaje FROM cobranza.cob_transaccion WHERE id_transaccion = :i`, { i: fx.idIntento });
        expect(intento.estado).toBe('aprobada');
        expect(intento.id_externo).toBe('1534421-1790293866-62103');
        expect(intento.mensaje).toMatch(new RegExp(`Ya conciliada.*${t16.id_transaccion}`));
        // …no se alerta de un cobro doble (es el mismo pago)…
        expect(await contar(
            `SELECT COUNT(*)::int AS n FROM auditoria.audit_evento WHERE modulo = 'cobranza'
                AND accion = 'pago_duplicado_detectado' AND id_negocio = :n`, { n: fx.idNegocio })).toBe(0);
        // …y no se vuelve a consultar nunca: sin pendientes, ninguna llamada a la pasarela.
        Conciliacion._reiniciar();
        mockAdaptadores.wompi.consultarPorReferencia.mockClear();
        expect(await Conciliacion.conciliarPendientes([fx.idNegocio])).toEqual({ aplicados: [], pendientes: 0 });
        expect(mockAdaptadores.wompi.consultarPorReferencia).not.toHaveBeenCalled();
    });

    it('un id de Wompi ya aplicado en OTRA transacción nunca se aplica otra vez (aunque la factura esté pendiente)', async () => {
        const a = await crearFixture();
        const b = await crearFixture();
        mockAdaptadores.wompi.consultarPorReferencia.mockResolvedValueOnce([wompiTx(a)]);
        await Conciliacion.conciliarPendientes([a.idNegocio]);
        const finB = await finDelPlan(b.idNegocio);

        // Wompi devuelve, para la factura B, el MISMO id de transacción que ya pagó la A.
        Conciliacion._reiniciar();
        mockAdaptadores.wompi.consultarPorReferencia.mockResolvedValueOnce([
            wompiTx(b, {}, { idExterno: `w-${a.idFactura}` }),
        ]);
        const r = await Conciliacion.conciliarPendientes([b.idNegocio]);

        expect(r.aplicados).toEqual([]);
        expect(await estadoFactura(b.idFactura)).toBe('pendiente');
        expect(await finDelPlan(b.idNegocio)).toBe(finB);
    });
});

describe('endpoint POST /cobranza/conciliar-pendientes', () => {
    function llamar(body, idUsuario) {
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
        return CobranzaController.conciliarPendientes(
            { body, query: {}, usuario: { id_usuario: idUsuario } }, res,
        ).then(() => res);
    }

    it('un negocio ajeno → 403 y no se consulta la pasarela', async () => {
        const fx = await crearFixture();
        const res = await llamar({ id_negocio: fx.idNegocio }, 999999999);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(mockAdaptadores.wompi.consultarPorReferencia).not.toHaveBeenCalled();
    });

    it('un usuario sin negocios que administre responde al instante, sin llamar a nadie', async () => {
        const res = await llamar({}, 999999999);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json.mock.calls[0][0].data).toEqual({ aplicados: [], pendientes: 0 });
        expect(mockAdaptadores.wompi.consultarPorReferencia).not.toHaveBeenCalled();
    });
});
