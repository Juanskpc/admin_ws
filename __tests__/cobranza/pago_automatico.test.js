/**
 * Cobranza — pago automático OPCIONAL con tarjeta guardada en Wompi (2026-10-14).
 *
 * Corre contra la base LOCAL (con `npm run migrate:cobranza-pago-automatico`) con WOMPI y el
 * CORREO simulados: no se cobra nada real. Cada prueba crea su propio negocio. Lo que fija:
 *
 *   - activar guarda la tarjeta con la constancia (quién, cuándo, IP), apaga la anterior y deja
 *     la suscripción con medio y fecha de cobro = día siguiente al vencimiento,
 *   - activar exige los dos documentos de Wompi y se niega con plan sin vencimiento o fuera de CO,
 *   - quien activa estando atrasado paga en el acto,
 *   - desactivar quita medio y fecha: vuelve a pagar con el enlace,
 *   - un pago por enlace NO deja fecha de cobro automático (el riesgo que había),
 *   - el cron solo mira suscripciones con tarjeta activa,
 *   - un débito en curso en la pasarela bloquea un segundo cobro (sin cobro doble),
 *   - un débito rechazado tarde (PENDING → DECLINED) cuenta UNA vez y avisa por correo,
 *   - el adaptador cobra con referencia única por intento y marca el cobro como recurrente.
 *
 * Ejecutar: DB_PORT=5432 DB_PASS=<local> npx jest __tests__/cobranza/pago_automatico.test.js --forceExit
 */
'use strict';

require('dotenv').config();

const mockWompi = {
    codigo: 'wompi',
    soportaRecurrente: true,
    estaConfigurada: () => true,
    getTerminos: jest.fn(),
    tokenizarMetodo: jest.fn(),
    cobrar: jest.fn(),
    consultarPorReferencia: jest.fn(),
    consultarTransaccion: jest.fn(),
};
const mockAdaptadores = {
    wompi: mockWompi,
    dlocal: { codigo: 'dlocal', soportaRecurrente: false, estaConfigurada: () => true },
    manual: { codigo: 'manual', soportaRecurrente: false, estaConfigurada: () => true },
};
jest.mock('../../app_core/cobranza', () => ({
    getAdaptador: (c) => mockAdaptadores[c],
    getAdaptadorListo: (c) => mockAdaptadores[c],
    estadoDeConfiguracion: () => [],
}));
jest.mock('../../app_admin_api/services/mailService', () => ({
    sendAvisoCobroEmail: jest.fn(async () => undefined),
    sendAlertaAdminEmail: jest.fn(async () => undefined),
    sendWelcomeEmail: jest.fn(async () => undefined),
    sendAdminNotificationEmail: jest.fn(async () => undefined),
    sendHtmlEmail: jest.fn(async () => undefined),
}));

const Models = require('../../app_core/models/conection');
const MailService = require('../../app_admin_api/services/mailService');
const PagoAutomatico = require('../../app_admin_api/services/pagoAutomaticoService');
const Scheduler = require('../../app_admin_api/services/cobranzaScheduler');
const WebhookService = require('../../app_admin_api/services/cobranzaWebhookService');
const Conciliacion = require('../../app_admin_api/services/cobranzaConciliacionService');

const sequelize = Models.sequelize;
const TOTAL = 27999;
const creados = [];
let idUsuario;

async function fila(sql, replacements = {}) {
    const r = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return r[0] ?? null;
}

/**
 * Un negocio de prueba con plan que vence en `venceEn` días (null = sin vencimiento), su
 * suscripción de Wompi y, si se pide, una factura pendiente.
 */
