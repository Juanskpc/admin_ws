/**
 * Cobranza — el precio de un plan depende del APLICATIVO del negocio (2026-09-24).
 *
 * La landing publica Reserva más caro que Restaurante y `cob_precio_plan` tiene una fila de
 * precio por defecto (`id_tipo_modulo IS NULL`) y, opcionalmente, una propia por aplicativo. Estas
 * pruebas fijan lo que no da error cuando se rompe:
 *
 *   - un negocio de RESTAURANTE cotiza exactamente lo de siempre (el precio por defecto);
 *   - uno de RESERVA toma el suyo;
 *   - TODO lo que cotiza le pasa el negocio a `getPrecio` / `listarPlanesParaCliente`: el total
 *     mensual, la factura del primer plan (que es `calcularCobro`, el mismo camino de la renovación
 *     y del recálculo de una factura pendiente), y la lista de planes que se le ofrece.
 *
 * Todo con mocks (la base local no tiene cobranza). La REGLA de resolución —el precio del aplicativo
 * si existe, y si no el de por defecto— la implementa el mock de `getPrecio` igual que el SQL del
 * DAO, y el SQL en sí se prueba aparte (segunda mitad) fijando lo que le manda a la base.
 *
 * Ejecutar: npx jest __tests__/cobranza/precio_aplicativo.test.js
 */
'use strict';

const RESTAURANTE = 1;
const RESERVA = 9;
/** Negocio → aplicativo (`gener_negocio.id_tipo_negocio`). */
const mockModuloDe = { 7: RESTAURANTE, 8: RESERVA };
/** (plan, aplicativo|0) → precio. `0` = por defecto. Solo Básico tiene precio propio de Reserva. */
const mockPrecios = new Map([
    ['1:0', 27999], ['1:9', 37999],
    ['2:0', 59999],                       // Avanzado: sin fila de Reserva → cae al por defecto
]);
const mockNombres = { 1: 'Plan Básico', 2: 'Plan Avanzado' };

const mockStore = { suscripciones: [], facturas: [] };
const mockTx = () => {
    const tx = {
        pend: { suscripciones: [], facturas: [] },
        commit: jest.fn(async () => {
            mockStore.suscripciones.push(...tx.pend.suscripciones);
            mockStore.facturas.push(...tx.pend.facturas);
            tx.pend = { suscripciones: [], facturas: [] };
        }),
        rollback: jest.fn(async () => { tx.pend = { suscripciones: [], facturas: [] }; }),
    };
    return tx;
};
const mockVista = (t, tx) => [...mockStore[t], ...(tx ? tx.pend[t] : [])];

/** La regla del DAO: el precio del aplicativo si lo hay, y si no el de por defecto. */
const mockPrecioDe = ({ idPlan, idNegocio, idTipoModulo }) => {
    const modulo = idTipoModulo ?? mockModuloDe[idNegocio] ?? 0;
    return mockPrecios.get(`${idPlan}:${modulo}`) ?? mockPrecios.get(`${idPlan}:0`) ?? null;
};

jest.mock('../../app_core/models/conection', () => ({
    Sequelize: { Op: {} },   // el DAO real (segunda mitad) lo desestructura al cargarse
    sequelize: {
        transaction: jest.fn(async () => mockTx()),
        query: jest.fn(async () => []),
        QueryTypes: { SELECT: 'SELECT' },
    },
    GenerNegocio: { findByPk: jest.fn(async () => ({ id_negocio: 7 })) },
    GenerPlan: {
        findOne: jest.fn(async () => ({ id_plan: 1 })),
        findByPk: jest.fn(async (id) => ({ nombre: mockNombres[id] })),
    },
}));

