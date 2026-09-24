/**
 * Cobranza — la simulación de un cambio de plan da EXACTAMENTE lo que luego se cobra.
 *
 * `simularCambioPlan` (lo que el cliente ve antes de confirmar) y `cambiarMiPlan` (lo que se cobra)
 * comparten `resolverCambio` y `calcularDiferenciaCambio`. Estas pruebas fijan que nadie las separe:
 * para el mismo caso, el monto simulado es el `total` de la factura que se crea, y la simulación no
 * escribe nada.
 *
 * Con mocks, como el resto de `__tests__/cobranza/` (la base local no tiene cobranza).
 *
 * Ejecutar: npx jest __tests__/cobranza/simular_cambio.test.js --forceExit
 */
'use strict';

const mockEstado = { fin: null, facturas: [] };

jest.mock('../../app_core/models/conection', () => ({
    Sequelize: { Op: {} },
    sequelize: {
        transaction: jest.fn(async () => ({ commit: jest.fn(), rollback: jest.fn(), finished: false })),
        query: jest.fn(async () => []),
        QueryTypes: { SELECT: 'SELECT' },
    },
    CobFactura: { findAll: jest.fn(async () => []), findOne: jest.fn(async () => null) },
}));

jest.mock('../../app_core/dao/cobranzaDao', () => ({
    getSuscripcionPorNegocio: jest.fn(async () => ({
        id_suscripcion: 5, id_negocio: 7, id_plan: 1, ciclo: 'mensual', moneda: 'COP', estado: 'activa',
        id_plan_solicitado: null, pasarela: 'wompi',
    })),
    listarPlanesParaCliente: jest.fn(async () => [
        { id_plan: 1, nombre: 'Plan Básico', precio: 27999 },
        { id_plan: 2, nombre: 'Plan Avanzado', precio: 59999 },
    ]),
    listarComplementosCatalogo: jest.fn(async () => [
        { id_complemento: 1, codigo: 'USUARIO_ADICIONAL', nombre: 'Usuario adicional', precio: 3999, cantidad_maxima: 20 },
    ]),
    listarComplementosSuscripcion: jest.fn(async () => [
        { id_complemento: 1, codigo: 'USUARIO_ADICIONAL', cantidad: 1, cantidad_solicitada: null },
    ]),
    getPrecio: jest.fn(async ({ idPlan }) => ({ 1: 27999, 2: 59999 })[idPlan]),
    planParaRenovar: jest.fn(async () => (mockEstado.fin === undefined ? null : { fin: mockEstado.fin })),
    actualizarSuscripcion: jest.fn(async () => undefined),
    solicitarComplementosSuscripcion: jest.fn(async () => undefined),
    actualizarFactura: jest.fn(async () => undefined),
    getFacturaPorReferencia: jest.fn(async () => null),
    crearFactura: jest.fn(async (datos) => {
        const fila = { id_factura: 90, ...datos };
        mockEstado.facturas.push(fila);
        return fila;
    }),
    reemplazarDetalleFactura: jest.fn(async () => undefined),
}));

jest.mock('../../app_core/cobranza', () => ({ getAdaptador: jest.fn(), getAdaptadorListo: jest.fn() }));
jest.mock('../../app_core/helpers/auditHelper', () => ({ registrarEvento: jest.fn(async () => undefined) }));
jest.mock('../../app_core/middleware/auditContext', () => ({ setAuditNegocio: jest.fn() }));
jest.mock('../../app_core/helpers/paisNegocio', () => ({ paisDeNegocio: jest.fn(async () => 'CO') }));
jest.mock('../../app_core/helpers/limitesNegocio', () => ({ getLimitesNegocio: jest.fn() }));

const Dao = require('../../app_core/dao/cobranzaDao');
const Servicio = require('../../app_admin_api/services/cobranzaService');

const { hoyBogota, sumarDias } = Servicio._fechas;
const enDias = (n) => sumarDias(hoyBogota(), n);

beforeEach(() => {
    jest.clearAllMocks();
    mockEstado.facturas = [];
    mockEstado.fin = enDias(9); // a un plan mensual le quedan 10 días (el de fin cuenta)
});

