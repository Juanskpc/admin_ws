'use strict';
const Models = require('../../app_core/models/conection');
const Reglas = require('./reglasAgenda');

/**
 * Calcula los slots disponibles para un servicio + profesional + fecha.
 *
 * Desde F3 **no implementa las reglas de la agenda**: las consume de `reglasAgenda`, que es
 * el mismo módulo que usa la creación de citas. Antes había dos implementaciones de la misma
 * regla y divergieron —el buffer se aplicaba a medias aquí y entero al crear—, así que este
 * servicio ofrecía horas que después se rechazaban con un 409. Su trabajo ahora es solo el
 * que le corresponde: **partir los huecos reservables en slots**.
 *
 * Algoritmo:
 *   1. Config del negocio (anticipación, buffer, paso de slot).
 *   2. Servicio (duración) y profesional, ambos del negocio.
 *   3. `Reglas.huecosReservables` → horario laboral − bloqueos − (citas y holds ± buffer).
 *   4. Genera slots cada `paso_slot_min` que quepan enteros en un hueco.
 *   5. Marca como no disponibles los que no cumplen la anticipación mínima.
 *
 * **Garantía de F3:** todo slot marcado `disponible: true` pasa la verificación de
 * `Reglas.verificarReservable`. Si eso deja de ser cierto, es un bug, no una diferencia de
 * criterio.
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

    const vacio = {
        fecha: fechaISO,
        duracion_servicio_min: servicio.duracion_min,
        buffer_min: cfg.buffer_limpieza_min,
        paso_slot_min: cfg.paso_slot_min,
        slots: [],
    };

    const huecos = await Reglas.huecosReservables({
        idNegocio,
        idProfesional,
        fechaISO,
        bufferMin: cfg.buffer_limpieza_min,
    });
    if (huecos.length === 0) return vacio;

    const minimoInicio = Reglas.addMinutes(new Date(), cfg.anticipacion_min_horas * 60);
    const duracion = servicio.duracion_min;
    const paso = cfg.paso_slot_min;
    const slots = [];

    for (const [desde, hasta] of huecos) {
        let t = redondearHaciaArriba(desde, paso);
        while (Reglas.addMinutes(t, duracion) <= hasta) {
            const disponible = t >= minimoInicio;
            slots.push({
                hora: formatearHoraLocal(t),
                disponible,
                ...(disponible ? {} : { motivo: 'anticipacion' }),
            });
            t = Reglas.addMinutes(t, paso);
        }
    }

    // Dos huecos distintos no pueden producir la misma hora, pero sí llegan desordenados
    // cuando un bloqueo parte la jornada. El cliente espera la lista en orden.
    slots.sort((a, b) => a.hora.localeCompare(b.hora));

    return { ...vacio, slots };
}

// ────────────────────────── Helpers propios de la vista de slots ──────────────────────────

function formatearHoraLocal(date) {
    const opts = { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false };
    return new Intl.DateTimeFormat('en-GB', opts).format(date);
}

/** Redondea `date` hacia arriba al múltiplo más cercano de `pasoMin`. */
function redondearHaciaArriba(date, pasoMin) {
    const ms = pasoMin * 60_000;
    return new Date(Math.ceil(date.getTime() / ms) * ms);
}

async function getConfig(idNegocio) {
    const cfg = await Models.ReservaConfig.findByPk(idNegocio);
    if (cfg) return cfg.toJSON();
    // Crear config por defecto si no existe (idempotente)
    const created = await Models.ReservaConfig.create({ id_negocio: idNegocio });
    return created.toJSON();
}

module.exports = { calcularSlots, getConfig };
