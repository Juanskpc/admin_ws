/**
 * Cobranza — lo que pasa DESPUÉS de que una pasarela dice algo sobre un pago.
 *
 * `procesarEvento` es el único camino por el que un pago de pasarela se convierte en días de
 * servicio, lo usen el webhook o la confirmación al volver del checkout. Estas pruebas cubren las
 * decisiones que, si se rompen, no fallan con un error: fallan cobrando mal en silencio.
 *
 *   - Un pago por menos de lo facturado NO extiende el plan.
 *   - Un rechazo en el checkout NO suma morosidad (antes recargar la página suspendía al cliente).
 *   - Una factura ya pagada no se paga dos veces.
 *   - La referencia con sufijo de Wompi (`EA-4-202609-lx3k9a`) encuentra su factura.
 *
 * Todo con mocks: no toca la base ni la red, así que corre aunque el túnel esté caído.
 *
 * Ejecutar: npx jest __tests__/cobranza/
 */
'use strict';

jest.mock('../../app_core/models/conection', () => ({
    sequelize: {
        transaction: jest.fn(async () => ({ commit: jest.fn(), rollback: jest.fn() })),
        query: jest.fn(async () => []),
        QueryTypes: { SELECT: 'SELECT' },
    },
    CobEventoWebhook: { create: jest.fn(), update: jest.fn() },
    CobSuscripcion: { findByPk: jest.fn() },
}));
jest.mock('../../app_core/dao/cobranzaDao', () => ({
    getFacturaPorReferencia: jest.fn(),
    getFactura: jest.fn(),
}));
jest.mock('../../app_admin_api/services/cobranzaService', () => ({
    _interno: {
        cargarFacturaCobrable: jest.fn(),
        aplicarPagoAprobado: jest.fn(),
        registrarIntentoFallido: jest.fn(),
    },
}));
jest.mock('../../app_core/cobranza', () => ({ getAdaptador: jest.fn() }));
// El alta pagada y las alertas al super admin tocan correo y base: aquí no se prueban.
jest.mock('../../app_admin_api/services/adquirirService', () => ({
    notificarAltaPagada: jest.fn(async () => ({ enviado: false })),
}));
jest.mock('../../app_admin_api/services/mailService', () => ({
    sendAlertaAdminEmail: jest.fn(async () => undefined),
}));
jest.mock('../../app_core/helpers/auditHelper', () => ({ registrarEvento: jest.fn() }));
jest.mock('../../app_core/middleware/auditContext', () => ({ setAuditNegocio: jest.fn() }));

const Dao = require('../../app_core/dao/cobranzaDao');
const CobranzaService = require('../../app_admin_api/services/cobranzaService');
const { getAdaptador } = require('../../app_core/cobranza');
const WebhookService = require('../../app_admin_api/services/cobranzaWebhookService');

/** Factura pendiente de un Plan Avanzado: $59.999 COP = 5.999.900 centavos. */
function facturaPendiente(extra = {}) {
    return {
        id_factura: 9,
        id_negocio: 4,
        id_suscripcion: 2,
        referencia: 'EA-4-202609',
        total: '59999.00', // DECIMAL: llega como string, igual que en producción
        moneda: 'COP',
        estado: 'pendiente',
        ...extra,
    };
}

/** Configura lo que "responde Wompi" al consultar la transacción. */
function wompiResponde({ estado, codigo, reference = 'EA-4-202609-lx3k9a', centavos = 5999900, moneda = 'COP' }) {
    const adaptador = {
        estaConfigurada: () => true,
        consultarTransaccion: jest.fn(async () => ({
            estado,
            idExterno: 'tx-123',
            codigoRespuesta: codigo,
            payload: { id: 'tx-123', status: codigo, reference, amount_in_cents: centavos, currency: moneda },
        })),
    };
    getAdaptador.mockReturnValue(adaptador);
    return adaptador;
}

beforeEach(() => {
    jest.clearAllMocks();
    Dao.getFacturaPorReferencia.mockResolvedValue(facturaPendiente());
    CobranzaService._interno.cargarFacturaCobrable.mockResolvedValue({
        factura: facturaPendiente(),
        suscripcion: { id_suscripcion: 2 },
    });
    CobranzaService._interno.aplicarPagoAprobado.mockResolvedValue(facturaPendiente({ estado: 'pagada' }));
});

describe('confirmar un pago al volver del checkout', () => {
    test('aprobado y con el monto exacto → se aplica y responde «aprobada»', async () => {
        wompiResponde({ estado: 'aprobada', codigo: 'APPROVED' });

        const r = await WebhookService.confirmarPorRetorno('wompi', 'tx-123');

        expect(r).toEqual({ estado: 'aprobada' });
        expect(CobranzaService._interno.aplicarPagoAprobado).toHaveBeenCalledTimes(1);
    });

    test('la referencia con sufijo de intento encuentra la factura base', async () => {
        wompiResponde({ estado: 'aprobada', codigo: 'APPROVED', reference: 'EA-4-202609-lx3k9a' });

        await WebhookService.confirmarPorRetorno('wompi', 'tx-123');

        expect(Dao.getFacturaPorReferencia).toHaveBeenCalledWith('EA-4-202609');
    });

    test('el estado se le pregunta a la pasarela, no se toma del navegador', async () => {
        const adaptador = wompiResponde({ estado: 'aprobada', codigo: 'APPROVED' });

        await WebhookService.confirmarPorRetorno('wompi', 'tx-123');

        expect(adaptador.consultarTransaccion).toHaveBeenCalledWith('tx-123');
    });
});