async function crearNegocio({ venceEn = 10, pais = 'CO', factura = null } = {}) {
    const { id_negocio: idNegocio } = await fila(
        `INSERT INTO general.gener_negocio (nombre, pais, email_contacto)
         VALUES (:n, :p, 'prueba-pago-automatico@example.com') RETURNING id_negocio;`,
        { n: `TEST-pago-auto-${Date.now()}-${creados.length}`, p: pais }
    );
    creados.push(idNegocio);
    await sequelize.query(
        `INSERT INTO general.gener_negocio_plan (id_negocio, id_plan, fecha_inicio, fecha_fin, estado)
         VALUES (:n, 1, CURRENT_DATE - 20,
                 ${venceEn === null ? 'NULL' : `(CURRENT_DATE + ${Number(venceEn)})::timestamp + interval '23:59:59'`},
                 'A');`,
        { replacements: { n: idNegocio } }
    );
    const susc = await fila(
        `INSERT INTO cobranza.cob_suscripcion (id_negocio, id_plan, ciclo, moneda, pasarela, estado)
         VALUES (:n, 1, 'mensual', 'COP', 'wompi', 'activa') RETURNING id_suscripcion;`,
        { n: idNegocio }
    );
    let idFactura = null;
    if (factura) {
        const f = await fila(
            `INSERT INTO cobranza.cob_factura
                (id_suscripcion, id_negocio, id_plan, tipo, referencia, periodo_inicio, periodo_fin,
                 moneda, subtotal, impuestos, total, estado, pasarela)
             VALUES (:s, :n, 1, 'renovacion', :r, CURRENT_DATE + :ini, CURRENT_DATE + :ini + 29,
                     'COP', :t, 0, :t, 'pendiente', 'wompi')
             RETURNING id_factura;`,
            {
                s: susc.id_suscripcion,
                n: idNegocio,
                r: `EA-${idNegocio}-209902`,
                ini: factura.iniciaEn,
                t: TOTAL,
            }
        );
        idFactura = f.id_factura;
    }
    return { idNegocio, idSuscripcion: susc.id_suscripcion, idFactura };
}

const suscripcion = (id) =>
    fila(
        `SELECT estado, reintentos, id_metodo_pago, proximo_cobro::text AS proximo
           FROM cobranza.cob_suscripcion WHERE id_negocio = :n`,
        { n: id }
    );
const finDelPlan = async (n) =>
    (
        await fila(
            `SELECT fecha_fin::date::text AS fin FROM general.gener_negocio_plan
              WHERE id_negocio = :n AND estado = 'A' ORDER BY fecha_fin DESC LIMIT 1`,
            { n }
        )
    ).fin;
const diaSiguiente = async (iso) =>
    (await fila(`SELECT (CAST(:d AS date) + 1)::text AS d`, { d: iso })).d;
const hoy = async () => (await fila(`SELECT CURRENT_DATE::text AS d`)).d;

const DATOS_ACTIVAR = () => ({
    tokenTarjeta: 'tok_test_123',
    acceptanceToken: 'acc-token-de-prueba',
    personalAuthToken: 'auth-token-de-prueba',
    idUsuario,
    ip: '190.1.2.3',
});

let contadorFuentes = 0;
function fuenteNueva() {
    contadorFuentes += 1;
    return {
        tokenExterno: `src-${Date.now()}-${contadorFuentes}`,
        tipo: 'CARD',
        marca: 'VISA',
        ultimos4: '4242',
        mesExp: 12,
        anioExp: 2030,
    };
}

let estadoWompiOriginal;

beforeAll(async () => {
    idUsuario = (await fila(`SELECT min(id_usuario) AS id FROM general.gener_usuario`)).id;
    // El cron solo mira pasarelas ACTIVAS. En producción Wompi lo está; en una base local puede no
    // estarlo (la local la tenía en 'I'), así que la prueba la activa y la deja como la encontró.
    estadoWompiOriginal = (await fila(`SELECT estado FROM cobranza.cob_pasarela WHERE codigo = 'wompi'`)).estado;
    await sequelize.query(`UPDATE cobranza.cob_pasarela SET estado = 'A' WHERE codigo = 'wompi'`);
});

beforeEach(() => {
    jest.clearAllMocks();
    mockWompi.tokenizarMetodo.mockImplementation(async () => fuenteNueva());
});

afterAll(async () => {
    for (const n of creados) {
        const q = (sql) => sequelize.query(sql, { replacements: { n } }).catch(() => {});
        await q(`UPDATE cobranza.cob_suscripcion SET id_metodo_pago = NULL WHERE id_negocio = :n`);
        await q(`DELETE FROM cobranza.cob_transaccion WHERE id_factura IN (SELECT id_factura FROM cobranza.cob_factura WHERE id_negocio = :n)`);
        await q(`DELETE FROM cobranza.cob_factura_detalle WHERE id_factura IN (SELECT id_factura FROM cobranza.cob_factura WHERE id_negocio = :n)`);
        await q(`DELETE FROM cobranza.cob_factura WHERE id_negocio = :n`);
        await q(`DELETE FROM cobranza.cob_metodo_pago WHERE id_negocio = :n`);
        await q(`DELETE FROM cobranza.cob_suscripcion WHERE id_negocio = :n`);
        await q(`DELETE FROM general.gener_negocio_plan WHERE id_negocio = :n`);
        await q(`DELETE FROM general.gener_negocio WHERE id_negocio = :n`);
    }
    await sequelize.query(`UPDATE cobranza.cob_pasarela SET estado = :e WHERE codigo = 'wompi'`, {
        replacements: { e: estadoWompiOriginal },
    });
    await sequelize.close();
});

