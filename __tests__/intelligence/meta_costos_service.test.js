'use strict';
/**
 * Terceros — consumo de WhatsApp según Meta (`pricing_analytics`).
 *
 * Sin base y sin red: la consulta de números y `fetch` se sustituyen. Lo que se prueba es lo que
 * puede mentir en silencio: días cortados en UTC en vez de en hora de Colombia, la cuota de
 * 1.000 sumada por cuenta en vez de por número, y una WABA de cliente contada como gasto nuestro.
 */
jest.mock('../../app_core/models/conection', () => ({
    sequelize: { query: jest.fn(), QueryTypes: { SELECT: 'SELECT' } },
}));

const Models = require('../../app_core/models/conection');
const Meta = require('../../app_admin_api/services/metaCostosService');

// Medianoche de Bogotá = 05:00 UTC.
const medianocheBogota = (fecha) => Date.parse(`${fecha}T05:00:00Z`) / 1000;

function respuesta(cuerpo) {
    return { ok: true, status: 200, json: async () => cuerpo };
}

describe('fechas en hora de Colombia', () => {
    test('el start de Meta (05:00 UTC) es el día de Bogotá, no el anterior', () => {
        expect(Meta.fechaBogota(medianocheBogota('2026-10-01'))).toBe('2026-10-01');
    });

    test('a las 9 p. m. del 4 de octubre en Bogotá todavía es 4, aunque en UTC ya sea 5', () => {
        const ahora = new Date('2026-10-05T02:00:00Z');
        expect(Meta.fechaBogota(Meta.inicioDiaBogota(ahora))).toBe('2026-10-04');
        expect(Meta.fechaBogota(Meta.inicioMesBogota(ahora))).toBe('2026-10-01');
    });
});

describe('esCobrado', () => {
    test('gratis por servicio no se cobra; REGULAR o con costo sí', () => {
        expect(Meta.esCobrado({ pricing_type: 'FREE_CUSTOMER_SERVICE' })).toBe(false);
        expect(Meta.esCobrado({ pricing_type: 'REGULAR' })).toBe(true);
        expect(Meta.esCobrado({ pricing_type: 'X', cost: 12 })).toBe(true);
    });
});

describe('consultarConsumoMeta + resumirMeta', () => {
    const fetchOriginal = global.fetch;
    const envOriginal = { ...process.env };

    beforeEach(() => {
        Meta._vaciarCache();
        process.env.WHATSAPP_TOKEN = 'token-prueba';
        process.env.WHATSAPP_WABA_ID = 'waba-escalapp';
        Models.sequelize.query.mockResolvedValue([
            { id_negocio: 6, nombre: 'Zona', waba_id: 'waba-zona', numero_e164: '+57 323 000 0001', origen: 'embedded_signup', estado: 'A' },
            { id_negocio: 12, nombre: 'Pregonchos', waba_id: null, numero_e164: '573150000002', origen: 'manual', estado: 'A' },
        ]);
    });
    afterAll(() => {
        global.fetch = fetchOriginal;
        process.env = envOriginal;
    });

    function metaResponde(porWaba) {
        global.fetch = jest.fn(async (url) => {
            const waba = url.split('/v21.0/')[1].split('?')[0];
            if (url.includes('fields=currency')) return respuesta({ currency: 'COP' });
            return respuesta({ pricing_analytics: { data: [{ data_points: porWaba[waba] || [] }] } });
        });
    }

    test('separa lo que paga EscalApp de lo que paga el cliente, y cuenta la cuota por número', async () => {
        metaResponde({
            'waba-escalapp': [
                { start: medianocheBogota('2026-10-02'), phone_number: '573150000002', pricing_category: 'UTILITY', pricing_type: 'REGULAR', volume: 4, cost: 400 },
            ],
            'waba-zona': [
                { start: medianocheBogota('2026-09-30'), phone_number: '573230000001', pricing_category: 'SERVICE', pricing_type: 'FREE_CUSTOMER_SERVICE', volume: 500 },
                { start: medianocheBogota('2026-10-01'), phone_number: '573230000001', pricing_category: 'SERVICE', pricing_type: 'FREE_CUSTOMER_SERVICE', volume: 900 },
                { start: medianocheBogota('2026-10-02'), phone_number: '573230000001', pricing_category: 'SERVICE', pricing_type: 'REGULAR', volume: 150, cost: 1500 },
            ],
        });

        const consumo = await Meta.consultarConsumoMeta(medianocheBogota('2026-09-28'));
        const { cuentas, por_dia: porDia } = Meta.resumirMeta(consumo, {
            desdeVentana: '2026-09-28',
            inicioMes: '2026-10-01',
        });

        const escalapp = cuentas.find((c) => c.paga === 'escalapp');
        const zona = cuentas.find((c) => c.paga === 'cliente');

        expect(escalapp.costo_mes).toBe(400);
        expect(escalapp.numeros[0].negocio).toBe('Pregonchos'); // el número se reconoce aunque la fila no tenga waba
        expect(zona.nombre).toBe('Zona');
        expect(zona.costo_mes).toBe(1500);

        // Septiembre no cuenta para la cuota de octubre.
        expect(zona.numeros[0]).toMatchObject({ servicio_mes: 1050, cobrados_mes: 150, gratis_limite: 1000 });
        expect(zona.numeros[0].telefono).toBe('+57 ··· 0001');

        expect(porDia.get('2026-10-02')).toMatchObject({ escalapp: 4, clientes: 150, costo_escalapp: 400 });
    });

    test('si una cuenta falla, las demás siguen y el error queda en esa cuenta', async () => {
        global.fetch = jest.fn(async (url) => {
            if (url.includes('waba-zona')) {
                return { ok: false, status: 403, json: async () => ({ error: { message: 'sin permiso' } }) };
            }
            if (url.includes('fields=currency')) return respuesta({ currency: 'COP' });
            return respuesta({ pricing_analytics: { data: [] } });
        });

        const consumo = await Meta.consultarConsumoMeta(medianocheBogota('2026-10-01'));
        expect(consumo.cuentas.find((c) => c.nombre === 'Zona').error).toBe('sin permiso');
        expect(consumo.cuentas.find((c) => c.nombre === 'EscalApp').error).toBeNull();
    });

    test('sin token falla con error tipado y no llama a Meta', async () => {
        delete process.env.WHATSAPP_TOKEN;
        global.fetch = jest.fn();
        await expect(Meta.consultarConsumoMeta(0)).rejects.toMatchObject({ code: 'META_TOKEN_FALTA' });
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
