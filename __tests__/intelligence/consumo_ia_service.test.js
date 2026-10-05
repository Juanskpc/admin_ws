'use strict';
/**
 * Consumo IA — el cálculo del saldo y la lectura de la API de costos de OpenAI.
 *
 * Sin base y sin red: `fetch` se sustituye. Lo que se prueba es lo que puede mentir en
 * silencio — un saldo que cuenta recargas anteriores al punto de partida, un promedio que
 * incluye el día a medias, o una caché que devuelve conceptos de días que no se pidieron.
 */
const Consumo = require('../../app_admin_api/services/consumoIaService');

const DIA = 86_400;
const seg = (iso) => Date.parse(`${iso}T00:00:00Z`) / 1000;

function respuestaOpenAI(cubetas, extra = {}) {
    return {
        ok: true,
        status: 200,
        json: async () => ({ data: cubetas, has_more: false, next_page: null, ...extra }),
    };
}

function cubeta(fecha, partidas) {
    return {
        start_time: seg(fecha),
        end_time: seg(fecha) + DIA,
        results: partidas.map(([line_item, value]) => ({ line_item, amount: { value, currency: 'usd' } })),
    };
}

describe('calcularSaldo', () => {
    const porDia = [
        { fecha: '2026-09-30', usd: 1 },
        { fecha: '2026-10-01', usd: 0.5 },
        { fecha: '2026-10-02', usd: 0.25 },
    ];

    test('sin SALDO registrado no hay saldo (null), aunque haya recargas', () => {
        expect(Consumo.calcularSaldo([{ tipo: 'RECARGA', monto_usd: 20, fecha: '2026-10-01' }], porDia))
            .toBeNull();
    });

    test('parte del SALDO más reciente, suma solo recargas posteriores y resta desde su día UTC', () => {
        const saldo = Consumo.calcularSaldo(
            [
                { tipo: 'SALDO', monto_usd: '50.00', fecha: '2026-09-01T12:00:00Z' }, // viejo: se ignora
                { tipo: 'SALDO', monto_usd: '10.00', fecha: '2026-10-01T15:00:00Z' },
                { tipo: 'RECARGA', monto_usd: '99.00', fecha: '2026-09-15T12:00:00Z' }, // anterior: no
                { tipo: 'RECARGA', monto_usd: '5.00', fecha: '2026-10-02T12:00:00Z' },
            ],
            porDia
        );
        expect(saldo).toMatchObject({
            saldo_partida: 10,
            recargas_posteriores: 5,
            gasto_desde_partida: 0.75, // 1-oct completo + 2-oct (conservador)
            saldo_estimado: 14.25,
        });
    });
});

describe('calcularSaldo — el día en que se registró el saldo', () => {
    // Caso real del 2026-10-04: saldo US$1.36 a las 23:30 de Bogotá (04:30 UTC del 5), cuando el
    // día UTC del 5 ya llevaba US$1.60 gastados que OpenAI tenía descontados del saldo.
    const porDia = [
        { fecha: '2026-10-05', usd: 1.7 },
        { fecha: '2026-10-06', usd: 0.2 },
    ];
    const saldo = { tipo: 'SALDO', monto_usd: '1.36', fecha: '2026-10-05T04:30:00Z' };

    test('con foto, solo resta lo gastado ese día después del registro', () => {
        const r = Consumo.calcularSaldo([{ ...saldo, gasto_dia_previo_usd: 1.6 }], porDia);
        expect(r.metodo_dia_partida).toBe('foto');
        expect(r.gasto_desde_partida).toBeCloseTo(0.3, 10); // 0.1 del día + 0.2 del siguiente
        expect(r.saldo_estimado).toBeCloseTo(1.06, 10);
    });

    test('sin foto, usa lo que anotó la cuenta interna tras la hora del registro', () => {
        const r = Consumo.calcularSaldo([saldo], porDia, { gastoInternoTrasPartida: 0.05 });
        expect(r.metodo_dia_partida).toBe('interno');
        expect(r.gasto_desde_partida).toBeCloseTo(0.25, 10);
    });

    test('sin foto ni cuenta interna, resta el día completo (conservador)', () => {
        const r = Consumo.calcularSaldo([saldo], porDia);
        expect(r.metodo_dia_partida).toBe('dia_completo');
        expect(r.gasto_desde_partida).toBeCloseTo(1.9, 10);
    });

    test('la foto nunca suma: si OpenAI reporta menos que la foto, ese día cuenta cero', () => {
        const r = Consumo.calcularSaldo([{ ...saldo, gasto_dia_previo_usd: 5 }], porDia);
        expect(r.gasto_desde_partida).toBeCloseTo(0.2, 10);
    });
});

