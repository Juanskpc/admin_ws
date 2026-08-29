'use strict';
const Models = require('../../app_core/models/conection');
const Reglas = require('./reglasAgenda');

/**
 * Calcula los slots disponibles para unos servicios + profesional + fecha.
 *
 * Desde F3 **no implementa las reglas de la agenda**: las consume de `reglasAgenda`, que es
 * el mismo módulo que usa la creación de citas. Antes había dos implementaciones de la misma
 * regla y divergieron —el buffer se aplicaba a medias aquí y entero al crear—, así que este
 * servicio ofrecía horas que después se rechazaban con un 409. Su trabajo ahora es solo el
 * que le corresponde: **partir los huecos reservables en slots**.
 *
 * Algoritmo:
 *   1. Config del negocio (anticipación, buffer, paso de slot).
 *   2. Servicios (duración total) y profesional, todos del negocio.
 *   3. `Reglas.huecosReservables` → horario laboral − bloqueos − (citas y holds ± buffer).
 *   4. Genera slots cada `paso_slot_min` que quepan enteros en un hueco.
 *   5. Marca como no disponibles los que no cumplen la anticipación mínima.
 *
 * **Garantía de F3:** todo slot marcado `disponible: true` pasa la verificación de
 * `Reglas.verificarReservable`. Si eso deja de ser cierto, es un bug, no una diferencia de
 * criterio.
 *
 * ## Por qué acepta varios servicios
 *
 * `crearCita` reserva la **suma** de las duraciones de todos los servicios de la cita
 * (`citaService`: `duracionTotal = servicios.reduce(...)`). Este servicio solo sabía de uno,
 * así que al pedir corte + peinado ofrecía slots del tamaño del primero y la creación los
 * rechazaba por solaparse: la misma divergencia que F3 vino a cerrar, en el otro eje.
 * `idServicios` es ahora la entrada natural; `idServicio` se mantiene porque el enlace público
 * de reserva lo sigue enviando.
 *
 * Devuelve: { fecha, duracion_servicio_min, buffer_min, paso_slot_min, slots: [{ hora, disponible, motivo? }] }
 */
