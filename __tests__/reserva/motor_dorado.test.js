/**
 * Prueba dorada del motor de agenda: **la barbería no puede cambiar**.
 *
 * Los perfiles de rubro (`docs/perfiles-de-reserva.md`) añaden al motor tiempo de proceso,
 * variantes y recursos. Todo eso se activa con datos que en una barbería valen cero o nulo, y
 * la promesa es que con esos valores el motor calcula **exactamente** lo mismo que antes.
 *
 * Esta suite convierte la promesa en algo que falla: congela la salida de las funciones que
 * deciden la agenda sobre una barbería de fixture —horario general y por profesional, pausa
 * del almuerzo, bloqueos, citas en todos los estados, holds vivos y vencidos, combos de
 * servicios, tres configuraciones de buffer y paso— y exige que sea idéntica en cada corrida.
 *
 * El snapshot se generó **antes** de tocar `reglasAgenda.js`. Si esta prueba falla después de
 * un cambio en el motor, el cambio alteró la agenda de negocios que ya facturan: no se
 * actualiza el snapshot para que pase, se arregla el cambio.
 *
 * No usa base de datos (ver `_apoyo/modelosFalsos.js`), así que se puede correr siempre.
 *
 *   npx jest __tests__/reserva/motor_dorado.test.js
 */
'use strict';

const mockDatos = {};

jest.mock('../../app_core/models/conection', () =>
    require('../_apoyo/modelosFalsos').crearModelos(mockDatos));

const Reglas = require('../../app_reserva_api/services/reglasAgenda');
const Disponibilidad = require('../../app_reserva_api/services/disponibilidadService');
const AgendaServicio = require('../../app_reserva_api/services/agendaServicioService');

const NEGOCIO = 1;
const ANA = 10;   // todos los servicios activos (asignados uno a uno), horario propio el martes
const BETO = 11;  // solo corte y barba
const CARO = 12;  // inactiva

const SEMANA = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
const LUNES = SEMANA[0];

/** Instante en hora de Bogotá. */
const t = (fecha, hhmm) => new Date(`${fecha}T${hhmm}:00-05:00`);

const CONFIGS = {
    base: { buffer_limpieza_min: 10, paso_slot_min: 15 },
    sinBuffer: { buffer_limpieza_min: 0, paso_slot_min: 30 },
    bufferLargo: { buffer_limpieza_min: 30, paso_slot_min: 5 },
};