describe('activar', () => {
    it('guarda la tarjeta con la constancia y deja el cobro para el día siguiente al vencimiento', async () => {
        const { idNegocio } = await crearNegocio({ venceEn: 10 });

        const r = await PagoAutomatico.activar(idNegocio, DATOS_ACTIVAR());

        expect(mockWompi.tokenizarMetodo).toHaveBeenCalledWith(
            expect.objectContaining({
                tokenTarjeta: 'tok_test_123',
                acceptanceToken: 'acc-token-de-prueba',
                personalAuthToken: 'auth-token-de-prueba',
                tipo: 'CARD',
            })
        );
        expect(r.activo).toBe(true);
        expect(r.metodo.descripcion).toBe('Visa ···4242');

        const s = await suscripcion(idNegocio);
        expect(s.id_metodo_pago).not.toBeNull();
        expect(s.proximo).toBe(await diaSiguiente(await finDelPlan(idNegocio)));

        const m = await fila(
            `SELECT estado, autorizado_por, autorizado_en, ip_autorizacion
               FROM cobranza.cob_metodo_pago WHERE id_metodo_pago = :i`,
            { i: s.id_metodo_pago }
        );
        expect(m).toMatchObject({ estado: 'A', autorizado_por: idUsuario, ip_autorizacion: '190.1.2.3' });
        expect(m.autorizado_en).not.toBeNull();
        expect(MailService.sendAvisoCobroEmail).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ titulo: 'Pago automático activado' })
        );
    });

    it('una tarjeta nueva apaga la anterior: nunca hay dos activas', async () => {
        const { idNegocio } = await crearNegocio();
        await PagoAutomatico.activar(idNegocio, DATOS_ACTIVAR());
        await PagoAutomatico.activar(idNegocio, DATOS_ACTIVAR());

        const { n } = await fila(
            `SELECT count(*)::int AS n FROM cobranza.cob_metodo_pago WHERE id_negocio = :n AND estado = 'A'`,
            { n: idNegocio }
        );
        expect(n).toBe(1);
    });

    it('sin los dos documentos de Wompi no se guarda nada', async () => {
        const { idNegocio } = await crearNegocio();
        await expect(
            PagoAutomatico.activar(idNegocio, { ...DATOS_ACTIVAR(), personalAuthToken: null })
        ).rejects.toMatchObject({ code: 'TERMINOS_NO_ACEPTADOS' });
        expect(mockWompi.tokenizarMetodo).not.toHaveBeenCalled();
    });

    it('se niega con un plan sin vencimiento y fuera de Colombia', async () => {
        const sinVencimiento = await crearNegocio({ venceEn: null });
        await expect(
            PagoAutomatico.activar(sinVencimiento.idNegocio, DATOS_ACTIVAR())
        ).rejects.toMatchObject({ code: 'PLAN_SIN_VENCIMIENTO' });

        const chile = await crearNegocio({ pais: 'CL' });
        await expect(PagoAutomatico.activar(chile.idNegocio, DATOS_ACTIVAR())).rejects.toMatchObject({
            code: 'PAIS_SIN_PAGO_AUTOMATICO',
        });
        expect(mockWompi.tokenizarMetodo).not.toHaveBeenCalled();
    });

    it('quien activa estando atrasado paga en el acto', async () => {
        const { idNegocio, idFactura } = await crearNegocio({ venceEn: -2, factura: { iniciaEn: -1 } });
        mockWompi.cobrar.mockImplementation(async ({ token }) => ({
            estado: 'aprobada',
            idExterno: `w-inmediato-${idFactura}`,
            codigoRespuesta: 'APPROVED',
            mensaje: null,
            payload: { id: `w-inmediato-${idFactura}`, status: 'APPROVED', reference: 'x', modo: 'fuente-de-pago', token },
        }));

        const r = await PagoAutomatico.activar(idNegocio, DATOS_ACTIVAR());

        expect(mockWompi.cobrar).toHaveBeenCalledWith(expect.objectContaining({ token: expect.any(String) }));
        expect(r.cobro_inmediato).toMatchObject({ estado: 'aprobada' });
        const f = await fila(`SELECT estado FROM cobranza.cob_factura WHERE id_factura = :i`, { i: idFactura });
        expect(f.estado).toBe('pagada');
        // Pagó con tarjeta guardada: el próximo cobro automático queda puesto.
        const s = await suscripcion(idNegocio);
        expect(s.proximo).toBe(await diaSiguiente(await finDelPlan(idNegocio)));
    });
});

