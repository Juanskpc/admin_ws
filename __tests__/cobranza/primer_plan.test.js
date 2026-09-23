/**
 * Cobranza — un negocio SIN suscripción elige su primer plan (`cambiarMiPlan` → `contratarPrimerPlan`).
 *
 * Crea tres cosas —la suscripción, la factura del primer mes y el evento de auditoría— y tienen
 * que existir las tres o ninguna. Si la suscripción quedara sin su factura el negocio no podría
 * volver a elegir plan (la siguiente llamada diría «eso es lo que ya tienes») ni pagar nada: es
 * un fallo que no da error, deja al cliente atascado.
 *
 * Todo con mocks: la base no se toca. La «base» de aquí es `mockStore`, y solo lo que una
 * transacción CONFIRMA llega a ella, igual que en Postgres. Además `exigirSuscripcion` solo ve lo
 * pendiente de una transacción si se le pasa esa misma transacción, así que estas pruebas también
 * atrapan el olvido de propagarla.
 *
 * Ejecutar: npx jest __tests__/cobranza/primer_plan.test.js
 */
'use strict';

const mockStore = { suscripciones: [], facturas: [], detalles: [], auditoria: [], transacciones: [] };

/** Una transacción falsa: lo que se escribe con ella queda pendiente hasta el commit. */
function mockNuevaTransaccion() {
    const tx = {
        pend: { suscripciones: [], facturas: [], detalles: [], auditoria: [] },
        commit: jest.fn(async () => {
            for (const k of Object.keys(tx.pend)) mockStore[k].push(...tx.pend[k]);
            tx.pend = { suscripciones: [], facturas: [], detalles: [], auditoria: [] };
        }),
        rollback: jest.fn(async () => {
            tx.pend = { suscripciones: [], facturas: [], detalles: [], auditoria: [] };
        }),
    };
    mockStore.transacciones.push(tx);
    return tx;
}

/** Lo que ve una consulta: lo confirmado, más lo pendiente SOLO de su propia transacción. */
const mockVisibles = (tabla, tx) => [...mockStore[tabla], ...(tx ? tx.pend[tabla] : [])];

jest.mock('../../app_core/models/conection', () => ({
    sequelize: {
        transaction: jest.fn(async () => mockNuevaTransaccion()),
        query: jest.fn(async () => []),
        QueryTypes: { SELECT: 'SELECT' },
    },
    GenerNegocio: { findByPk: jest.fn(async () => ({ id_negocio: 7 })) },
    GenerPlan: {
        findOne: jest.fn(async () => ({ id_plan: 1 })),
        findByPk: jest.fn(async () => ({ nombre: 'Plan Básico' })),
    },
}));

jest.mock('../../app_core/dao/cobranzaDao', () => ({
    listarPlanesParaCliente: jest.fn(async () => [{ id_plan: 1, nombre: 'Plan Básico', precio: 27999 }]),
    listarPasarelas: jest.fn(async () => [{ codigo: 'wompi' }]),
    getSuscripcionPorNegocio: jest.fn(async (_id, { transaction } = {}) => mockVisibles('suscripciones', transaction)[0] ?? null),
    exigirSuscripcion: jest.fn(async (_id, { transaction } = {}) => {
        const s = mockVisibles('suscripciones', transaction)[0];
        if (!s) {
            const e = new Error('Este negocio no tiene una suscripción de cobro configurada.');
            e.code = 'SUSCRIPCION_NO_ENCONTRADA';
            throw e;
        }
        return s;
    }),
    crearSuscripcion: jest.fn(async (datos, { transaction } = {}) => {
        const fila = { id_suscripcion: 50, ...datos };
        (transaction ? transaction.pend.suscripciones : mockStore.suscripciones).push(fila);
        return fila;
    }),
    getFacturaPorReferencia: jest.fn(async (ref, { transaction } = {}) =>
        mockVisibles('facturas', transaction).find((f) => f.referencia === ref) ?? null),
    getFactura: jest.fn(),
    getPrecio: jest.fn(async () => 27999),
    listarComplementosSuscripcion: jest.fn(async () => []),
    crearFactura: jest.fn(async (datos, { transaction } = {}) => {
        const fila = { id_factura: 90, ...datos };
        (transaction ? transaction.pend.facturas : mockStore.facturas).push(fila);
        return fila;
    }),
    reemplazarDetalleFactura: jest.fn(async (id, lineas, { transaction } = {}) => {
        (transaction ? transaction.pend.detalles : mockStore.detalles).push(...lineas);
    }),
}));

