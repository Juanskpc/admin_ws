/**
 * Motor de agenda con las particularidades de los perfiles: tiempo de proceso (salón) y
 * cabinas (spa, estética), más la composición de una cita (variantes, precios cotizados).
 *
 * Complementa a `motor_dorado.test.js`: aquel congela lo de siempre; este prueba lo nuevo.
 * Sin base de datos (ver `_apoyo/modelosFalsos.js`).
 */
'use strict';

const mockDatos = {};

jest.mock('../../app_core/models/conection', () =>
    require('../_apoyo/modelosFalsos').crearModelos(mockDatos));

const Reglas = require('../../app_reserva_api/services/reglasAgenda');
const Disponibilidad = require('../../app_reserva_api/services/disponibilidadService');
const { componer, normalizarVariantes, normalizarAjustes } = require('../../app_reserva_api/services/composicionCita');

const N = 1;
const ANA = 10;
const BETO = 11;
const LUNES = '2026-10-05';
const t = (hhmm) => new Date(`${LUNES}T${hhmm}:00-05:00`);

function fixture() {
    for (const k of Object.keys(mockDatos)) delete mockDatos[k];
    mockDatos.ReservaConfig = [{
        id_negocio: N, anticipacion_min_horas: 1, buffer_limpieza_min: 10, paso_slot_min: 15,
        ventana_cancelacion_horas: 4, funciones: {},
    }];
    mockDatos.ReservaServicio = [
        { id_servicio: 1, id_negocio: N, nombre: 'Corte', duracion_min: 30, precio: '30000', estado: 'A', proceso_desde_min: 0, proceso_min: 0 },
        { id_servicio: 2, id_negocio: N, nombre: 'Tinte', duracion_min: 120, precio: '120000', estado: 'A', proceso_desde_min: 30, proceso_min: 45 },
        { id_servicio: 3, id_negocio: N, nombre: 'Masaje', duracion_min: 60, precio: '120000', estado: 'A', id_tipo_recurso: 7 },
    ];
    mockDatos.ReservaProfesional = [
        { id_profesional: ANA, id_negocio: N, nombre: 'Ana', estado: 'A' },
        { id_profesional: BETO, id_negocio: N, nombre: 'Beto', estado: 'A' },
    ];
    mockDatos.ReservaHorario = [
        { id_negocio: N, id_profesional: null, dia_semana: 1, hora_inicio: '09:00:00', hora_fin: '18:00:00' },
    ];
    mockDatos.ReservaBloqueo = [];
    mockDatos.ReservaHold = [];
    mockDatos.ReservaRecurso = [{ id_recurso: 70, id_negocio: N, id_tipo_recurso: 7, nombre: 'Cabina 1', estado: 'A' }];
    mockDatos.ReservaCita = [];
    mockDatos.ReservaServicioVariante = [];
}