jest.mock('../../app_core/dao/cobranzaDao', () => ({
    listarPlanesParaCliente: jest.fn(async ({ idNegocio, idTipoModulo }) =>
        [1, 2].map((id) => ({ id_plan: id, nombre: mockNombres[id], precio: mockPrecioDe({ idPlan: id, idNegocio, idTipoModulo }) }))),
    listarComplementosCatalogo: jest.fn(async () => [
        { id_complemento: 1, codigo: 'USUARIO_ADICIONAL', nombre: 'Usuario adicional', precio: 3999, cantidad_maxima: 20 },
    ]),
    listarPasarelas: jest.fn(async () => [{ codigo: 'wompi' }]),
    getSuscripcionPorNegocio: jest.fn(async (_i, { transaction } = {}) => mockVista('suscripciones', transaction)[0] ?? null),
    exigirSuscripcion: jest.fn(async (_i, { transaction } = {}) => {
        const s = mockVista('suscripciones', transaction)[0];
        if (!s) throw Object.assign(new Error('sin suscripción'), { code: 'SUSCRIPCION_NO_ENCONTRADA' });
        return s;
    }),
    crearSuscripcion: jest.fn(async (datos, { transaction } = {}) => {
        const fila = { id_suscripcion: 50, ...datos };
        (transaction ? transaction.pend.suscripciones : mockStore.suscripciones).push(fila);
        return fila;
    }),
    getFacturaPorReferencia: jest.fn(async () => null),
    getFactura: jest.fn(),
    getPrecio: jest.fn(async (args) => {
        const precio = mockPrecioDe(args);
        if (precio == null) throw Object.assign(new Error('sin precio'), { code: 'PRECIO_NO_CONFIGURADO' });
        return precio;
    }),
    listarComplementosSuscripcion: jest.fn(async () => []),
    crearFactura: jest.fn(async (datos, { transaction } = {}) => {
        const fila = { id_factura: 90, ...datos };
        (transaction ? transaction.pend.facturas : mockStore.facturas).push(fila);
        return fila;
    }),
    reemplazarDetalleFactura: jest.fn(async () => undefined),
}));

jest.mock('../../app_core/cobranza', () => ({
    getAdaptador: jest.fn(() => ({ soportaRecurrente: false })),
    getAdaptadorListo: jest.fn(),
}));
jest.mock('../../app_core/helpers/auditHelper', () => ({ registrarEvento: jest.fn(async () => undefined) }));
jest.mock('../../app_core/middleware/auditContext', () => ({ setAuditNegocio: jest.fn() }));
jest.mock('../../app_core/helpers/paisNegocio', () => ({ paisDeNegocio: jest.fn(async () => 'CO') }));
jest.mock('../../app_core/helpers/limitesNegocio', () => ({ getLimitesNegocio: jest.fn() }));

const Dao = require('../../app_core/dao/cobranzaDao');
const { cambiarMiPlan, previsualizarTotalMensual } = require('../../app_admin_api/services/cobranzaService');

beforeEach(() => {
    mockStore.suscripciones = [];
    mockStore.facturas = [];
    jest.clearAllMocks();
});

describe('el total mensual sale del aplicativo del negocio', () => {
    test('un negocio de Restaurante cotiza el precio de siempre', async () => {
        const t = await previsualizarTotalMensual(7, { idPlan: 1, complementos: [] });
        expect(t.precio_plan).toBe(27999);
        expect(t.total).toBe(27999);
    });

    test('uno de Reserva toma el suyo', async () => {
        const t = await previsualizarTotalMensual(8, { idPlan: 1, complementos: [] });
        expect(t.precio_plan).toBe(37999);
        expect(t.total).toBe(37999);
    });

    test('con complementos: plan del aplicativo + lo que se cobra', async () => {
        const c = [{ codigo: 'USUARIO_ADICIONAL', cantidad_facturable: 2 }];
        expect((await previsualizarTotalMensual(7, { idPlan: 1, complementos: c })).total).toBe(27999 + 2 * 3999);
        expect((await previsualizarTotalMensual(8, { idPlan: 1, complementos: c })).total).toBe(37999 + 2 * 3999);
    });

    test('un plan sin precio propio de Reserva cae al de por defecto (Reserva no queda sin precio)', async () => {
        expect((await previsualizarTotalMensual(8, { idPlan: 2, complementos: [] })).total).toBe(59999);
    });

    test('le pasa el negocio a getPrecio (si no, todo cotizaría el precio por defecto)', async () => {
        await previsualizarTotalMensual(8, { idPlan: 1, complementos: [] });
        expect(Dao.getPrecio).toHaveBeenCalledWith(expect.objectContaining({ idPlan: 1, idNegocio: 8 }));
    });
});

