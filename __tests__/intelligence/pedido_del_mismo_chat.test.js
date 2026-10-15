/**
 * Un pedido es de quien lo pregunta si coincide el teléfono O si se tomó en ese mismo chat
 * (Zona Burger, 2026-10-11/14: clientes de WhatsApp sin número visible a los que se les negaba su
 * propio pedido). Sin base de datos: el modelo de pedidos y la consulta del chat van simulados.
 *
 * Correr con:  npx jest __tests__/intelligence/pedido_del_mismo_chat.test.js
 */
const Models = require('../../app_core/models/conection');
const registry = require('../../intelligence/core/registry');
const { TIPO } = require('../../app_core/authz/principal');
const adaptador = require('../../intelligence/adapters/restaurante');

beforeAll(() => adaptador.registrarCapacidades());
afterAll(() => registry._limpiar());

const ORDEN = {
    id_orden: 1,
    numero_orden: 'ORD-8196',
    estado: 'ABIERTA',
    estado_cocina: 'PENDIENTE',
    estado_pago: 'pendiente_pago',
    tipo_pedido: 'DOMICILIO',
    contacto_telefono: '3154174812',
    total: 16000,
    fecha_creacion: new Date(),
    aviso_listo_en: null,
};

const contacto = (telefono = null) => ({ tipo: TIPO.CONTACTO, telefono_verificado: telefono });

function consultar({ principal, idConversacion = null }) {
    return registry.obtener('consultar_estado_pedido').ejecutar({
        idNegocio: 6,
        args: { numero_orden: 'ORD-8196' },
        contexto: { principal, idConversacion, transaction: null },
    });
}

describe('pertenencia de un pedido', () => {
    let consulta;
    beforeEach(() => {
        jest.spyOn(Models.PedidOrden, 'findOne').mockResolvedValue({ ...ORDEN });
        consulta = jest.spyOn(Models.sequelize, 'query');
    });
    afterEach(() => jest.restoreAllMocks());

    test('sin número visible pero pedido en este chat: se responde', async () => {
        consulta.mockResolvedValue([{ es: 1 }]);
        await expect(consultar({ principal: contacto(), idConversacion: 'c-1' })).resolves.toBeTruthy();
        const [sql, opciones] = consulta.mock.calls[0];
        expect(sql).toMatch(/tomar_pedido/);
        expect(opciones.replacements.c).toBe('c-1');
        // Solo el mensaje que escribe la plataforma al tomar el pedido, y sin casar ORD-81960.
        expect(opciones.replacements.patron).toBe('El número es ORD\\-8196([^0-9]|$)');
    });

    test('sin número visible y pedido de otro chat: se deniega', async () => {
        consulta.mockResolvedValue([]);
        await expect(consultar({ principal: contacto(), idConversacion: 'c-2' })).rejects.toMatchObject({
            code: 'PEDIDO_NO_ES_DE_QUIEN_PIDE',
        });
    });

    test('sin chat (WebChat, pruebas) se deniega sin consultar nada', async () => {
        await expect(consultar({ principal: contacto() })).rejects.toMatchObject({
            code: 'PEDIDO_NO_ES_DE_QUIEN_PIDE',
        });
        expect(consulta).not.toHaveBeenCalled();
    });

    test('con el teléfono del pedido basta, sin mirar el chat', async () => {
        consulta.mockResolvedValue([]);
        await expect(consultar({ principal: contacto('+573154174812') })).resolves.toBeTruthy();
        expect(consulta.mock.calls.some(([sql]) => /tomar_pedido/.test(sql))).toBe(false);
    });

    test('si la consulta del chat falla, se deniega (falla cerrada)', async () => {
        consulta.mockRejectedValue(new Error('se cayó la base'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(consultar({ principal: contacto(), idConversacion: 'c-1' })).rejects.toMatchObject({
            code: 'PEDIDO_NO_ES_DE_QUIEN_PIDE',
        });
    });
});
