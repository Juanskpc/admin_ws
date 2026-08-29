'use strict';
const Models = require('../../app_core/models/conection');
const Reglas = require('./reglasAgenda');

/**
 * Informes del negocio para un rango de fechas.
 *
 * ## Criterios, dichos una vez
 *
 * Un informe solo sirve si el lector sabe qué está contando. Aquí hay dos criterios distintos
 * y se usan a propósito, en vez de mezclarlos en un único «total» ambiguo:
 *
 * - **Ingresos** = citas `confirmada` + `completada`. Es dinero comprometido: la cita está en
 *   pie. Es el mismo criterio que ya usaba el dashboard, así que las dos pantallas no se
 *   contradicen.
 * - **Realizados** = solo `completada`. Es trabajo hecho de verdad.
 *
 * Las canceladas y los no-show nunca suman dinero, pero **sí** se cuentan aparte: son la señal
 * más útil que tiene un salón para detectar un problema, y esconderlas daría un informe bonito
 * e inútil.
 *
 * ## Zona horaria
 *
 * `reserva` guarda `timestamp without time zone` como hora de pared de Bogotá, y la sesión SQL
 * fija esa zona (`conection.js`). Por eso `fecha_hora_inicio::date` ya da el día correcto sin
 * conversiones, y los límites del rango se anclan con `Reglas.inicioDelDia`, la misma
 * aritmética que usa el resto del módulo.
 *
 * ## Por qué una sola llamada
 *
 * Son ocho agregados sobre las mismas dos tablas. Pedirlos por separado obligaría a la vista a
 * encadenar peticiones y a mostrar la pantalla a trozos; van juntos y en paralelo.
 */

const ESTADOS_QUE_FACTURAN = ['confirmada', 'completada'];
const MAX_DIAS = 366;

async function getInforme({ idNegocio, desde, hasta, idProfesional = null }) {
    if (!idNegocio || !desde || !hasta) {
        const e = new Error('Parámetros incompletos'); e.statusCode = 400; throw e;
    }

    const ini = Reglas.inicioDelDia(desde);
    const finExclusivo = Reglas.addMinutes(Reglas.inicioDelDia(hasta), 24 * 60);
    if (Number.isNaN(ini.getTime()) || Number.isNaN(finExclusivo.getTime()) || finExclusivo <= ini) {
        const e = new Error('Rango de fechas inválido'); e.statusCode = 400; throw e;
    }
    const dias = Math.round((finExclusivo - ini) / 86_400_000);
    if (dias > MAX_DIAS) {
        const e = new Error('El rango no puede superar 366 días'); e.statusCode = 400; throw e;
    }

    // `:idProfesional` se compara con IS NULL para que el mismo SQL sirva filtrado y sin
    // filtrar: así no hay dos variantes de cada consulta que puedan divergir.
    const repl = { idNegocio, ini, fin: finExclusivo, idProfesional };

    const [
        totales, serieDia, porProfesional, porServicio, porEstado, porHora, topClientes,
    ] = await Promise.all([
        totalesDelRango(repl),
        seriePorDia(repl),
        agregadoPorProfesional(repl),
        agregadoPorServicio(repl),
        conteoPorEstado(repl),
        conteoPorHora(repl),
        mejoresClientes(repl),
    ]);

    return {
        rango: { desde, hasta, dias },
        totales,
        serie_dia: serieDia,
        por_profesional: porProfesional,
        por_servicio: porServicio,
        por_estado: porEstado,
        por_hora: porHora,
        top_clientes: topClientes,
    };
}

// ─────────────────────────────── Consultas ───────────────────────────────

const FILTRO_BASE = `
    c.id_negocio = :idNegocio
    AND c.fecha_hora_inicio >= :ini
    AND c.fecha_hora_inicio <  :fin
    AND (:idProfesional::int IS NULL OR c.id_profesional = :idProfesional)
`;