describe('la factura del primer plan (calcularCobro) usa el precio del aplicativo', () => {
    test('Restaurante → $27.999; Reserva → $37.999', async () => {
        const rest = await cambiarMiPlan(7, { idPlan: 1 });
        expect(rest).toMatchObject({ aplica: 'primer_plan', total: 27999 });

        mockStore.suscripciones = [];
        mockStore.facturas = [];
        const resv = await cambiarMiPlan(8, { idPlan: 1 });
        expect(resv).toMatchObject({ aplica: 'primer_plan', total: 37999 });
    });

    test('calcularCobro le pasa el negocio de la suscripción a getPrecio', async () => {
        await cambiarMiPlan(8, { idPlan: 1 });
        expect(Dao.getPrecio).toHaveBeenCalledWith(expect.objectContaining({ idPlan: 1, idNegocio: 8 }), expect.anything());
    });

    test('la lista de planes que se le ofrece también es la de su aplicativo', async () => {
        await cambiarMiPlan(8, { idPlan: 1 });
        expect(Dao.listarPlanesParaCliente).toHaveBeenCalledWith(expect.objectContaining({ idNegocio: 8 }));
    });

    test('elegir un plan que no se le ofrece a su aplicativo sigue siendo 409', async () => {
        await expect(cambiarMiPlan(8, { idPlan: 999 })).rejects.toMatchObject({ code: 'PLAN_NO_DISPONIBLE', statusCode: 409 });
    });
});

// ── El SQL del DAO ─────────────────────────────────────────────────────────────────────────────
// La mitad anterior usa un DAO simulado. Esta comprueba lo que el DAO REAL le manda a la base:
// que resuelve el aplicativo desde el negocio y que su consulta prefiere la fila del aplicativo y
// cae a la de por defecto. (La semántica completa se verifica además contra la base de desarrollo.)
describe('cobranzaDao: resolución del precio por aplicativo', () => {
    let RealDao;
    let query;

    beforeAll(() => {
        jest.isolateModules(() => {
            jest.unmock('../../app_core/dao/cobranzaDao');
            RealDao = jest.requireActual('../../app_core/dao/cobranzaDao');
        });
        query = require('../../app_core/models/conection').sequelize.query;
    });

    beforeEach(() => {
        query.mockReset();
        query.mockImplementation(async (sql) => {
            if (/FROM general\.gener_negocio/.test(sql)) return [{ id_tipo_negocio: RESERVA }];
            return [{ precio: '37999.00' }];
        });
    });

    test('getPrecio: busca el aplicativo del negocio y filtra por el suyo o el de por defecto', async () => {
        const precio = await RealDao.getPrecio({ idPlan: 1, moneda: 'COP', ciclo: 'mensual', idNegocio: 8 });
        expect(precio).toBe(37999);

        const [, precioSql] = query.mock.calls;
        expect(precioSql[0]).toMatch(/id_tipo_modulo IS NULL OR id_tipo_modulo = :modulo/);
        expect(precioSql[0]).toMatch(/ORDER BY \(id_tipo_modulo IS NULL\) ASC/);
        expect(precioSql[1].replacements).toMatchObject({ idPlan: 1, modulo: RESERVA });
    });

    test('getPrecio sin negocio ni aplicativo usa solo el precio por defecto (modulo = null)', async () => {
        await RealDao.getPrecio({ idPlan: 1, moneda: 'COP', ciclo: 'mensual' });
        expect(query.mock.calls).toHaveLength(1);
        expect(query.mock.calls[0][1].replacements.modulo).toBeNull();
    });

    test('un aplicativo dado explícitamente (la compra en línea) no consulta el negocio', async () => {
        await RealDao.getPrecio({ idPlan: 1, moneda: 'COP', ciclo: 'mensual', idTipoModulo: RESERVA });
        expect(query.mock.calls).toHaveLength(1);
        expect(query.mock.calls[0][1].replacements.modulo).toBe(RESERVA);
    });

    test('listarPlanesParaCliente: un solo precio por plan, el del aplicativo antes que el de por defecto', async () => {
        await RealDao.listarPlanesParaCliente({ moneda: 'COP', ciclo: 'mensual', idNegocio: 8 });
        const [, listaSql] = query.mock.calls;
        expect(listaSql[0]).toMatch(/DISTINCT ON \(p\.id_plan\)/);
        expect(listaSql[0]).toMatch(/ORDER BY p\.id_plan, \(pr\.id_tipo_modulo IS NULL\) ASC/);
        expect(listaSql[1].replacements.modulo).toBe(RESERVA);
    });
});
