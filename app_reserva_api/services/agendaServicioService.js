'use strict';
const Models = require('../../app_core/models/conection');
const Disponibilidad = require('./disponibilidadService');

/**
 * Disponibilidad de **un servicio** vista desde el portal público.
 *
 * ## Por qué no basta con el endpoint por profesional
 *
 * La página de un servicio muestra el calendario y, debajo, los huecos de cada profesional que
 * lo hace. Resolverlo desde el cliente significaría una petición de días por profesional y otra
 * de slots por profesional cada vez que se toca un día: con siete profesionales, catorce
 * peticiones para pintar una pantalla, y el calendario parpadeando mientras llegan desordenadas.
 *
 * Aquí se hace una vez, del lado del servidor, contra la misma fuente de siempre
 * (`reglasAgenda` a través de `disponibilidadService`): no hay una segunda definición de «está
 * libre», solo se agrega la que ya existe.
 *
 * ## Qué significa que un día esté «abierto»
 *
 * Que **alguno** de los profesionales que ofrecen el servicio atienda ese día. Es la unión, no
 * la intersección: al cliente le da igual quién le atienda mientras alguien pueda.
 */

function error(mensaje, statusCode = 400) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    return e;
}

/**
 * Profesionales activos que ofrecen el servicio.
 *
 * Uno sin ninguna asignación ofrece el catálogo entero: misma convención que `listarProfesionales`
 * y que la validación de `citaService`. Si aquí se excluyera, el portal ofrecería menos gente de
 * la que en realidad puede atender.
 */
async function profesionalesDe(idNegocio, idServicio) {
    const servicio = await Models.ReservaServicio.findOne({
        where: { id_servicio: idServicio, id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_servicio', 'nombre', 'duracion_min', 'precio'],
    });
    if (!servicio) throw error('Servicio no disponible.', 404);

    const profesionales = await Models.ReservaProfesional.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_profesional', 'nombre', 'especialidad', 'foto_url', 'color_hex'],
        order: [['nombre', 'ASC']],
        raw: true,
    });
    if (!profesionales.length) return { servicio, profesionales: [] };

    const relaciones = await Models.ReservaProfesionalServicio.findAll({
        where: { id_profesional: profesionales.map(p => p.id_profesional) },
        attributes: ['id_profesional', 'id_servicio'],
        raw: true,
    });

    const asignadosPorProfesional = new Map();
    for (const r of relaciones) {
        if (!asignadosPorProfesional.has(r.id_profesional)) asignadosPorProfesional.set(r.id_profesional, new Set());
        asignadosPorProfesional.get(r.id_profesional).add(r.id_servicio);
    }

    const ofrecen = profesionales.filter(p => {
        const suyos = asignadosPorProfesional.get(p.id_profesional);
        return !suyos || suyos.has(idServicio);
    });

    return { servicio, profesionales: ofrecen };
}

/** `"2026-09-01"` + `"09:00"` → milisegundos, anclando la hora de pared en Bogotá (-05:00). */
function instante(fechaISO, hhmm) {
    return new Date(`${fechaISO}T${hhmm}:00-05:00`).getTime();
}

/**
 * ¿Cabe todavía una cita de `duracionMin` en esas franjas?
 *
 * Recorta cada franja por el primer momento reservable (`ahora + anticipación`) y comprueba que
 * quede un tramo **contiguo** de al menos la duración del servicio. Sin este recorte, el día de
 * hoy se marcaba abierto a las dos de la madrugada porque el horario dice «9 a 18», y al
 * pulsarlo no salía ni una hora: el punto verde prometía algo que la lista de huecos desmentía.
 *
 * Es aritmética sobre datos ya consultados, así que no cuesta una consulta más. Lo que **no**
 * detecta es un día futuro lleno de citas: eso exigiría calcular los huecos de los 42 días por
 * cada profesional. Ese caso lo resuelve la propia lista al abrir el día.
 */
function cabeAlgo(fechaISO, rangos, duracionMin, desdeMs) {
    return rangos.some(r => {
        const inicio = Math.max(instante(fechaISO, r.inicio), desdeMs);
        const fin = instante(fechaISO, r.fin);
        return fin - inicio >= duracionMin * 60_000;
    });
}

/** Días del rango en los que atiende alguien que hace el servicio. */
async function diasDelServicio({ idNegocio, idServicio, desde, hasta }) {
    const { servicio, profesionales } = await profesionalesDe(idNegocio, idServicio);
    if (!profesionales.length) return [];

    const cfg = await Disponibilidad.getConfig(idNegocio);
    const desdeMs = Date.now() + (cfg.anticipacion_min_horas || 0) * 3_600_000;

    const porProfesional = await Promise.all(profesionales.map(p =>
        Disponibilidad.diasDisponibles({
            idNegocio, idProfesional: p.id_profesional, desde, hasta,
        })));

    // Se fusionan por fecha. `id_profesionales` dice quién atiende ese día concreto, que es lo
    // que permite al cliente ver de un vistazo si el día que le sirve lo cubre quien le gusta.
    const porFecha = new Map();
    porProfesional.forEach((dias, i) => {
        const idProfesional = profesionales[i].id_profesional;
        for (const d of dias) {
            if (!porFecha.has(d.fecha)) {
                porFecha.set(d.fecha, { fecha: d.fecha, abierto: false, id_profesionales: [] });
            }
            if (d.abierto && cabeAlgo(d.fecha, d.rangos, servicio.duracion_min, desdeMs)) {
                const acumulado = porFecha.get(d.fecha);
                acumulado.abierto = true;
                acumulado.id_profesionales.push(idProfesional);
            }
        }
    });

    return [...porFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/**
 * Huecos de un día, agrupados por profesional.
 *
 * Se devuelven **solo los disponibles**: la lista de horas del portal es para elegir, no para
 * enterarse de cuáles están ocupadas. Un profesional sin ninguno se devuelve igualmente con la
 * lista vacía, para poder decir «hoy no atiende» en vez de hacerlo desaparecer sin explicación.
 */
async function slotsDelServicio({ idNegocio, idServicio, fechaISO }) {
    const { servicio, profesionales } = await profesionalesDe(idNegocio, idServicio);

    const resultados = await Promise.all(profesionales.map(async (p) => {
        try {
            const data = await Disponibilidad.calcularSlots({
                idNegocio, idServicios: [idServicio],
                idProfesional: p.id_profesional, fechaISO,
            });
            return { profesional: p, slots: data.slots.filter(s => s.disponible).map(s => s.hora) };
        } catch {
            // Un profesional que falle (sin horario ese día, por ejemplo) no debe tumbar la
            // página entera: se muestra sin huecos y los demás siguen apareciendo.
            return { profesional: p, slots: [] };
        }
    }));

    return {
        fecha: fechaISO,
        duracion_min: servicio.duracion_min,
        profesionales: resultados.map(r => ({
            id_profesional: r.profesional.id_profesional,
            nombre: r.profesional.nombre,
            especialidad: r.profesional.especialidad,
            foto_url: r.profesional.foto_url,
            color_hex: r.profesional.color_hex,
            slots: r.slots,
        })),
    };
}

module.exports = { diasDelServicio, slotsDelServicio, profesionalesDe };