function cargarFixture(config = CONFIGS.base) {
    for (const k of Object.keys(mockDatos)) delete mockDatos[k];

    mockDatos.ReservaConfig = [{
        id_negocio: NEGOCIO,
        anticipacion_min_minutos: 60,
        ventana_cancelacion_min: 240,
        cobro_adelantado: false,
        permite_cobro_profesional: false,
        permite_multipago: false,
        ...config,
    }];

    mockDatos.ReservaServicio = [
        { id_servicio: 1, id_negocio: NEGOCIO, nombre: 'Corte', duracion_min: 30, precio: '28000', estado: 'A' },
        { id_servicio: 2, id_negocio: NEGOCIO, nombre: 'Barba', duracion_min: 20, precio: '18000', estado: 'A' },
        { id_servicio: 3, id_negocio: NEGOCIO, nombre: 'Corte + barba', duracion_min: 50, precio: '42000', estado: 'A' },
        { id_servicio: 4, id_negocio: NEGOCIO, nombre: 'Tinte', duracion_min: 45, precio: '60000', estado: 'I' },
    ];

    mockDatos.ReservaProfesional = [
        { id_profesional: ANA, id_negocio: NEGOCIO, nombre: 'Ana', especialidad: null, foto_url: null, color_hex: '#111111', estado: 'A' },
        { id_profesional: BETO, id_negocio: NEGOCIO, nombre: 'Beto', especialidad: 'Barbas', foto_url: null, color_hex: '#222222', estado: 'A' },
        { id_profesional: CARO, id_negocio: NEGOCIO, nombre: 'Caro', especialidad: null, foto_url: null, color_hex: '#333333', estado: 'I' },
    ];

    // Sin asignaciones un profesional no ofrece nada: a Ana se le dan todos los activos.
    mockDatos.ReservaProfesionalServicio = [
        { id_profesional: ANA, id_servicio: 1 },
        { id_profesional: ANA, id_servicio: 2 },
        { id_profesional: ANA, id_servicio: 3 },
        { id_profesional: BETO, id_servicio: 1 },
        { id_profesional: BETO, id_servicio: 2 },
    ];

    // Horario general lunes a sábado con almuerzo; Ana tiene horario propio el martes.
    let idH = 1;
    mockDatos.ReservaHorario = [];
    for (let dia = 1; dia <= 6; dia++) {
        mockDatos.ReservaHorario.push(
            { id_horario: idH++, id_negocio: NEGOCIO, id_profesional: null, dia_semana: dia, hora_inicio: '09:00:00', hora_fin: '13:00:00' },
            { id_horario: idH++, id_negocio: NEGOCIO, id_profesional: null, dia_semana: dia, hora_inicio: '14:00:00', hora_fin: '19:00:00' },
        );
    }
    mockDatos.ReservaHorario.push(
        { id_horario: idH++, id_negocio: NEGOCIO, id_profesional: ANA, dia_semana: 2, hora_inicio: '10:00:00', hora_fin: '16:00:00' },
    );

    mockDatos.ReservaBloqueo = [
        // Bloqueo del negocio entero el miércoles al mediodía.
        { id_bloqueo: 1, id_negocio: NEGOCIO, id_profesional: null, fecha_inicio: t(SEMANA[2], '12:00'), fecha_fin: t(SEMANA[2], '15:00') },
        // Ana de vacaciones el jueves entero.
        { id_bloqueo: 2, id_negocio: NEGOCIO, id_profesional: ANA, fecha_inicio: t(SEMANA[3], '00:00'), fecha_fin: t(SEMANA[4], '00:00') },
        // Beto llega tarde el viernes.
        { id_bloqueo: 3, id_negocio: NEGOCIO, id_profesional: BETO, fecha_inicio: t(SEMANA[4], '09:00'), fecha_fin: t(SEMANA[4], '10:30') },
    ];

    mockDatos.ReservaCita = [
        { id_cita: 100, id_negocio: NEGOCIO, id_profesional: ANA, estado: 'pendiente', fecha_hora_inicio: t(LUNES, '10:00'), fecha_hora_fin: t(LUNES, '10:30') },
        { id_cita: 101, id_negocio: NEGOCIO, id_profesional: ANA, estado: 'confirmada', fecha_hora_inicio: t(LUNES, '11:00'), fecha_hora_fin: t(LUNES, '11:50') },
        { id_cita: 102, id_negocio: NEGOCIO, id_profesional: ANA, estado: 'cancelada', fecha_hora_inicio: t(LUNES, '15:00'), fecha_hora_fin: t(LUNES, '15:30') },
        { id_cita: 103, id_negocio: NEGOCIO, id_profesional: BETO, estado: 'completada', fecha_hora_inicio: t(LUNES, '09:00'), fecha_hora_fin: t(LUNES, '09:30') },
        { id_cita: 104, id_negocio: NEGOCIO, id_profesional: BETO, estado: 'pendiente', fecha_hora_inicio: t(LUNES, '16:07'), fecha_hora_fin: t(LUNES, '16:37') },
        { id_cita: 105, id_negocio: NEGOCIO, id_profesional: BETO, estado: 'no_show', fecha_hora_inicio: t(LUNES, '17:00'), fecha_hora_fin: t(LUNES, '17:30') },
        // Cita que cruza la pausa del sábado (creada a mano antes de F3): debe seguir ocupando.
        { id_cita: 106, id_negocio: NEGOCIO, id_profesional: ANA, estado: 'confirmada', fecha_hora_inicio: t(SEMANA[5], '12:40'), fecha_hora_fin: t(SEMANA[5], '14:20') },
    ];

    mockDatos.ReservaHold = [
        { id_hold: 1, id_negocio: NEGOCIO, id_profesional: ANA, estado: 'activo', expira_en: t(SEMANA[6], '23:00'), fecha_hora_inicio: t(LUNES, '17:00'), fecha_hora_fin: t(LUNES, '17:30') },
        { id_hold: 2, id_negocio: NEGOCIO, id_profesional: ANA, estado: 'activo', expira_en: t('2026-10-04', '10:00'), fecha_hora_inicio: t(LUNES, '18:00'), fecha_hora_fin: t(LUNES, '18:30') },
        { id_hold: 3, id_negocio: NEGOCIO, id_profesional: BETO, estado: 'confirmado', expira_en: t(SEMANA[6], '23:00'), fecha_hora_inicio: t(LUNES, '12:00'), fecha_hora_fin: t(LUNES, '12:20') },
    ];
}