describe('promedioDiario y diasRestantes', () => {
    test('no cuenta el día de hoy, que va a medias', () => {
        const ahora = new Date('2026-10-08T15:00:00Z');
        const porDia = [
            { fecha: '2026-10-01', usd: 0.7 },
            { fecha: '2026-10-07', usd: 0.7 },
            { fecha: '2026-10-08', usd: 100 }, // hoy: fuera
        ];
        expect(Consumo.promedioDiario(porDia, 7, ahora)).toBeCloseTo(0.2, 10);
    });

    test('sin gasto no inventa días restantes', () => {
        expect(Consumo.diasRestantes(10, 0)).toBeNull();
        expect(Consumo.diasRestantes(null, 1)).toBeNull();
        expect(Consumo.diasRestantes(10, 3)).toBe(3);
        expect(Consumo.diasRestantes(-2, 3)).toBe(0);
    });
});

describe('consultarCostosOficiales', () => {
    const fetchOriginal = global.fetch;
    const claveOriginal = process.env.OPENAI_ADMIN_KEY;

    beforeEach(() => {
        Consumo._vaciarCache();
        process.env.OPENAI_ADMIN_KEY = 'sk-admin-prueba';
    });
    afterAll(() => {
        global.fetch = fetchOriginal;
        if (claveOriginal === undefined) delete process.env.OPENAI_ADMIN_KEY;
        else process.env.OPENAI_ADMIN_KEY = claveOriginal;
    });

    test('sin clave falla con un error tipado, sin llamar a OpenAI', async () => {
        delete process.env.OPENAI_ADMIN_KEY;
        global.fetch = jest.fn();
        await expect(Consumo.consultarCostosOficiales(seg('2026-10-01')))
            .rejects.toMatchObject({ code: 'OPENAI_ADMIN_KEY_FALTA', statusCode: 503 });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('una clave rechazada se distingue de otros errores', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: { message: 'Incorrect API key' } }),
        });
        await expect(Consumo.consultarCostosOficiales(seg('2026-10-01')))
            .rejects.toMatchObject({ code: 'OPENAI_ADMIN_KEY_RECHAZADA' });
    });

    test('suma por día y por concepto, y un día sin gasto sale en cero', async () => {
        global.fetch = jest.fn().mockResolvedValue(respuestaOpenAI([
            cubeta('2026-10-01', [['m, input', 0.1], ['m, output', 0.2]]),
            cubeta('2026-10-02', []),
            cubeta('2026-10-03', [['m, output', 0.3]]),
        ]));
        const r = await Consumo.consultarCostosOficiales(seg('2026-10-01'));
        expect(r.por_dia).toEqual([
            { fecha: '2026-10-01', usd: expect.closeTo(0.3, 10) },
            { fecha: '2026-10-02', usd: 0 },
            { fecha: '2026-10-03', usd: 0.3 },
        ]);
        expect(r.por_concepto[0]).toEqual({ concepto: 'm, output', usd: 0.5 });
    });

    test('sigue la paginación de OpenAI', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce(respuestaOpenAI([cubeta('2026-10-01', [['a', 1]])], { has_more: true, next_page: 'p2' }))
            .mockResolvedValueOnce(respuestaOpenAI([cubeta('2026-10-02', [['a', 2]])]));
        const r = await Consumo.consultarCostosOficiales(seg('2026-10-01'));
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(global.fetch.mock.calls[1][0]).toContain('page=p2');
        expect(r.por_dia.map((d) => d.usd)).toEqual([1, 2]);
    });

    test('la caché sirve una ventana más corta sin volver a llamar, y recorta también los conceptos', async () => {
        global.fetch = jest.fn().mockResolvedValue(respuestaOpenAI([
            cubeta('2026-09-01', [['viejo', 40]]),
            cubeta('2026-10-01', [['nuevo', 1]]),
        ]));
        await Consumo.consultarCostosOficiales(seg('2026-09-01'));
        const corta = await Consumo.consultarCostosOficiales(seg('2026-10-01'));

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(corta.por_dia).toEqual([{ fecha: '2026-10-01', usd: 1 }]);
        expect(corta.por_concepto).toEqual([{ concepto: 'nuevo', usd: 1 }]);
    });

    test('forzar se salta la caché', async () => {
        global.fetch = jest.fn().mockResolvedValue(respuestaOpenAI([]));
        await Consumo.consultarCostosOficiales(seg('2026-10-01'));
        await Consumo.consultarCostosOficiales(seg('2026-10-01'), { forzar: true });
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });
});