jest.mock('../../app_core/cobranza', () => ({
    getAdaptador: jest.fn(() => ({ soportaRecurrente: false })),
    getAdaptadorListo: jest.fn(),
}));
jest.mock('../../app_core/helpers/auditHelper', () => ({
    registrarEvento: jest.fn(async ({ accion, transaction }) => {
        (transaction ? transaction.pend.auditoria : mockStore.auditoria).push(accion);
    }),
}));
jest.mock('../../app_core/middleware/auditContext', () => ({ setAuditNegocio: jest.fn() }));
jest.mock('../../app_core/helpers/paisNegocio', () => ({ paisDeNegocio: jest.fn(async () => 'CO') }));
jest.mock('../../app_core/helpers/limitesNegocio', () => ({ getLimitesNegocio: jest.fn() }));

const Dao = require('../../app_core/dao/cobranzaDao');
const Models = require('../../app_core/models/conection');
const { cambiarMiPlan } = require('../../app_admin_api/services/cobranzaService');

beforeEach(() => {
    for (const k of Object.keys(mockStore)) mockStore[k] = [];
    jest.clearAllMocks();
});

describe('elegir el primer plan', () => {
    test('camino feliz: suscripción, factura, detalle y evento, en UNA transacción', async () => {
        const r = await cambiarMiPlan(7, { idPlan: 1 });

        expect(r).toMatchObject({ aplica: 'primer_plan', cambio: true, total: 27999 });
        expect(mockStore.suscripciones).toHaveLength(1);
        expect(mockStore.facturas).toHaveLength(1);
        expect(mockStore.facturas[0]).toMatchObject({ estado: 'pendiente', id_suscripcion: 50 });
        expect(mockStore.detalles).toHaveLength(1);
        expect(mockStore.auditoria).toEqual(
            expect.arrayContaining(['suscripcion_creada', 'factura_generada', 'primer_plan_elegido']),
        );

        // Una sola transacción: la de fuera. `generarFacturaPeriodo` no abre otra cuando le pasan la suya.
        expect(Models.sequelize.transaction).toHaveBeenCalledTimes(1);
        const [tx] = mockStore.transacciones;
        expect(tx.commit).toHaveBeenCalledTimes(1);
        expect(tx.rollback).not.toHaveBeenCalled();
    });

    test('si falla la factura NO queda suscripción, ni factura, ni eventos', async () => {
        Dao.crearFactura.mockRejectedValueOnce(new Error('boom: falló crear la factura'));

        await expect(cambiarMiPlan(7, { idPlan: 1 })).rejects.toThrow('boom');

        // La suscripción sí se llegó a crear DENTRO de la transacción…
        expect(Dao.crearSuscripcion).toHaveBeenCalledTimes(1);
        // …pero nada llegó a la «base».
        expect(mockStore.suscripciones).toHaveLength(0);
        expect(mockStore.facturas).toHaveLength(0);
        expect(mockStore.detalles).toHaveLength(0);
        expect(mockStore.auditoria).toHaveLength(0);

        const [tx] = mockStore.transacciones;
        expect(tx.rollback).toHaveBeenCalledTimes(1);
        expect(tx.commit).not.toHaveBeenCalled();
    });

    test('tras un fallo se puede volver a intentar: el negocio sigue sin suscripción', async () => {
        Dao.crearFactura.mockRejectedValueOnce(new Error('boom'));
        await expect(cambiarMiPlan(7, { idPlan: 1 })).rejects.toThrow('boom');

        const r = await cambiarMiPlan(7, { idPlan: 1 });

        // Si hubiera quedado la suscripción huérfana, esto sería «sin_cambios» y sin factura.
        expect(r.aplica).toBe('primer_plan');
        expect(mockStore.suscripciones).toHaveLength(1);
        expect(mockStore.facturas).toHaveLength(1);
    });

    test('si falla al crear la suscripción tampoco queda nada', async () => {
        Dao.crearSuscripcion.mockRejectedValueOnce(new Error('boom: suscripción'));

        await expect(cambiarMiPlan(7, { idPlan: 1 })).rejects.toThrow('boom');

        expect(mockStore.suscripciones).toHaveLength(0);
        expect(mockStore.facturas).toHaveLength(0);
        expect(mockStore.transacciones[0].rollback).toHaveBeenCalledTimes(1);
    });

    test('un plan que no se ofrece se rechaza antes de abrir ninguna transacción', async () => {
        await expect(cambiarMiPlan(7, { idPlan: 999 })).rejects.toMatchObject({
            code: 'PLAN_NO_DISPONIBLE',
            statusCode: 409,
        });
        expect(Models.sequelize.transaction).not.toHaveBeenCalled();
    });

    test('sin indicar plan se pide elegir uno (422)', async () => {
        await expect(cambiarMiPlan(7, { complementos: [] })).rejects.toMatchObject({
            code: 'PLAN_REQUERIDO',
            statusCode: 422,
        });
        expect(Models.sequelize.transaction).not.toHaveBeenCalled();
    });
});
