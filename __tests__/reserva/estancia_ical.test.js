/**
 * Lectura de calendarios iCal de Airbnb/Booking (`estancia/icalService.parsear`). Puro.
 */
'use strict';

const { parsear } = require('../../app_reserva_api/services/estancia/icalService');

const AIRBNB = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Airbnb Inc//Hosting Calendar 1.0//EN',
    'BEGIN:VEVENT',
    'DTEND;VALUE=DATE:20261012',
    'DTSTART;VALUE=DATE:20261009',
    'UID:1418fb94e984-abc@airbnb.com',
    'SUMMARY:Reserved',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20261020',
    'DTEND;VALUE=DATE:20261021',
    'UID:blocked-1@airbnb.com',
    'SUMMARY:Airbnb (Not available)',
    'END:VEVENT',
    'END:VCALENDAR',
].join('\r\n');

test('lee las reservas con salida exclusiva', () => {
    expect(parsear(AIRBNB)).toEqual([
        { uid: '1418fb94e984-abc@airbnb.com', desde: '2026-10-09', hasta: '2026-10-12', resumen: 'Reserved' },
        { uid: 'blocked-1@airbnb.com', desde: '2026-10-20', hasta: '2026-10-21', resumen: 'Airbnb (Not available)' },
    ]);
});

test('despliega líneas plegadas y acepta fechas con hora', () => {
    const ics = [
        'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
        'DTSTART:20261101T150000Z', 'DTEND:20261103T110000Z',
        'UID:largo-',
        ' partido@booking.com',
        'END:VEVENT', 'END:VCALENDAR',
    ].join('\n');
    expect(parsear(ics)).toEqual([{ uid: 'largo-partido@booking.com', desde: '2026-11-01', hasta: '2026-11-03', resumen: '' }]);
});

test('un evento sin fin ocupa una noche', () => {
    const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20261205\nUID:x\nEND:VEVENT\nEND:VCALENDAR';
    expect(parsear(ics)[0]).toMatchObject({ desde: '2026-12-05', hasta: '2026-12-06' });
});

test('ignora lo que no es un evento', () => {
    expect(parsear('BEGIN:VCALENDAR\nX-WR-CALNAME:Algo\nEND:VCALENDAR')).toEqual([]);
});