async function totalesDelRango(repl) {
    const [row] = await Models.sequelize.query(
        `SELECT
            COUNT(*)                                                   AS citas_totales,
            COUNT(*) FILTER (WHERE c.estado <> 'cancelada')            AS citas_activas,
            COUNT(*) FILTER (WHERE c.estado = 'completada')            AS completadas,
            COUNT(*) FILTER (WHERE c.estado = 'confirmada')            AS confirmadas,
            COUNT(*) FILTER (WHERE c.estado = 'pendiente')             AS pendientes,
            COUNT(*) FILTER (WHERE c.estado = 'cancelada')             AS canceladas,
            COUNT(*) FILTER (WHERE c.estado = 'no_show')               AS no_show,
            COUNT(*) FILTER (WHERE c.pago_estado = 'pendiente_validacion') AS pagos_por_validar,
            COALESCE(SUM(c.monto_total) FILTER (WHERE c.estado IN ('confirmada','completada')), 0) AS ingresos,
            COALESCE(SUM(c.monto_total) FILTER (WHERE c.estado = 'completada'), 0)                 AS ingresos_completados,
            COALESCE(SUM(EXTRACT(EPOCH FROM (c.fecha_hora_fin - c.fecha_hora_inicio)) / 60)
                     FILTER (WHERE c.estado = 'completada'), 0)        AS minutos_realizados,
            COUNT(DISTINCT lower(trim(c.cliente_nombre)))
                     FILTER (WHERE c.estado <> 'cancelada')            AS clientes_unicos
         FROM reserva.reserva_cita c
         WHERE ${FILTRO_BASE}`,
        { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
    );

    const [svc] = await Models.sequelize.query(
        `SELECT COUNT(*) AS servicios_realizados
         FROM reserva.reserva_cita_servicio cs
         JOIN reserva.reserva_cita c ON c.id_cita = cs.id_cita
         WHERE ${FILTRO_BASE} AND c.estado = 'completada'`,
        { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
    );

    const citasTotales = Number(row?.citas_totales ?? 0);
    const completadas = Number(row?.completadas ?? 0);
    const canceladas = Number(row?.canceladas ?? 0);
    const noShow = Number(row?.no_show ?? 0);
    const ingresos = Number(row?.ingresos ?? 0);
    const facturables = completadas + Number(row?.confirmadas ?? 0);

    return {
        citas_totales: citasTotales,
        citas_activas: Number(row?.citas_activas ?? 0),
        completadas,
        confirmadas: Number(row?.confirmadas ?? 0),
        pendientes: Number(row?.pendientes ?? 0),
        canceladas,
        no_show: noShow,
        pagos_por_validar: Number(row?.pagos_por_validar ?? 0),
        ingresos,
        ingresos_completados: Number(row?.ingresos_completados ?? 0),
        servicios_realizados: Number(svc?.servicios_realizados ?? 0),
        minutos_realizados: Math.round(Number(row?.minutos_realizados ?? 0)),
        clientes_unicos: Number(row?.clientes_unicos ?? 0),
        // El ticket se calcula sobre las citas que facturan, no sobre todas: dividir entre
        // canceladas incluidas daría un promedio que no le han cobrado a nadie.
        ticket_promedio: facturables > 0 ? Math.round(ingresos / facturables) : 0,
        tasa_cancelacion: citasTotales > 0 ? Math.round((canceladas / citasTotales) * 1000) / 10 : 0,
        tasa_no_show: citasTotales > 0 ? Math.round((noShow / citasTotales) * 1000) / 10 : 0,
    };
}

/**
 * Un punto por día del rango, **incluidos los días sin actividad**.
 *
 * `generate_series` es lo que evita que una gráfica de líneas una el lunes con el jueves como
 * si el martes no hubiera existido: un día cerrado vale cero, y cero es un dato.
 */
async function seriePorDia(repl) {
    const filas = await Models.sequelize.query(
        `WITH dias AS (
            SELECT generate_series(:ini::date, (:fin::date - INTERVAL '1 day')::date, INTERVAL '1 day')::date AS fecha
         )
         SELECT d.fecha,
                COUNT(c.id_cita) FILTER (WHERE c.estado <> 'cancelada')  AS citas,
                COUNT(c.id_cita) FILTER (WHERE c.estado = 'completada')  AS completadas,
                COUNT(c.id_cita) FILTER (WHERE c.estado = 'cancelada')   AS canceladas,
                COALESCE(SUM(c.monto_total) FILTER (WHERE c.estado IN ('confirmada','completada')), 0) AS ingresos
         FROM dias d
         LEFT JOIN reserva.reserva_cita c
                ON c.fecha_hora_inicio::date = d.fecha
               AND c.id_negocio = :idNegocio
               AND (:idProfesional::int IS NULL OR c.id_profesional = :idProfesional)
         GROUP BY d.fecha
         ORDER BY d.fecha`,
        { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
    );
    return filas.map(f => ({
        fecha: typeof f.fecha === 'string' ? f.fecha : Reglas.fechaISOLocal(f.fecha),
        citas: Number(f.citas),
        completadas: Number(f.completadas),
        canceladas: Number(f.canceladas),
        ingresos: Number(f.ingresos),
    }));
}

async function agregadoPorProfesional(repl) {
    const filas = await Models.sequelize.query(
        `SELECT p.id_profesional,
                p.nombre,
                p.color_hex,
                p.especialidad,
                COUNT(c.id_cita) FILTER (WHERE c.estado <> 'cancelada')  AS citas,
                COUNT(c.id_cita) FILTER (WHERE c.estado = 'completada')  AS completadas,
                COUNT(c.id_cita) FILTER (WHERE c.estado = 'cancelada')   AS canceladas,
                COUNT(c.id_cita) FILTER (WHERE c.estado = 'no_show')     AS no_show,
                COALESCE(SUM(c.monto_total) FILTER (WHERE c.estado IN ('confirmada','completada')), 0) AS ingresos,
                COALESCE(SUM(EXTRACT(EPOCH FROM (c.fecha_hora_fin - c.fecha_hora_inicio)) / 60)
                         FILTER (WHERE c.estado = 'completada'), 0)      AS minutos
         FROM reserva.reserva_profesional p
         LEFT JOIN reserva.reserva_cita c
                ON c.id_profesional = p.id_profesional
               AND c.fecha_hora_inicio >= :ini
               AND c.fecha_hora_inicio <  :fin
         WHERE p.id_negocio = :idNegocio
           AND p.estado = 'A'
           AND (:idProfesional::int IS NULL OR p.id_profesional = :idProfesional)
         GROUP BY p.id_profesional, p.nombre, p.color_hex, p.especialidad
         ORDER BY ingresos DESC, citas DESC, p.nombre ASC`,
        { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
    );

    // Los servicios por profesional van aparte: contarlos en el JOIN de arriba multiplicaría
    // las filas de cita y falsearía los importes (el clásico fan-out de dos JOIN uno-a-muchos).
    const servicios = await Models.sequelize.query(
        `SELECT c.id_profesional, COUNT(*) AS servicios
         FROM reserva.reserva_cita_servicio cs
         JOIN reserva.reserva_cita c ON c.id_cita = cs.id_cita
         WHERE ${FILTRO_BASE} AND c.estado <> 'cancelada'
         GROUP BY c.id_profesional`,
        { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
    );
    const mapaSvc = new Map(servicios.map(s => [Number(s.id_profesional), Number(s.servicios)]));

    return filas.map(f => {
        const citas = Number(f.citas);
        const ingresos = Number(f.ingresos);
        return {
            id_profesional: Number(f.id_profesional),
            nombre: f.nombre,
            especialidad: f.especialidad,
            color_hex: f.color_hex,
            citas,
            completadas: Number(f.completadas),
            canceladas: Number(f.canceladas),
            no_show: Number(f.no_show),
            servicios: mapaSvc.get(Number(f.id_profesional)) ?? 0,
            ingresos,
            minutos: Math.round(Number(f.minutos)),
            ticket_promedio: citas > 0 ? Math.round(ingresos / citas) : 0,
        };
    });
}

async function agregadoPorServicio(repl) {
    const filas = await Models.sequelize.query(
        `SELECT s.id_servicio,
                s.nombre,
                COUNT(*)                                  AS veces,
                COUNT(*) FILTER (WHERE c.estado = 'completada') AS completados,
                COALESCE(SUM(cs.precio_snapshot), 0)      AS ingresos,
                COALESCE(SUM(cs.duracion_snapshot_min), 0) AS minutos
         FROM reserva.reserva_cita_servicio cs
         JOIN reserva.reserva_cita     c ON c.id_cita = cs.id_cita
         JOIN reserva.reserva_servicio s ON s.id_servicio = cs.id_servicio
         WHERE ${FILTRO_BASE} AND c.estado <> 'cancelada'
         GROUP BY s.id_servicio, s.nombre
         ORDER BY veces DESC, ingresos DESC
         LIMIT 12`,
        { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
    );
    return filas.map(f => ({
        id_servicio: Number(f.id_servicio),
        nombre: f.nombre,
        veces: Number(f.veces),
        completados: Number(f.completados),
        ingresos: Number(f.ingresos),
        minutos: Number(f.minutos),
    }));
}

async function conteoPorEstado(repl) {
    const filas = await Models.sequelize.query(
        `SELECT c.estado, COUNT(*) AS citas,
                COALESCE(SUM(c.monto_total), 0) AS monto
         FROM reserva.reserva_cita c
         WHERE ${FILTRO_BASE}
         GROUP BY c.estado`,
        { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
    );
    const mapa = new Map(filas.map(f => [f.estado, f]));
    // Orden fijo por el ciclo de vida de la cita, no por volumen: así la lista no baila entre
    // dos rangos y se puede comparar de un vistazo.
    return ['pendiente', 'confirmada', 'completada', 'cancelada', 'no_show'].map(estado => ({
        estado,
        citas: Number(mapa.get(estado)?.citas ?? 0),
        monto: Number(mapa.get(estado)?.monto ?? 0),
    }));
}

/** Reparto por hora de inicio: dice a qué horas conviene tener gente. */
async function conteoPorHora(repl) {
    const filas = await Models.sequelize.query(
        `SELECT EXTRACT(HOUR FROM c.fecha_hora_inicio)::int AS hora, COUNT(*) AS citas
         FROM reserva.reserva_cita c
         WHERE ${FILTRO_BASE} AND c.estado <> 'cancelada'
         GROUP BY 1
         ORDER BY 1`,
        { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
    );
    const mapa = new Map(filas.map(f => [Number(f.hora), Number(f.citas)]));
    // Se devuelven las 24 horas aunque estén a cero: la vista recorta el tramo con actividad,
    // pero necesita el eje completo para no inventarse huecos.
    return Array.from({ length: 24 }, (_, h) => ({ hora: h, citas: mapa.get(h) ?? 0 }));
}

async function mejoresClientes(repl) {
    const filas = await Models.sequelize.query(
        `SELECT trim(c.cliente_nombre) AS nombre,
                MAX(c.cliente_telefono) AS telefono,
                COUNT(*) AS citas,
                COALESCE(SUM(c.monto_total) FILTER (WHERE c.estado IN ('confirmada','completada')), 0) AS ingresos,
                MAX(c.fecha_hora_inicio) AS ultima
         FROM reserva.reserva_cita c
         WHERE ${FILTRO_BASE} AND c.estado <> 'cancelada'
         GROUP BY lower(trim(c.cliente_nombre)), trim(c.cliente_nombre)
         ORDER BY ingresos DESC, citas DESC
         LIMIT 8`,
        { replacements: repl, type: Models.sequelize.QueryTypes.SELECT },
    );
    return filas.map(f => ({
        nombre: f.nombre,
        telefono: f.telefono,
        citas: Number(f.citas),
        ingresos: Number(f.ingresos),
        ultima: f.ultima,
    }));
}

module.exports = { getInforme, ESTADOS_QUE_FACTURAN };
