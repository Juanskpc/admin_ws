/**
 * Menú → ligar un producto con su empaque (validación del servicio de carta).
 *
 * Correr con:  npx jest __tests__/restaurante/empaque_producto_admin.test.js
 */
const Models = require('../../app_core/models/conection');
const { validarEmpaque } = require('../../app_restaurante_api/services/cartaAdminService');

describe('validarEmpaque', () => {
    const buscar = jest.spyOn(Models.CartaProducto, 'findOne');
    afterEach(() => buscar.mockReset());
    afterAll(() => buscar.mockRestore());

    test('sin empaque (null) lo quita y deja la cantidad en 1', async () => {
        expect(await validarEmpaque({ idNegocio: 6, idEmpaque: null, cantidad: 5 })).toEqual({
            id: null,
            cantidad: 1,
        });
        expect(buscar).not.toHaveBeenCalled();
    });

    test('un empaque del negocio, con cantidad por defecto 1', async () => {
        buscar.mockResolvedValue({ id_producto: 56 });
        expect(await validarEmpaque({ idNegocio: 6, idProducto: 30, idEmpaque: '56' })).toEqual({
            id: 56,
            cantidad: 1,
        });
        // Se busca SIEMPRE dentro del negocio y solo entre productos activos.
        expect(buscar.mock.calls[0][0].where).toMatchObject({ id_producto: 56, id_negocio: 6, estado: 'A' });
    });

    test('un producto de otro negocio (o inexistente) se rechaza', async () => {
        buscar.mockResolvedValue(null);
        await expect(validarEmpaque({ idNegocio: 6, idEmpaque: 999 })).rejects.toMatchObject({
            code: 'EMPAQUE_INVALIDO',
            statusCode: 400,
        });
    });

    test('un producto no puede ser su propio empaque', async () => {
        await expect(
            validarEmpaque({ idNegocio: 6, idProducto: 30, idEmpaque: 30 })
        ).rejects.toMatchObject({ code: 'EMPAQUE_INVALIDO' });
    });

    test.each([0.5, 0, 21, 'x'])('cantidad %p fuera de rango', async (cantidad) => {
        buscar.mockResolvedValue({ id_producto: 57 });
        await expect(
            validarEmpaque({ idNegocio: 6, idEmpaque: 57, cantidad })
        ).rejects.toMatchObject({ code: 'EMPAQUE_INVALIDO' });
    });

    test('promo: 3 medianos', async () => {
        buscar.mockResolvedValue({ id_producto: 57 });
        expect(await validarEmpaque({ idNegocio: 6, idEmpaque: 57, cantidad: 3 })).toEqual({
            id: 57,
            cantidad: 3,
        });
    });
});