async function calcularSlots({ idNegocio, idServicio, idServicios, idProfesional, fechaISO }) {
    const ids = normalizarIdsServicio(idServicios, idServicio);
    if (!idNegocio || ids.length === 0 || !idProfesional || !fechaISO) {
        const e = new Error('Parámetros incompletos'); e.statusCode = 400; throw e;
    }

    const cfg = await getConfig(idNegocio);
    const servicios = await Models.ReservaServicio.findAll({
        where: { id_servicio: ids, id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_servicio', 'duracion_min'],
    });
    if (servicios.length !== ids.length) {
        const e = new Error('Servicio no encontrado'); e.statusCode = 404; throw e;
    }
    const duracion = servicios.reduce((acc, s) => acc + s.duracion_min, 0);

    const profesional = await Models.ReservaProfesional.findOne({
        where: { id_profesional: idProfesional, id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_profesional'],
    });
    if (!profesional) {
        const e = new Error('Profesional no encontrado'); e.statusCode = 404; throw e;
    }

    const vacio = {
        fecha: fechaISO,
        duracion_servicio_min: duracion,
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

/**
 * Qué días de un rango tienen jornada laboral, y de qué hora a qué hora.
 *
 * Responde a la pregunta que el formulario de cita hacía **antes** de pedir slots y que hasta
 * ahora nadie contestaba: el selector de fecha ofrecía cualquier día del calendario y el
 * usuario descubría que el negocio no abre los lunes solo tras elegir el lunes y ver la lista
 * de horas vacía. Un día cerrado no debería ser seleccionable.
 *
 * Se apoya en `Reglas.intervalosLaborales`, la misma primitiva que usan slots y creación, así
 * que «el día está abierto» aquí significa exactamente lo mismo que allí: hay horario para ese
 * día de la semana y ningún bloqueo se lo ha comido entero.
 *
 * `idProfesional` es opcional: sin él responde por el horario general del negocio, que es lo
 * que se quiere mostrar antes de que el usuario elija profesional.
 *
 * Devuelve: [{ fecha, abierto, minutos, rangos: [{ inicio, fin }] }]
 */
async function diasDisponibles({ idNegocio, idProfesional = null, desde, hasta }) {
    if (!idNegocio || !desde || !hasta) {
        const e = new Error('Parámetros incompletos'); e.statusCode = 400; throw e;
    }

    const fechas = enumerarFechas(desde, hasta);
    if (fechas.length === 0) {
        const e = new Error('Rango de fechas inválido'); e.statusCode = 400; throw e;
    }
    // Consultar una tabla por día es una consulta por día. 92 (un trimestre) es holgado para
    // un selector de fechas y acota el coste.
    if (fechas.length > 92) {
        const e = new Error('El rango no puede superar 92 días'); e.statusCode = 400; throw e;
    }

    return Promise.all(fechas.map(async (fechaISO) => {
        const laborales = await Reglas.intervalosLaborales({ idNegocio, idProfesional, fechaISO });
        const minutos = laborales.reduce((acc, [i, f]) => acc + (f - i) / 60_000, 0);
        return {
            fecha: fechaISO,
            abierto: laborales.length > 0,
            minutos,
            rangos: laborales.map(([i, f]) => ({
                inicio: formatearHoraLocal(i),
                fin: formatearHoraLocal(f),
            })),
        };
    }));
}

// ────────────────────────── Helpers propios de la vista de slots ──────────────────────────

/**
 * Acepta `[1,2]`, `"1,2"`, `"[1,2]"` o un único id, y devuelve ids únicos.
 *
 * El multipart del flujo público manda los arrays como string, así que la normalización vive
 * donde se usa en vez de depender de que cada llamante la haya hecho bien.
 */
function normalizarIdsServicio(idServicios, idServicio) {
    let bruto = idServicios;
    if (typeof bruto === 'string') {
        const s = bruto.trim();
        try { bruto = s.startsWith('[') ? JSON.parse(s) : s.split(','); }
        catch { bruto = s.split(','); }
    }
    if (bruto == null) bruto = idServicio == null ? [] : [idServicio];
    if (!Array.isArray(bruto)) bruto = [bruto];

    const ids = bruto
        .map((v) => Number(String(v).trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    return [...new Set(ids)];
}

function formatearHoraLocal(date) {
    const opts = { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false };
    return new Intl.DateTimeFormat('en-GB', opts).format(date);
}

/** Redondea `date` hacia arriba al múltiplo más cercano de `pasoMin`. */
function redondearHaciaArriba(date, pasoMin) {
    const ms = pasoMin * 60_000;
    return new Date(Math.ceil(date.getTime() / ms) * ms);
}

/** `YYYY-MM-DD` de cada día entre `desde` y `hasta`, ambos inclusive. */
function enumerarFechas(desde, hasta) {
    const ini = Reglas.inicioDelDia(desde);
    const fin = Reglas.inicioDelDia(hasta);
    if (Number.isNaN(ini.getTime()) || Number.isNaN(fin.getTime()) || fin < ini) return [];
    const out = [];
    for (let d = ini; d <= fin; d = Reglas.addMinutes(d, 24 * 60)) {
        out.push(Reglas.fechaISOLocal(d));
    }
    return out;
}

async function getConfig(idNegocio) {
    const cfg = await Models.ReservaConfig.findByPk(idNegocio);
    if (cfg) return cfg.toJSON();
    // Crear config por defecto si no existe (idempotente)
    const created = await Models.ReservaConfig.create({ id_negocio: idNegocio });
    return created.toJSON();
}

module.exports = { calcularSlots, diasDisponibles, getConfig };