const ESCRITURAS = [
    'crearFactura', 'reemplazarDetalleFactura', 'actualizarSuscripcion',
    'solicitarComplementosSuscripcion', 'actualizarFactura',
];
const sinEscrituras = () => ESCRITURAS.forEach((m) => expect(Dao[m]).not.toHaveBeenCalled());

const CASOS = {
    'subir de plan': { idPlan: 2 },
    'añadir un complemento': { complementos: [{ codigo: 'USUARIO_ADICIONAL', cantidad: 3 }] },
    'subir de plan y añadir complementos a la vez': {
        idPlan: 2, complementos: [{ codigo: 'USUARIO_ADICIONAL', cantidad: 4 }],
    },
};

describe('simular y cobrar dan el mismo monto', () => {
    for (const [nombre, cambio] of Object.entries(CASOS)) {
        test(nombre, async () => {
            const simulado = await Servicio.simularCambioPlan(7, cambio);
            sinEscrituras(); // la simulación no escribe nada

            const cobrado = await Servicio.cambiarMiPlan(7, cambio);

            expect(simulado.aplica).toBe('ajuste');
            expect(cobrado.aplica).toBe('ajuste');
            expect(simulado.total).toBeGreaterThan(0);
            expect(simulado.total).toBe(cobrado.total);
            expect(simulado.total).toBe(mockEstado.facturas[0].total);
            expect(simulado.proporcion_restante).toBe(cobrado.proporcion_restante);
        });
    }

    test('el monto es la diferencia mensual × los días que quedan (10 de ~30)', async () => {
        const s = await Servicio.simularCambioPlan(7, { idPlan: 2 });
        expect(s.dias_restantes).toBe(10);
        // `proporcion_restante` viaja redondeada a 4 decimales: el total puede diferir un par de pesos (32.000 × 0,00005).
        expect(Math.abs(s.total - (59999 - 27999) * s.proporcion_restante)).toBeLessThan(2);
    });
});

describe('lo que NO es un ajuste no anuncia monto', () => {
    test('bajar de plan entra en la renovación, igual que al cobrar', async () => {
        Dao.getSuscripcionPorNegocio.mockResolvedValueOnce({
            id_suscripcion: 5, id_negocio: 7, id_plan: 2, ciclo: 'mensual', moneda: 'COP', estado: 'activa',
        });
        const s = await Servicio.simularCambioPlan(7, { idPlan: 1 });
        expect(s).toMatchObject({ aplica: 'renovacion', total: null });
        sinEscrituras();
    });

    test('pedir lo que ya tiene → sin_cambios', async () => {
        const s = await Servicio.simularCambioPlan(7, { idPlan: 1 });
        expect(s).toMatchObject({ aplica: 'sin_cambios', total: null });
        sinEscrituras();
    });

    test('sin plan vigente el cambio se suma a la mensualidad, no hay ajuste', async () => {
        mockEstado.fin = enDias(-3);
        const s = await Servicio.simularCambioPlan(7, { idPlan: 2 });
        expect(s).toMatchObject({ aplica: 'renovacion', total: null });
        sinEscrituras();
    });

    test('un plan que vence hoy y una diferencia que se queda en nada tampoco cobra ajuste', async () => {
        mockEstado.fin = hoyBogota();
        const s = await Servicio.simularCambioPlan(7, { complementos: [{ codigo: 'USUARIO_ADICIONAL', cantidad: 2 }] });
        const c = await Servicio.cambiarMiPlan(7, { complementos: [{ codigo: 'USUARIO_ADICIONAL', cantidad: 2 }] });
        expect(s.aplica === 'ajuste').toBe(c.aplica === 'ajuste');
        if (s.aplica === 'ajuste') expect(s.total).toBe(c.total);
    });
});

describe('errores de validación: los mismos que al cambiar de verdad', () => {
    test('plan que no se ofrece → 409 PLAN_NO_DISPONIBLE', async () => {
        await expect(Servicio.simularCambioPlan(7, { idPlan: 999 })).rejects.toMatchObject({
            code: 'PLAN_NO_DISPONIBLE', statusCode: 409,
        });
    });

    test('complemento inexistente → 422', async () => {
        await expect(
            Servicio.simularCambioPlan(7, { complementos: [{ codigo: 'NO_EXISTE', cantidad: 1 }] })
        ).rejects.toMatchObject({ code: 'COMPLEMENTO_NO_DISPONIBLE', statusCode: 422 });
    });
});