beforeEach(() => {
    fixture();
    jest.useFakeTimers({ now: new Date('2026-10-04T20:00:00-05:00'), doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => jest.useRealTimers());

const horas = (r) => r.slots.filter((s) => s.disponible).map((s) => s.hora);

describe('tiempo de proceso (salón)', () => {
    test('durante la espera del tinte la estilista puede atender otro corte', async () => {
        // Tinte de 10:00 a 12:00 con la estilista libre de 10:30 a 11:15.
        mockDatos.ReservaCita.push({
            id_cita: 1, id_negocio: N, id_profesional: ANA, estado: 'confirmada',
            fecha_hora_inicio: t('10:00'), fecha_hora_fin: t('12:00'), proceso_tramos: [[30, 75]],
        });
        const r = await Disponibilidad.calcularSlots({
            idNegocio: N, idServicios: [1], idProfesional: ANA, fechaISO: LUNES, funciones: ['tiempo_proceso'],
        });
        expect(horas(r)).toEqual(expect.arrayContaining(['10:30', '10:45']));
        expect(horas(r)).not.toContain('10:15');
        expect(horas(r)).not.toContain('11:00');
    });

    test('sin tramos guardados la misma cita bloquea las dos horas enteras', async () => {
        mockDatos.ReservaCita.push({
            id_cita: 1, id_negocio: N, id_profesional: ANA, estado: 'confirmada',
            fecha_hora_inicio: t('10:00'), fecha_hora_fin: t('12:00'), proceso_tramos: null,
        });
        const r = await Disponibilidad.calcularSlots({
            idNegocio: N, idServicios: [1], idProfesional: ANA, fechaISO: LUNES, funciones: ['tiempo_proceso'],
        });
        expect(horas(r)).not.toContain('10:30');
    });

    test('un tinte nuevo puede empezar aunque haya un corte dentro de su espera', async () => {
        mockDatos.ReservaCita.push({
            id_cita: 2, id_negocio: N, id_profesional: BETO, estado: 'pendiente',
            fecha_hora_inicio: t('10:40'), fecha_hora_fin: t('11:00'),
        });
        await expect(Reglas.verificarReservable({
            idNegocio: N, idProfesional: BETO, inicio: t('10:00'), fin: t('12:00'), bufferMin: 10, tramos: [[30, 75]],
        })).resolves.toBeUndefined();

        await expect(Reglas.verificarReservable({
            idNegocio: N, idProfesional: BETO, inicio: t('10:00'), fin: t('12:00'), bufferMin: 10,
        })).rejects.toMatchObject({ code: 'SLOT_NO_DISPONIBLE' });
    });

    test('lo que se ofrece siempre se puede confirmar', async () => {
        mockDatos.ReservaCita.push({
            id_cita: 2, id_negocio: N, id_profesional: BETO, estado: 'pendiente',
            fecha_hora_inicio: t('10:40'), fecha_hora_fin: t('11:00'),
        });
        const r = await Disponibilidad.calcularSlots({
            idNegocio: N, idServicios: [2], idProfesional: BETO, fechaISO: LUNES, funciones: ['tiempo_proceso'],
        });
        expect(horas(r)).toContain('10:00');
        for (const h of horas(r)) {
            const inicio = t(h);
            await expect(Reglas.verificarReservable({
                idNegocio: N, idProfesional: BETO, inicio, fin: Reglas.addMinutes(inicio, 120),
                bufferMin: 10, tramos: [[30, 75]],
            })).resolves.toBeUndefined();
        }
    });

    test('con la función apagada el tinte ocupa todo, como en la barbería', async () => {
        mockDatos.ReservaCita.push({
            id_cita: 2, id_negocio: N, id_profesional: BETO, estado: 'pendiente',
            fecha_hora_inicio: t('10:40'), fecha_hora_fin: t('11:00'),
        });
        const r = await Disponibilidad.calcularSlots({
            idNegocio: N, idServicios: [2], idProfesional: BETO, fechaISO: LUNES, funciones: [],
        });
        expect(horas(r)).not.toContain('10:00');
    });
});

describe('cabinas (spa)', () => {
    test('con una sola cabina, dos terapeutas no se solapan', async () => {
        mockDatos.ReservaCita.push({
            id_cita: 3, id_negocio: N, id_profesional: ANA, id_recurso: 70, estado: 'confirmada',
            fecha_hora_inicio: t('10:00'), fecha_hora_fin: t('11:00'),
        });
        const conCabina = await Disponibilidad.calcularSlots({
            idNegocio: N, idServicios: [3], idProfesional: BETO, fechaISO: LUNES, funciones: ['recursos'],
        });
        expect(horas(conCabina)).not.toContain('10:00');
        expect(horas(conCabina)).not.toContain('09:00');
        expect(horas(conCabina)).toContain('11:15');

        const sinFuncion = await Disponibilidad.calcularSlots({
            idNegocio: N, idServicios: [3], idProfesional: BETO, fechaISO: LUNES, funciones: [],
        });
        expect(horas(sinFuncion)).toContain('10:00');
    });

    test('con dos cabinas se asigna la que está libre', async () => {
        mockDatos.ReservaRecurso.push({ id_recurso: 71, id_negocio: N, id_tipo_recurso: 7, nombre: 'Cabina 2', estado: 'A' });
        mockDatos.ReservaCita.push({
            id_cita: 3, id_negocio: N, id_profesional: ANA, id_recurso: 70, estado: 'confirmada',
            fecha_hora_inicio: t('10:00'), fecha_hora_fin: t('11:00'),
        });
        const id = await Reglas.asignarRecurso({
            idNegocio: N, idTipoRecurso: 7, inicio: t('10:00'), fin: t('11:00'), bufferMin: 10,
        });
        expect(id).toBe(71);
    });

    test('sin cabinas configuradas no se ofrece nada y crear falla con un error claro', async () => {
        mockDatos.ReservaRecurso = [];
        const r = await Disponibilidad.calcularSlots({
            idNegocio: N, idServicios: [3], idProfesional: BETO, fechaISO: LUNES, funciones: ['recursos'],
        });
        expect(r.slots).toEqual([]);
        await expect(Reglas.asignarRecurso({
            idNegocio: N, idTipoRecurso: 7, inicio: t('10:00'), fin: t('11:00'), bufferMin: 10,
        })).rejects.toMatchObject({ code: 'RECURSO_NO_CONFIGURADO' });
    });
});

describe('composición de la cita', () => {
    const corte = { id_servicio: 1, nombre: 'Corte', duracion_min: 30, precio: '30000' };
    const tinte = { id_servicio: 2, nombre: 'Tinte', duracion_min: 120, precio: '120000', proceso_desde_min: 30, proceso_min: 45 };
    const sesion = { id_servicio: 4, nombre: 'Sesión', duracion_min: 180, precio: '450000', a_cotizar: true };

    test('sin funciones es la suma de siempre', () => {
        const c = componer([corte, tinte]);
        expect(c).toMatchObject({ duracion: 150, monto: 150000, tramos: null, idTipoRecurso: null });
    });

    test('el tramo de espera se desplaza según el orden de los servicios', () => {
        expect(componer([corte, tinte], { funciones: ['tiempo_proceso'] }).tramos).toEqual([[60, 105]]);
        expect(componer([tinte, corte], { funciones: ['tiempo_proceso'] }).tramos).toEqual([[30, 75]]);
    });

    test('la variante cambia precio y duración y deja su nombre congelado', () => {
        const largo = { id_variante: 9, id_servicio: 2, nombre: 'Largo', duracion_min: 150, precio: '150000' };
        const c = componer([tinte], { funciones: ['variantes'], variantes: new Map([[2, largo]]) });
        expect(c).toMatchObject({ duracion: 150, monto: 150000 });
        expect(c.lineas[0]).toMatchObject({ id_variante: 9, variante_snapshot: 'Largo', precio_snapshot: 150000 });
    });

    test('con la función de variantes apagada se cobra el precio de lista', () => {
        const largo = { id_variante: 9, id_servicio: 2, nombre: 'Largo', duracion_min: 150, precio: '150000' };
        expect(componer([tinte], { variantes: new Map([[2, largo]]) }).monto).toBe(120000);
    });

    test('solo un servicio «a cotizar» acepta precio acordado', () => {
        const ajustes = normalizarAjustes([{ id_servicio: 4, precio: 380000, duracion_min: 240 }]);
        expect(componer([sesion], { funciones: ['a_cotizar'], ajustes })).toMatchObject({ duracion: 240, monto: 380000 });
        expect(() => componer([corte], { funciones: ['a_cotizar'], ajustes: normalizarAjustes([{ id_servicio: 1, precio: 1 }]) }))
            .toThrow(expect.objectContaining({ code: 'SERVICIO_NO_COTIZABLE' }));
    });

    test('dos servicios con cabinas distintas no van en la misma cita', () => {
        const a = { ...corte, id_tipo_recurso: 1 };
        const b = { ...tinte, id_tipo_recurso: 2 };
        expect(() => componer([a, b], { funciones: ['recursos'] }))
            .toThrow(expect.objectContaining({ code: 'RECURSOS_INCOMPATIBLES' }));
    });

    test('normaliza variantes desde objeto, lista o texto', () => {
        expect([...normalizarVariantes({ 2: 9 })]).toEqual([[2, 9]]);
        expect([...normalizarVariantes([{ id_servicio: 2, id_variante: 9 }])]).toEqual([[2, 9]]);
        expect([...normalizarVariantes('{"2":9}')]).toEqual([[2, 9]]);
        expect(normalizarVariantes(null).size).toBe(0);
    });
});
