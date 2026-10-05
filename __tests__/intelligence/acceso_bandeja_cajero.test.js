/**
 * Quién ve la Bandeja (2026-10-04): administrador siempre; CAJERO solo si el plan del negocio
 * incluye WhatsApp; cualquier otro rol, no. Y conectar/desconectar el número, solo administrador.
 *
 * Correr con:  npx jest __tests__/intelligence/acceso_bandeja_cajero.test.js
 */
'use strict';

jest.mock('../../app_core/middleware/auth', () => ({ alcanceDeNegocios: jest.fn() }));
jest.mock('../../intelligence/core/features', () => ({
    FEATURE: { ASISTENTE_IA: 'asistente_ia' },
    featuresDeNegocios: jest.fn(),
}));

const Models = require('../../app_core/models/conection');
const { alcanceDeNegocios } = require('../../app_core/middleware/auth');
const { featuresDeNegocios } = require('../../intelligence/core/features');
const { alcanceBandeja, esAdministradorDelNegocio } = require('../../app_admin_api/services/accesoBandejaService');

let consulta;
beforeEach(() => {
    consulta = jest.spyOn(Models.sequelize, 'query');
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => Models.sequelize.close());

const conRoles = (filas) => consulta.mockResolvedValueOnce(filas);

test('el super admin ve todo', async () => {
    alcanceDeNegocios.mockResolvedValue({ superAdmin: true, idNegocios: [] });
    expect(await alcanceBandeja(1)).toEqual({ superAdmin: true, idNegocios: [] });
});

test('el administrador ve su negocio aunque no tenga el plan', async () => {
    alcanceDeNegocios.mockResolvedValue({ superAdmin: false, idNegocios: [6] });
    conRoles([{ id_negocio: 6, rol: 'ADMINISTRADOR' }]);
    expect((await alcanceBandeja(2)).idNegocios).toEqual([6]);
    expect(featuresDeNegocios).not.toHaveBeenCalled();
});

test('el cajero ve el negocio CON plan de WhatsApp y no el que no lo tiene', async () => {
    alcanceDeNegocios.mockResolvedValue({ superAdmin: false, idNegocios: [6, 7] });
    conRoles([
        { id_negocio: 6, rol: 'CAJERO' },
        { id_negocio: 7, rol: 'CAJERO' },
    ]);
    featuresDeNegocios.mockResolvedValue(new Map([[6, ['asistente_ia']], [7, []]]));
    expect((await alcanceBandeja(3)).idNegocios).toEqual([6]);
});

test('un mesero o domiciliario no la ve, tenga el plan que tenga', async () => {
    alcanceDeNegocios.mockResolvedValue({ superAdmin: false, idNegocios: [6] });
    conRoles([{ id_negocio: 6, rol: 'MESERO' }]);
    featuresDeNegocios.mockResolvedValue(new Map([[6, ['asistente_ia']]]));
    expect((await alcanceBandeja(4)).idNegocios).toEqual([]);
});

test('si no se puede leer el plan, el cajero no entra (falla cerrado)', async () => {
    alcanceDeNegocios.mockResolvedValue({ superAdmin: false, idNegocios: [6] });
    conRoles([{ id_negocio: 6, rol: 'CAJERO' }]);
    featuresDeNegocios.mockRejectedValue(new Error('caída'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await alcanceBandeja(3)).idNegocios).toEqual([]);
});

test('esAdministradorDelNegocio: el cajero no, el administrador sí', async () => {
    alcanceDeNegocios.mockResolvedValue({ superAdmin: false, idNegocios: [6] });
    consulta.mockResolvedValueOnce([]);
    expect(await esAdministradorDelNegocio(3, 6)).toBe(false);
    consulta.mockResolvedValueOnce([{ '?column?': 1 }]);
    expect(await esAdministradorDelNegocio(2, 6)).toBe(true);
});