describe('desactivar', () => {
    it('quita el medio y la fecha de cobro: vuelve a pagar con el enlace', async () => {
        const { idNegocio } = await crearNegocio();
        await PagoAutomatico.activar(idNegocio, DATOS_ACTIVAR());
        const r = await PagoAutomatico.desactivar(idNegocio, { idUsuario });

        expect(r.activo).toBe(false);
        const s = await suscripcion(idNegocio);
        expect(s).toMatchObject({ id_metodo_pago: null, proximo: null });
        const { n } = await fila(
            `SELECT count(*)::int AS n FROM cobranza.cob_metodo_pago WHERE id_negocio = :n AND estado = 'A'`,
            { n: idNegocio }
        );
        expect(n).toBe(0);
    });
});

describe('el cron solo cobra a quien tiene tarjeta', () => {
    it('un pago por enlace no deja fecha de cobro automático', async () => {
        const { idNegocio, idFactura } = await crearNegocio({ factura: { iniciaEn: 11 } });
        const factura = await fila(`SELECT * FROM cobranza.cob_factura WHERE id_factura = :i`, { i: idFactura });
        await WebhookService.resolverEstadoReal({
            pasarela: 'wompi',
            factura,
            estadoReal: {
                estado: 'aprobada',
                idExterno: `w-enlace-${idFactura}`,
                codigoRespuesta: 'APPROVED',
                payload: {
                    id: `w-enlace-${idFactura}`,
                    status: 'APPROVED',
                    reference: `${factura.referencia}-abc`,
                    amount_in_cents: TOTAL * 100,
                    currency: 'COP',
                },
            },
            via: 'manual',
        });
        const s = await suscripcion(idNegocio);
        expect(s.proximo).toBeNull();
    });

    it('suscripcionesPorCobrar ignora la que tiene fecha pero no tarjeta', async () => {
        const sinTarjeta = await crearNegocio();
        await sequelize.query(
            `UPDATE cobranza.cob_suscripcion SET proximo_cobro = CURRENT_DATE - 1 WHERE id_negocio = :n`,
            { replacements: { n: sinTarjeta.idNegocio } }
        );
        const conTarjeta = await crearNegocio();
        await PagoAutomatico.activar(conTarjeta.idNegocio, DATOS_ACTIVAR());
        await sequelize.query(
            `UPDATE cobranza.cob_suscripcion SET proximo_cobro = CURRENT_DATE - 1 WHERE id_negocio = :n`,
            { replacements: { n: conTarjeta.idNegocio } }
        );

        const ids = (await Scheduler.suscripcionesPorCobrar()).map((s) => Number(s.id_negocio));
        expect(ids).toContain(conTarjeta.idNegocio);
        expect(ids).not.toContain(sinTarjeta.idNegocio);
    });
});