describe('el monto tiene que coincidir con la factura', () => {
    test('aprobado por MENOS de lo facturado → no se aplica', async () => {
        wompiResponde({ estado: 'aprobada', codigo: 'APPROVED', centavos: 100 });

        const r = await WebhookService.confirmarPorRetorno('wompi', 'tx-123');

        expect(CobranzaService._interno.aplicarPagoAprobado).not.toHaveBeenCalled();
        // Hacia fuera no se cuenta el motivo: quien prueba ids no aprende cómo funciona la puerta.
        expect(r).toEqual({ estado: 'desconocida' });
    });

    test('aprobado en otra moneda → no se aplica', async () => {
        wompiResponde({ estado: 'aprobada', codigo: 'APPROVED', moneda: 'USD' });

        await WebhookService.confirmarPorRetorno('wompi', 'tx-123');

        expect(CobranzaService._interno.aplicarPagoAprobado).not.toHaveBeenCalled();
    });

    test('el total llega como string DECIMAL y aun así casa con los centavos', async () => {
        // '59999.00' * 100 = 5999900. Si alguien quita el Number() o el redondeo, esto falla.
        wompiResponde({ estado: 'aprobada', codigo: 'APPROVED', centavos: 5999900 });

        await WebhookService.confirmarPorRetorno('wompi', 'tx-123');

        expect(CobranzaService._interno.aplicarPagoAprobado).toHaveBeenCalledTimes(1);
    });
});

describe('rechazos y repeticiones', () => {
    test('un rechazo en el checkout NO suma morosidad', async () => {
        wompiResponde({ estado: 'rechazada', codigo: 'DECLINED' });

        const r = await WebhookService.confirmarPorRetorno('wompi', 'tx-123');

        expect(r).toEqual({ estado: 'rechazada' });
        expect(CobranzaService._interno.registrarIntentoFallido).not.toHaveBeenCalled();
    });

    test('recargar tres veces un pago rechazado no suspende a nadie', async () => {
        wompiResponde({ estado: 'rechazada', codigo: 'DECLINED' });

        for (let i = 0; i < 3; i += 1) {
            await WebhookService.confirmarPorRetorno('wompi', 'tx-123');
        }

        expect(CobranzaService._interno.registrarIntentoFallido).not.toHaveBeenCalled();
    });

    test('una factura ya pagada responde «aprobada» sin pagarse otra vez', async () => {
        wompiResponde({ estado: 'aprobada', codigo: 'APPROVED' });
        Dao.getFacturaPorReferencia.mockResolvedValue(facturaPendiente({ estado: 'pagada' }));

        const r = await WebhookService.confirmarPorRetorno('wompi', 'tx-123');

        expect(r).toEqual({ estado: 'aprobada' });
        expect(CobranzaService._interno.aplicarPagoAprobado).not.toHaveBeenCalled();
    });

    test('todavía pendiente (PSE en curso) → «pendiente», sin tocar nada', async () => {
        wompiResponde({ estado: 'pendiente', codigo: 'PENDING' });

        const r = await WebhookService.confirmarPorRetorno('wompi', 'tx-123');

        expect(r).toEqual({ estado: 'pendiente' });
        expect(CobranzaService._interno.aplicarPagoAprobado).not.toHaveBeenCalled();
        expect(CobranzaService._interno.registrarIntentoFallido).not.toHaveBeenCalled();
    });

    test('una transacción de una factura que no conocemos → «desconocida»', async () => {
        wompiResponde({ estado: 'aprobada', codigo: 'APPROVED', reference: 'OTRA-COSA' });
        Dao.getFacturaPorReferencia.mockResolvedValue(null);

        const r = await WebhookService.confirmarPorRetorno('wompi', 'tx-123');

        expect(r).toEqual({ estado: 'desconocida' });
        expect(CobranzaService._interno.aplicarPagoAprobado).not.toHaveBeenCalled();
    });

    test('sin credenciales configuradas → 503, sin consultar nada', async () => {
        const adaptador = { estaConfigurada: () => false, consultarTransaccion: jest.fn() };
        getAdaptador.mockReturnValue(adaptador);

        await expect(WebhookService.confirmarPorRetorno('wompi', 'tx-123')).rejects.toMatchObject({
            statusCode: 503,
        });
        expect(adaptador.consultarTransaccion).not.toHaveBeenCalled();
    });
});