/** Resultado serializable, sea éxito o error tipado. */
async function capturar(fn) {
    try {
        return { ok: await fn() };
    } catch (err) {
        return { error: err.code || err.message, status: err.statusCode ?? null };
    }
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d);
const intervalos = (lista) => lista.map(([a, b]) => [iso(a), iso(b)]);

beforeEach(() => {
    jest.useFakeTimers({ now: t('2026-10-04', '20:00'), doNotFake: ['nextTick', 'setImmediate'] });
});

afterEach(() => {
    jest.useRealTimers();
});

describe('motor de agenda — salida congelada de la barbería', () => {
    for (const [nombreCfg, cfg] of Object.entries(CONFIGS)) {
        test(`calcularSlots · ${nombreCfg}`, async () => {
            cargarFixture(cfg);
            const salida = {};
            for (const fecha of SEMANA) {
                for (const prof of [ANA, BETO, CARO]) {
                    for (const servicios of [[1], [3], [1, 2], [4]]) {
                        const clave = `${fecha}|${prof}|${servicios.join('+')}`;
                        salida[clave] = await capturar(() => Disponibilidad.calcularSlots({
                            idNegocio: NEGOCIO, idServicios: servicios, idProfesional: prof, fechaISO: fecha,
                        }));
                    }
                }
            }
            expect(salida).toMatchSnapshot();
        });

        test(`huecos e intervalos ocupados · ${nombreCfg}`, async () => {
            cargarFixture(cfg);
            const salida = {};
            for (const fecha of SEMANA) {
                for (const prof of [ANA, BETO]) {
                    const clave = `${fecha}|${prof}`;
                    salida[clave] = {
                        laborales: intervalos(await Reglas.intervalosLaborales({ idNegocio: NEGOCIO, idProfesional: prof, fechaISO: fecha })),
                        ocupados: intervalos(await Reglas.intervalosOcupados({ idNegocio: NEGOCIO, idProfesional: prof, fechaISO: fecha, bufferMin: cfg.buffer_limpieza_min })),
                        huecos: intervalos(await Reglas.huecosReservables({ idNegocio: NEGOCIO, idProfesional: prof, fechaISO: fecha, bufferMin: cfg.buffer_limpieza_min })),
                    };
                }
            }
            expect(salida).toMatchSnapshot();
        });
    }

    test('verificarReservable acepta y rechaza lo mismo', async () => {
        cargarFixture();
        const casos = [
            [ANA, LUNES, '09:00', '09:30'],
            [ANA, LUNES, '09:30', '10:00'],   // pegada a la cita de las 10 con buffer 10
            [ANA, LUNES, '10:40', '11:00'],   // toca el buffer de las dos citas
            [ANA, LUNES, '12:00', '12:30'],
            [ANA, LUNES, '12:30', '13:10'],   // cruza el almuerzo
            [ANA, LUNES, '15:00', '15:30'],   // la cancelada libera
            [ANA, LUNES, '17:00', '17:30'],   // hold vivo
            [ANA, LUNES, '18:00', '18:30'],   // hold vencido libera
            [ANA, SEMANA[3], '10:00', '10:30'], // vacaciones
            [ANA, SEMANA[6], '10:00', '10:30'], // domingo cerrado
            [ANA, SEMANA[2], '12:30', '13:00'], // bloqueo del negocio
            [ANA, SEMANA[1], '09:00', '09:30'], // antes de su horario propio del martes
            [ANA, SEMANA[1], '13:00', '13:30'], // martes sin almuerzo para Ana
            [BETO, LUNES, '09:00', '09:30'],  // la completada no ocupa
            [BETO, LUNES, '16:30', '17:00'],  // choca con la de 16:07
            [BETO, LUNES, '17:00', '17:30'],  // el no_show libera
            [BETO, LUNES, '12:00', '12:20'],  // hold confirmado no cuenta
            [BETO, SEMANA[4], '10:00', '10:30'],
            [BETO, SEMANA[4], '10:30', '11:00'],
        ];
        const salida = {};
        for (const [prof, fecha, ini, fin] of casos) {
            salida[`${prof}|${fecha}|${ini}-${fin}`] = await capturar(async () => {
                await Reglas.verificarReservable({
                    idNegocio: NEGOCIO, idProfesional: prof,
                    inicio: t(fecha, ini), fin: t(fecha, fin), bufferMin: 10,
                });
                return 'OK';
            });
        }
        expect(salida).toMatchSnapshot();
    });

    test('verificarReservable con exclusiones de cita y de hold', async () => {
        cargarFixture();
        const salida = {
            moverSobreSiMisma: await capturar(async () => {
                await Reglas.verificarReservable(
                    { idNegocio: NEGOCIO, idProfesional: ANA, inicio: t(LUNES, '10:15'), fin: t(LUNES, '10:45'), bufferMin: 10 },
                    { excluirCita: 100 });
                return 'OK';
            }),
            consumirSuHold: await capturar(async () => {
                await Reglas.verificarReservable(
                    { idNegocio: NEGOCIO, idProfesional: ANA, inicio: t(LUNES, '17:00'), fin: t(LUNES, '17:30'), bufferMin: 10 },
                    { excluirHold: 1 });
                return 'OK';
            }),
        };
        expect(salida).toMatchSnapshot();
    });

    test('anticipación mínima con el reloj a media mañana', async () => {
        cargarFixture();
        jest.setSystemTime(t(LUNES, '10:20'));
        const salida = await capturar(() => Disponibilidad.calcularSlots({
            idNegocio: NEGOCIO, idServicios: [1], idProfesional: BETO, fechaISO: LUNES,
        }));
        expect(salida).toMatchSnapshot();
    });

    test('diasDisponibles por profesional y del negocio', async () => {
        cargarFixture();
        const salida = {};
        for (const prof of [ANA, BETO, null]) {
            salida[String(prof)] = await capturar(() => Disponibilidad.diasDisponibles({
                idNegocio: NEGOCIO, idProfesional: prof, desde: SEMANA[0], hasta: SEMANA[6],
            }));
        }
        expect(salida).toMatchSnapshot();
    });

    test('portal: días y horas de un servicio entre todos los profesionales', async () => {
        cargarFixture();
        const salida = {
            diasCorte: await capturar(() => AgendaServicio.diasDelServicio({
                idNegocio: NEGOCIO, idServicio: 1, desde: SEMANA[0], hasta: SEMANA[6],
            })),
            diasCombo: await capturar(() => AgendaServicio.diasDelServicio({
                idNegocio: NEGOCIO, idServicio: 3, desde: SEMANA[0], hasta: SEMANA[6],
            })),
        };
        for (const fecha of SEMANA) {
            salida[`slots|${fecha}|corte`] = await capturar(() => AgendaServicio.slotsDelServicio({
                idNegocio: NEGOCIO, idServicio: 1, fechaISO: fecha,
            }));
        }
        expect(salida).toMatchSnapshot();
    });
});
