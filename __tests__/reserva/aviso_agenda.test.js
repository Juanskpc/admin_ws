/**
 * Avisos en vivo de la Agenda (SSE) — hooks de ReservaCita / ReservaBloqueo.
 *
 * Lo que se protege: que cualquier escritura de una cita avise a la Agenda, que el aviso salga
 * SOLO si la transacción confirma (un dry-run del Policy Gate que se deshace no puede anunciar
 * una cita que nunca existió) y que registrar dos veces no duplique avisos.
 */
'use strict';

function modeloFalso() {
    const hooks = {};
    return {
        hooks,
        addHook(tipo, nombre, fn) {
            // Sequelize reemplaza un hook con el mismo nombre; aquí basta con acumular para ver
            // si alguien registra dos veces.
            (hooks[tipo] ||= []).push({ nombre, fn });
        },
        disparar(tipo, instancia, options) {
            for (const h of hooks[tipo] || []) h.fn(instancia, options);
        },
    };
}

const mockModelos = { ReservaCita: modeloFalso(), ReservaBloqueo: modeloFalso() };
jest.mock('../../app_core/models/conection', () => mockModelos);

const mockEmitidos = [];
jest.mock('../../app_core/realtime', () => ({ emitir: (aviso) => mockEmitidos.push(aviso) }));

const avisos = require('../../app_reserva_api/services/avisoService');

function transaccionFalsa() {
    const alConfirmar = [];
    return {
        afterCommit: (fn) => alConfirmar.push(fn),
        confirmar: () => alConfirmar.forEach((fn) => fn()),
    };
}

beforeAll(() => {
    avisos.registrarHooks();
    avisos.registrarHooks(); // idempotente
});
beforeEach(() => { mockEmitidos.length = 0; });

test('registrar dos veces no duplica los hooks', () => {
    expect(mockModelos.ReservaCita.hooks.afterCreate).toHaveLength(1);
    expect(mockModelos.ReservaBloqueo.hooks.afterDestroy).toHaveLength(1);
});

test('una cita creada dentro de una transacción avisa SOLO al confirmar', () => {
    const t = transaccionFalsa();
    mockModelos.ReservaCita.disparar('afterCreate', { id_negocio: 10 }, { transaction: t });
    expect(mockEmitidos).toHaveLength(0);

    t.confirmar();
    expect(mockEmitidos).toEqual([{ canal: 'reserva', idNegocio: 10, temas: ['agenda'] }]);
});

test('una transacción que se deshace no avisa nunca', () => {
    const t = transaccionFalsa();
    mockModelos.ReservaCita.disparar('afterUpdate', { id_negocio: 10 }, { transaction: t });
    // Sin confirmar (rollback): los `afterCommit` no se ejecutan.
    expect(mockEmitidos).toHaveLength(0);
});

test('sin transacción avisa en el acto; también los bloqueos', () => {
    mockModelos.ReservaBloqueo.disparar('afterDestroy', { id_negocio: 12 }, {});
    expect(mockEmitidos).toEqual([{ canal: 'reserva', idNegocio: 12, temas: ['agenda'] }]);
});

test('sin id_negocio no se avisa a nadie', () => {
    mockModelos.ReservaCita.disparar('afterUpdate', {}, {});
    expect(mockEmitidos).toHaveLength(0);
});