describe('sin cobro doble', () => {
    async function debitoEnCurso() {
        const fx = await crearNegocio({ venceEn: -1, factura: { iniciaEn: 0 } });
        const factura = await fila(`SELECT referencia FROM cobranza.cob_factura WHERE id_factura = :i`, { i: fx.idFactura });
        const referenciaIntento = `${factura.referencia}-deb01`;
        await sequelize.query(
            `INSERT INTO cobranza.cob_transaccion (id_factura, pasarela, id_externo, estado, codigo_respuesta, payload)
             VALUES (:f, 'wompi', :x, 'pendiente', 'PENDING', CAST(:pl AS jsonb));`,
            {
                replacements: {
                    f: fx.idFactura,
                    x: `w-deb-${fx.idFactura}`,
                    pl: JSON.stringify({ id: `w-deb-${fx.idFactura}`, status: 'PENDING', reference: referenciaIntento, modo: 'fuente-de-pago' }),
                },
            }
        );
        return { ...fx, referencia: factura.referencia, referenciaIntento };
    }

    it('un débito todavía PENDING en Wompi bloquea el cobro de hoy', async () => {
        const fx = await debitoEnCurso();
        mockWompi.consultarTransaccion.mockResolvedValue({
            estado: 'pendiente',
            idExterno: `w-deb-${fx.idFactura}`,
            codigoRespuesta: 'PENDING',
            payload: { id: `w-deb-${fx.idFactura}`, status: 'PENDING', reference: fx.referenciaIntento },
        });
        expect(await Scheduler.hayPagoEnCurso(fx.idNegocio)).toBe(true);
    });

    it('si se aprobó mientras tanto, se aplica y ya no hay nada en curso', async () => {
        const fx = await debitoEnCurso();
        mockWompi.consultarTransaccion.mockResolvedValue({
            estado: 'aprobada',
            idExterno: `w-deb-${fx.idFactura}`,
            codigoRespuesta: 'APPROVED',
            payload: {
                id: `w-deb-${fx.idFactura}`,
                status: 'APPROVED',
                reference: fx.referenciaIntento,
                amount_in_cents: TOTAL * 100,
                currency: 'COP',
            },
        });
        expect(await Scheduler.hayPagoEnCurso(fx.idNegocio)).toBe(false);
        const f = await fila(`SELECT estado FROM cobranza.cob_factura WHERE id_factura = :i`, { i: fx.idFactura });
        expect(f.estado).toBe('pagada');
    });

    it('si la pasarela no responde, ante la duda no se cobra', async () => {
        const fx = await debitoEnCurso();
        mockWompi.consultarTransaccion.mockRejectedValue(new Error('timeout'));
        expect(await Scheduler.hayPagoEnCurso(fx.idNegocio)).toBe(true);
    });

    it('un débito rechazado tarde cuenta UNA vez aunque llegue dos veces, y avisa', async () => {
        const fx = await debitoEnCurso();
        const factura = await fila(`SELECT * FROM cobranza.cob_factura WHERE id_factura = :i`, { i: fx.idFactura });
        const rechazo = {
            estado: 'rechazada',
            idExterno: `w-deb-${fx.idFactura}`,
            codigoRespuesta: 'DECLINED',
            mensaje: 'Fondos insuficientes',
            payload: { id: `w-deb-${fx.idFactura}`, status: 'DECLINED', reference: fx.referenciaIntento },
        };

        // Webhook y conciliador con el mismo rechazo, a la vez.
        mockWompi.consultarTransaccion.mockResolvedValue(rechazo);
        const [intento] = await Conciliacion.intentosPendientes([fx.idNegocio]);
        await Promise.all([
            WebhookService.resolverEstadoReal({ pasarela: 'wompi', factura, estadoReal: rechazo, via: 'webhook' }),
            Conciliacion.conciliarIntento(intento, { via: 'al_volver' }),
        ]);

        const s = await suscripcion(fx.idNegocio);
        expect(s).toMatchObject({ estado: 'en_gracia', reintentos: 1 });
        const avisos = MailService.sendAvisoCobroEmail.mock.calls.filter(
            ([, a]) => a.titulo === 'No pudimos cobrar tu mensualidad'
        );
        // Un solo rechazo → un solo aviso por destinatario (aquí, el correo del negocio y el de quien
        // autorizó no aplican: la prueba no activó tarjeta, así que solo está el del negocio).
        expect(avisos.length).toBe(1);
        expect(avisos[0][1].parrafos.join(' ')).toContain('Fondos insuficientes');
    });

    it('un rechazo en el checkout (no débito) sigue sin contar para la morosidad', async () => {
        const { idNegocio, idFactura } = await crearNegocio({ factura: { iniciaEn: 11 } });
        const factura = await fila(`SELECT * FROM cobranza.cob_factura WHERE id_factura = :i`, { i: idFactura });
        await sequelize.query(
            `INSERT INTO cobranza.cob_transaccion (id_factura, pasarela, estado, codigo_respuesta, payload)
             VALUES (:f, 'wompi', 'pendiente', 'CHECKOUT', CAST(:pl AS jsonb));`,
            { replacements: { f: idFactura, pl: JSON.stringify({ reference: `${factura.referencia}-chk`, modo: 'web-checkout' }) } }
        );
        await WebhookService.resolverEstadoReal({
            pasarela: 'wompi',
            factura,
            estadoReal: {
                estado: 'rechazada',
                idExterno: 'w-chk-1',
                codigoRespuesta: 'DECLINED',
                payload: { id: 'w-chk-1', status: 'DECLINED', reference: `${factura.referencia}-chk` },
            },
            via: 'webhook',
        });
        const s = await suscripcion(idNegocio);
        expect(s).toMatchObject({ estado: 'activa', reintentos: 0 });
    });
});
