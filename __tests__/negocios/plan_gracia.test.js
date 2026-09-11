/**
 * Periodo de gracia del plan: vencer no es quedarse fuera el mismo día.
 *
 * Cuando un plan llega a su `fecha_fin` el negocio conserva 5 días para ponerse al día. En esa
 * ventana `activo` sigue valiendo `true` —los guardias de las apps solo miran eso, así que el
 * cliente sigue trabajando— y `en_gracia` enciende el aviso de «te quedan N días para pagar».
 * Pasada la ventana, el acceso se corta como antes.
 *
 * Lo que estas pruebas sostienen:
 *   1. Los tres estados y sus fronteras exactas: el último día de gracia todavía deja entrar,
 *      el siguiente ya no.
 *   2. La cuenta atrás nunca muestra 0 mientras se pueda seguir usando el sistema: un aviso que
 *      dice «te quedan 0 días» y permite trabajar no lo entiende nadie.
 *   3. Un plan aún no iniciado no habilita nada, aunque su fila esté activa.
 *
 * Es una prueba de función pura: no toca la base de datos.
 */
'use strict';

require('dotenv').config();

const { evaluarPlan, DIAS_GRACIA_PLAN } = require('../../app_core/helpers/planHelper');

const MS_DIA = 86400000;
const AHORA = new Date('2026-09-11T10:00:00');

/** Una fila de plan ya iniciada que vence dentro de `dias` (negativo = ya venció). */
const planQueVence = (dias) => ({
    fecha_inicio: new Date(AHORA.getTime() - 30 * MS_DIA),
    fecha_fin: new Date(AHORA.getTime() + dias * MS_DIA),
});

describe('periodo de gracia del plan', () => {
    test('la gracia son 5 días: cambiarlo es una decisión comercial, no un detalle', () => {
        expect(DIAS_GRACIA_PLAN).toBe(5);
    });

    test('un plan dentro de fechas está ACTIVO y sin aviso', () => {
        const estado = evaluarPlan(planQueVence(3), AHORA);
        expect(estado).toMatchObject({ estado: 'ACTIVO', activo: true, en_gracia: false });
    });

    test('un plan sin fecha de fin no vence nunca', () => {
        const estado = evaluarPlan({ fecha_inicio: new Date('2026-01-01'), fecha_fin: null }, AHORA);
        expect(estado).toMatchObject({ estado: 'ACTIVO', activo: true });
    });

    test('recién vencido: sigue operando, con los 5 días completos', () => {
        const estado = evaluarPlan(planQueVence(-0.01), AHORA);
        expect(estado).toMatchObject({
            estado: 'GRACIA',
            activo: true,
            en_gracia: true,
            dias_gracia_restantes: 5,
        });
    });

    test('la cuenta atrás baja un día por día', () => {
        expect(evaluarPlan(planQueVence(-1), AHORA).dias_gracia_restantes).toBe(4);
        expect(evaluarPlan(planQueVence(-3), AHORA).dias_gracia_restantes).toBe(2);
    });

    test('el último tramo de gracia muestra 1 día, nunca 0', () => {
        // A pocas horas de agotarse: mientras se pueda trabajar, el aviso dice al menos 1.
        const estado = evaluarPlan(planQueVence(-4.9), AHORA);
        expect(estado.activo).toBe(true);
        expect(estado.dias_gracia_restantes).toBe(1);
    });

    test('pasada la gracia, el acceso se corta', () => {
        const estado = evaluarPlan(planQueVence(-5.1), AHORA);
        expect(estado).toMatchObject({
            estado: 'VENCIDO',
            activo: false,
            en_gracia: false,
            dias_gracia_restantes: 0,
        });
    });

    test('un plan que todavía no empieza no habilita nada', () => {
        const estado = evaluarPlan({
            fecha_inicio: new Date(AHORA.getTime() + MS_DIA),
            fecha_fin: new Date(AHORA.getTime() + 31 * MS_DIA),
        }, AHORA);
        expect(estado).toMatchObject({ estado: 'SIN_PLAN', activo: false });
    });

    test('sin fila de plan, no hay acceso', () => {
        expect(evaluarPlan(null, AHORA)).toMatchObject({ estado: 'SIN_PLAN', activo: false });
    });
});
