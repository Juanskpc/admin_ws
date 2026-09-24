/**
 * Cobranza — el controlador de la simulación traduce `complementos` igual que el cuerpo del POST:
 * ausente → null («no toca»), vacío (`complementos=`) → [] («todos a cero»).
 *
 * Confundirlos hace que se simule una cosa y se cobre otra. Solo la traducción y el chequeo de
 * dueño: el cálculo lo cubre `simular_cambio.test.js`.
 *
 * Ejecutar: npx jest __tests__/cobranza/simular_cambio_controlador.test.js --forceExit
 */
'use strict';

jest.mock('../../app_admin_api/services/cobranzaService', () => ({
    simularCambioPlan: jest.fn(async () => ({ aplica: 'sin_cambios', total: null })),
    usuarioAdministraNegocio: jest.fn(async () => true),
}));
jest.mock('../../app_core/middleware/auth', () => ({
    alcanceDeNegocios: jest.fn(async () => ({ superAdmin: false })),
}));

const Servicio = require('../../app_admin_api/services/cobranzaService');
const { simularCambio } = require('../../app_admin_api/controllers/cobranzaController');

function llamar(query) {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    return simularCambio({ query, usuario: { id_usuario: 1 } }, res).then(() => res);
}

beforeEach(() => jest.clearAllMocks());

describe('simularCambio: complementos', () => {
    test('ausente → null (no los toca)', async () => {
        await llamar({ id_negocio: '7', id_plan: '2' });
        expect(Servicio.simularCambioPlan).toHaveBeenCalledWith(7, { idPlan: 2, complementos: null });
    });

    test('vacío (`complementos=`) → [] (todos a cero)', async () => {
        await llamar({ id_negocio: '7', complementos: '' });
        expect(Servicio.simularCambioPlan).toHaveBeenCalledWith(7, { idPlan: null, complementos: [] });
    });

    test('con lista → [{codigo, cantidad}]', async () => {
        await llamar({ id_negocio: '7', complementos: 'USUARIO_ADICIONAL:2,CAJA_ADICIONAL:0' });
        expect(Servicio.simularCambioPlan).toHaveBeenCalledWith(7, {
            idPlan: null,
            complementos: [
                { codigo: 'USUARIO_ADICIONAL', cantidad: 2 },
                { codigo: 'CAJA_ADICIONAL', cantidad: 0 },
            ],
        });
    });
});

test('un negocio ajeno no se simula (403)', async () => {
    Servicio.usuarioAdministraNegocio.mockResolvedValueOnce(false);
    const res = await llamar({ id_negocio: '99' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Servicio.simularCambioPlan).not.toHaveBeenCalled();
});
