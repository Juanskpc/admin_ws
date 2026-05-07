'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

/**
 * Calcula los slots disponibles para un servicio + profesional + fecha.
 *
 * Algoritmo:
 *   1. Carga config del negocio (anticipación, buffer, paso de slot).
 *   2. Carga servicio (duración).
 *   3. Carga horario laboral del profesional para el día (con fallback al horario del negocio).
 *   4. Resta bloqueos.
 *   5. Resta citas existentes ± buffer.
 *   6. Genera slots cada `paso_slot_min` que quepan duración.
 *   7. Filtra los que no cumplen anticipación mínima.
 *
 * Devuelve: { fecha, duracion_servicio_min, buffer_min, paso_slot_min, slots: [{ hora, disponible, motivo? }] }
 */
async function calcularSlots({ idNegocio, idServicio, idProfesional, fechaISO }) {
    if (!idNegocio || !idServicio || !idProfesional || !fechaISO) {
        const e = new Error('Parámetros incompletos'); e.statusCode = 400; throw e;
    }

    const cfg = await getConfig(idNegocio);
    const servicio = await Models.ReservaServicio.findOne({
        where: { id_servicio: idServicio, id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_servicio', 'duracion_min'],
    });
    if (!servicio) {
        const e = new Error('Servicio no encontrado'); e.statusCode = 404; throw e;
    }

    const profesional = await Models.ReservaProfesional.findOne({
        where: { id_profesional: idProfesional, id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_profesional'],
    });
    if (!profesional) {
        const e = new Error('Profesional no encontrado'); e.statusCode = 404; throw e;
    }

    const dia = parseFechaLocal(fechaISO);                // Date a las 00:00 del día solicitado (Bogotá wall time)
    const diaSemana = dia.getDay();                       // 0=Dom..6=Sab
    const finDia = addMinutes(dia, 24 * 60);

    // Horario: primero override por profesional, si no, horario del negocio
    let horario = await Models.ReservaHorario.findAll({
        where: { id_negocio: idNegocio, id_profesional: idProfesional, dia_semana: diaSemana },
        attributes: ['hora_inicio', 'hora_fin'],
        order: [['hora_inicio', 'ASC']],
    });
    if (horario.length === 0) {
        horario = await Models.ReservaHorario.findAll({
            where: { id_negocio: idNegocio, id_profesional: null, dia_semana: diaSemana },
            attributes: ['hora_inicio', 'hora_fin'],
            order: [['hora_inicio', 'ASC']],
        });
    }

    if (horario.length === 0) {
        return {
            fecha: fechaISO,
            duracion_servicio_min: servicio.duracion_min,
            buffer_min: cfg.buffer_limpieza_min,
            paso_slot_min: cfg.paso_slot_min,
            slots: [],
        };
    }

    // Intervalos laborales del día como [Date, Date]
    const intervalosLibres = horario.map(h => ([
        combinarFechaHora(dia, h.hora_inicio),
        combinarFechaHora(dia, h.hora_fin),
    ]));

    // Bloqueos que solapan el día
    const bloqueos = await Models.ReservaBloqueo.findAll({
        where: {
            id_negocio: idNegocio,
            [Op.or]: [
                { id_profesional: idProfesional },
                { id_profesional: null },
            ],
            fecha_inicio: { [Op.lt]: finDia },
            fecha_fin:    { [Op.gt]: dia },
        },
        attributes: ['fecha_inicio', 'fecha_fin'],
    });

    // Citas activas del profesional en el día
    const citas = await Models.ReservaCita.findAll({
        where: {
            id_profesional: idProfesional,
            estado: { [Op.in]: ['pendiente', 'confirmada'] },
            fecha_hora_inicio: { [Op.lt]: finDia },
            fecha_hora_fin:    { [Op.gt]: dia },
        },
        attributes: ['fecha_hora_inicio', 'fecha_hora_fin'],
    });

    // Construir intervalos ocupados (bloqueos sin buffer; citas con buffer)
    const ocupados = [];
    for (const b of bloqueos) {
        ocupados.push([new Date(b.fecha_inicio), new Date(b.fecha_fin)]);
    }
    const halfBuffer = cfg.buffer_limpieza_min / 2;
    for (const c of citas) {
        ocupados.push([
            addMinutes(new Date(c.fecha_hora_inicio), -halfBuffer),
            addMinutes(new Date(c.fecha_hora_fin),    +halfBuffer),
        ]);
    }

    // Restar ocupados de cada intervalo libre
    let libres = intervalosLibres;
    for (const occ of ocupados) {
        libres = libres.flatMap(l => restarIntervalo(l, occ));
    }

    // Generar slots
    const ahora = new Date();
    const minimoInicio = addMinutes(ahora, cfg.anticipacion_min_horas * 60);
    const slots = [];
    const duracion = servicio.duracion_min;
    const paso = cfg.paso_slot_min;

    for (const [a, b] of libres) {
        let t = redondearHaciaArriba(a, paso);
        while (addMinutes(t, duracion) <= b) {
            const disponible = t >= minimoInicio;
            slots.push({
                hora: formatearHoraLocal(t),
                disponible,
                ...(disponible ? {} : { motivo: 'anticipacion' }),
            });
            t = addMinutes(t, paso);
        }
    }

    return {
        fecha: fechaISO,
        duracion_servicio_min: duracion,
        buffer_min: cfg.buffer_limpieza_min,
        paso_slot_min: paso,
        slots,
    };
}

// ────────────────────────── Helpers de tiempo ──────────────────────────

/** Construye un Date a las 00:00 hora Bogotá del día YYYY-MM-DD. */
function parseFechaLocal(fechaISO) {
    const [y, m, d] = fechaISO.split('-').map(Number);
    // -05:00 fijo (Colombia sin DST). El parser del pool ya ancla así, mantenemos coherencia.
    return new Date(`${fechaISO}T00:00:00-05:00`);
}

function addMinutes(date, mins) {
    return new Date(date.getTime() + mins * 60_000);
}

/** "HH:MM:SS" o "HH:MM" → combinar con día base, en hora Bogotá. */
function combinarFechaHora(diaBase, horaStr) {
    const partes = String(horaStr).split(':');
    const hh = parseInt(partes[0], 10);
    const mm = parseInt(partes[1], 10);
    const ss = parseInt(partes[2] || '0', 10);
    const fechaISO = formatearFechaISO(diaBase);
    return new Date(`${fechaISO}T${pad(hh)}:${pad(mm)}:${pad(ss)}-05:00`);
}

function formatearFechaISO(date) {
    // YYYY-MM-DD en hora Bogotá
    const opts = { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' };
    const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(date);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day}`;
}

function formatearHoraLocal(date) {
    const opts = { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false };
    return new Intl.DateTimeFormat('en-GB', opts).format(date);
}

function pad(n) { return String(n).padStart(2, '0'); }

/** Resta el intervalo `b` del intervalo `a`. Devuelve 0..2 sub-intervalos. */
function restarIntervalo([aStart, aEnd], [bStart, bEnd]) {
    if (bEnd <= aStart || bStart >= aEnd) return [[aStart, aEnd]];
    const out = [];
    if (bStart > aStart) out.push([aStart, bStart]);
    if (bEnd < aEnd) out.push([bEnd, aEnd]);
    return out;
}

/** Redondea `date` hacia arriba al múltiplo más cercano de `pasoMin`. */
function redondearHaciaArriba(date, pasoMin) {
    const ms = pasoMin * 60_000;
    const t = date.getTime();
    return new Date(Math.ceil(t / ms) * ms);
}

async function getConfig(idNegocio) {
    const cfg = await Models.ReservaConfig.findByPk(idNegocio);
    if (cfg) return cfg.toJSON();
    // Crear config por defecto si no existe (idempotente)
    const created = await Models.ReservaConfig.create({ id_negocio: idNegocio });
    return created.toJSON();
}

module.exports = { calcularSlots, getConfig };
