/**
 * Noches y tarifas de una estancia (`app_reserva_api/services/estancia/tarifas.js`). Puro.
 */
'use strict';

const T = require('../../app_reserva_api/services/estancia/tarifas');

const DOBLE = {
    nombre: 'Habitación doble', ocupacion_base: 2, capacidad_max: 3,
    tarifa_base: '180000', tarifa_fin_semana: '220000', tarifa_persona_extra: '40000', min_noches: 1,
};

describe('noches', () => {
    test('la salida no es una noche', () => {
        expect(T.noches('2026-10-05', '2026-10-07')).toEqual(['2026-10-05', '2026-10-06']);
    });
    test('cruza meses y años sin perder días', () => {
        expect(T.noches('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
    });
    test('salida igual o anterior a la entrada falla', () => {
        expect(() => T.noches('2026-10-05', '2026-10-05')).toThrow(expect.objectContaining({ code: 'FECHAS_INVALIDAS' }));
    });
    test('fechas imposibles fallan', () => {
        expect(() => T.noches('2026-02-30', '2026-03-02')).toThrow(expect.objectContaining({ code: 'FECHA_INVALIDA' }));
    });
    test('se pisan solo si comparten una noche', () => {
        expect(T.sePisan('2026-10-05', '2026-10-07', '2026-10-07', '2026-10-09')).toBe(false); // salida = entrada
        expect(T.sePisan('2026-10-05', '2026-10-08', '2026-10-07', '2026-10-09')).toBe(true);
    });
});

describe('cotizar', () => {
    test('entre semana cobra la base; viernes y sábado la de fin de semana', () => {
        // Jueves 8, viernes 9, sábado 10 de octubre de 2026 → salida domingo 11.
        const c = T.cotizar(DOBLE, [], { entrada: '2026-10-08', salida: '2026-10-11', huespedes: 2 });
        expect(c.noches.map((n) => n.precio)).toEqual([180000, 220000, 220000]);
        expect(c.total).toBe(620000);
    });

    test('la temporada manda sobre el fin de semana y sube el mínimo', () => {
        const temporadas = [{ id_tarifa: 1, nombre: 'Puente', desde: '2026-10-09', hasta: '2026-10-11', precio_noche: '300000', min_noches: 2 }];
        const c = T.cotizar(DOBLE, temporadas, { entrada: '2026-10-08', salida: '2026-10-10', huespedes: 2 });
        expect(c.noches).toEqual([
            { fecha: '2026-10-08', precio: 180000, temporada: null },
            { fecha: '2026-10-09', precio: 300000, temporada: 'Puente' },
        ]);
        expect(c.min_noches).toBe(2);
    });

    test('recargo por huésped adicional sobre la ocupación base', () => {
        const c = T.cotizar(DOBLE, [], { entrada: '2026-10-05', salida: '2026-10-06', huespedes: 3 });
        expect(c.total).toBe(220000);
        expect(c.huespedes_extra).toBe(1);
    });

    test('más huéspedes que la capacidad falla', () => {
        expect(() => T.cotizar(DOBLE, [], { entrada: '2026-10-05', salida: '2026-10-06', huespedes: 4 }))
            .toThrow(expect.objectContaining({ code: 'CAPACIDAD_EXCEDIDA' }));
    });

    test('el mínimo de noches se exige aparte', () => {
        const c = T.cotizar({ ...DOBLE, min_noches: 2 }, [], { entrada: '2026-10-05', salida: '2026-10-06' });
        expect(() => T.exigirMinimo(c)).toThrow(expect.objectContaining({ code: 'MINIMO_DE_NOCHES' }));
    });

    test('dos temporadas que se pisan: gana la que empieza después', () => {
        const temporadas = [
            { id_tarifa: 1, nombre: 'Alta', desde: '2026-12-01', hasta: '2027-01-15', precio_noche: '250000' },
            { id_tarifa: 2, nombre: 'Fin de año', desde: '2026-12-30', hasta: '2027-01-01', precio_noche: '400000' },
        ];
        const c = T.cotizar(DOBLE, temporadas, { entrada: '2026-12-29', salida: '2026-12-31' });
        expect(c.noches.map((n) => n.temporada)).toEqual(['Alta', 'Fin de año']);
    });
});
