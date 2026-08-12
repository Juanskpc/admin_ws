/**
 * Reglas de la agenda — las invariantes de `reserva`, en un solo sitio.
 *
 * ## Por qué existe este archivo
 *
 * Hasta F3 las reglas de la agenda estaban escritas **dos veces y distintas**: una en
 * `disponibilidadService` (para ofrecer horas) y otra en `citaService` (para aceptarlas).
 * Dos implementaciones de la misma regla siempre acaban divergiendo, y ésta divergió:
 *
 * - Disponibilidad expandía cada cita existente **medio buffer** a cada lado; creación la
 *   expandía **entero**. Resultado: había horas que el sistema ofrecía y luego rechazaba con
 *   un 409. Reproducido con `buffer=30`: se ofrecía las 10:45 tras una cita de 10:00–10:30 y
 *   `crearCita` la rechazaba.
 * - Creación **no miraba el horario laboral ni los bloqueos**. Estaba tapado porque el único
 *   cliente era un formulario que consultaba disponibilidad primero y solo ofrecía lo válido.
 *   Un agente no tiene esa cortesía, y `curl` tampoco.
 *
 * Este módulo es la definición única. Los dos servicios consumen **las mismas dos
 * primitivas**, así que no pueden volver a divergir:
 *
 *     intervalosLaborales()  → cuándo se puede trabajar  (horario − bloqueos)
 *     intervalosOcupados()   → cuándo ya no se puede     (citas + holds, ± buffer)
 *
 * Ofrecer una hora es «cabe en laboral y no toca ocupado». Aceptarla es exactamente lo
 * mismo. Ésa es toda la unificación.
 *
 * ## Semántica del buffer (se eligió la estricta, a conciencia)
 *
 * `buffer_limpieza_min` es el hueco que el negocio quiere **entre dos citas**. La única
 * lectura que lo cumple es expandir cada cita el buffer **completo** a cada lado, que es lo
 * que ya hacía la creación. La de disponibilidad (medio buffer, sin expandir el hueco
 * candidato) dejaba un hueco real de `buffer/2`: no era otra convención, era un error.
 *
 * Consecuencia visible: **el formulario web ofrecerá menos horas que antes** cuando haya un
 * buffer configurado. Son las horas que nunca se pudieron confirmar. Se gana que una hora
 * ofrecida siempre se pueda reservar, que es el criterio de aceptación de F3.
 *
 * ## Nota de tiempo
 *
 * `reserva` guarda `timestamp without time zone` interpretado como hora de pared de Bogotá
 * (ADR-024: las verticales conservan wall-time). Todo lo de aquí ancla en `-05:00`
 * explícitamente, igual que hacía `disponibilidadService`.
 */
'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

/** Estados de cita que ocupan agenda. Una cancelada o un no-show liberan el hueco. */
const ESTADOS_QUE_OCUPAN = ['pendiente', 'confirmada'];

function error(code, mensaje, statusCode = 409) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

// ─────────────────────────────── Helpers de tiempo ───────────────────────────────

function addMinutes(date, mins) {
    return new Date(date.getTime() + mins * 60_000);
}

/** `YYYY-MM-DD` de un instante, en hora de Bogotá. */
function fechaISOLocal(date) {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const m = Object.fromEntries(partes.map((p) => [p.type, p.value]));
    return `${m.year}-${m.month}-${m.day}`;
}

/** Día de la semana (0=Dom) en hora de Bogotá, no en la del proceso Node. */
function diaSemanaLocal(date) {
    return new Date(`${fechaISOLocal(date)}T12:00:00-05:00`).getDay();
}

/** Medianoche de Bogotá del día de `fechaISO`. */
function inicioDelDia(fechaISO) {
    return new Date(`${fechaISO}T00:00:00-05:00`);
}

/** Combina un día con `"HH:MM[:SS]"` en hora de Bogotá. */
function combinarFechaHora(fechaISO, horaStr) {
    const [hh = '0', mm = '0', ss = '0'] = String(horaStr).split(':');
    const p = (n) => String(parseInt(n, 10)).padStart(2, '0');
    return new Date(`${fechaISO}T${p(hh)}:${p(mm)}:${p(ss)}-05:00`);
}

/** Resta el intervalo `b` de `a`. Devuelve 0..2 sub-intervalos. */
function restarIntervalo([aIni, aFin], [bIni, bFin]) {
    if (bFin <= aIni || bIni >= aFin) return [[aIni, aFin]];
    const out = [];
    if (bIni > aIni) out.push([aIni, bIni]);
    if (bFin < aFin) out.push([bFin, aFin]);
    return out;
}

function seSolapan([aIni, aFin], [bIni, bFin]) {
    return aIni < bFin && bIni < aFin;
}

function contenido([hijoIni, hijoFin], [padreIni, padreFin]) {
    return hijoIni >= padreIni && hijoFin <= padreFin;
}

// ─────────────────────────── Primitiva 1: cuándo se trabaja ───────────────────────────

/**
 * Intervalos en los que ese profesional puede atender ese día: su horario laboral menos
 * los bloqueos que le aplican.
 *
 * El horario sale del override por profesional y, si no tiene, del horario del negocio
 * (`id_profesional IS NULL`). Los bloqueos aplican si son suyos o del negocio entero.
 */
async function intervalosLaborales({ idNegocio, idProfesional, fechaISO }, { transaction } = {}) {
    const dia = inicioDelDia(fechaISO);
    const finDia = addMinutes(dia, 24 * 60);
    // El día de la semana se calcula en hora de Bogotá, no en la del proceso: con TZ=UTC,
    // `dia.getDay()` sobre la medianoche bogotana devuelve el día anterior.
    const diaSemana = diaSemanaLocal(dia);

    let horario = await Models.ReservaHorario.findAll({
        where: { id_negocio: idNegocio, id_profesional: idProfesional, dia_semana: diaSemana },
        attributes: ['hora_inicio', 'hora_fin'],
        order: [['hora_inicio', 'ASC']],
        transaction,
    });
    if (horario.length === 0) {
        horario = await Models.ReservaHorario.findAll({
            where: { id_negocio: idNegocio, id_profesional: null, dia_semana: diaSemana },
            attributes: ['hora_inicio', 'hora_fin'],
            order: [['hora_inicio', 'ASC']],
            transaction,
        });
    }
    if (horario.length === 0) return [];

    const bloqueos = await Models.ReservaBloqueo.findAll({
        where: {
            id_negocio: idNegocio,
            [Op.or]: [{ id_profesional: idProfesional }, { id_profesional: null }],
            fecha_inicio: { [Op.lt]: finDia },
            fecha_fin: { [Op.gt]: dia },
        },
        attributes: ['fecha_inicio', 'fecha_fin'],
        transaction,
    });

    let libres = horario.map((h) => [
        combinarFechaHora(fechaISO, h.hora_inicio),
        combinarFechaHora(fechaISO, h.hora_fin),
    ]);

    for (const b of bloqueos) {
        const bloqueo = [new Date(b.fecha_inicio), new Date(b.fecha_fin)];
        libres = libres.flatMap((l) => restarIntervalo(l, bloqueo));
    }

    return libres;
}

// ─────────────────────────── Primitiva 2: cuándo ya está cogido ───────────────────────────

/**
 * Intervalos ya comprometidos de ese profesional en ese día: citas activas **y holds
 * vigentes**, cada uno expandido el buffer completo a cada lado.
 *
 * Que los holds cuenten aquí es lo que hace que una reserva temporal proteja el slot de
 * verdad: si no participaran en esta comprobación, dos clientes podrían tomar un hold sobre
 * la misma hora y el segundo descubriría el choque al confirmar, que es justo el momento en
 * el que ya le prometiste la cita.
 *
 * @param {number} [opciones.excluirCita] — id de cita a ignorar (reagendar no choca consigo misma).
 * @param {number} [opciones.excluirHold] — id de hold a ignorar (confirmar no choca con su propio hold).
 */
async function intervalosOcupados(
    { idNegocio, idProfesional, fechaISO, bufferMin },
    { transaction, excluirCita = null, excluirHold = null } = {}
) {
    const dia = inicioDelDia(fechaISO);
    const finDia = addMinutes(dia, 24 * 60);
    // Se ensancha la ventana de búsqueda por el buffer: una cita que empieza justo antes de
    // medianoche puede seguir ocupando dentro del día siguiente.
    const desde = addMinutes(dia, -bufferMin);
    const hasta = addMinutes(finDia, bufferMin);

    const whereCitas = {
        id_negocio: idNegocio,
        id_profesional: idProfesional,
        estado: { [Op.in]: ESTADOS_QUE_OCUPAN },
        fecha_hora_inicio: { [Op.lt]: hasta },
        fecha_hora_fin: { [Op.gt]: desde },
    };
    if (excluirCita) whereCitas.id_cita = { [Op.ne]: excluirCita };

    const citas = await Models.ReservaCita.findAll({
        where: whereCitas,
        attributes: ['id_cita', 'fecha_hora_inicio', 'fecha_hora_fin'],
        transaction,
    });

    // Un hold expirado deja de contar sin que nadie lo borre: la agenda se libera sola. Por
    // eso no hay cron de limpieza — un cron sería maquinaria para un problema que el
    // predicado ya resuelve.
    const whereHolds = {
        id_negocio: idNegocio,
        id_profesional: idProfesional,
        estado: 'activo',
        expira_en: { [Op.gt]: new Date() },
        fecha_hora_inicio: { [Op.lt]: hasta },
        fecha_hora_fin: { [Op.gt]: desde },
    };
    if (excluirHold) whereHolds.id_hold = { [Op.ne]: excluirHold };

    const holds = await Models.ReservaHold.findAll({
        where: whereHolds,
        attributes: ['id_hold', 'fecha_hora_inicio', 'fecha_hora_fin'],
        transaction,
    });

    const expandir = (ini, fin) => [
        addMinutes(new Date(ini), -bufferMin),
        addMinutes(new Date(fin), +bufferMin),
    ];

    return [
        ...citas.map((c) => expandir(c.fecha_hora_inicio, c.fecha_hora_fin)),
        ...holds.map((h) => expandir(h.fecha_hora_inicio, h.fecha_hora_fin)),
    ];
}

// ─────────────────────────────── Las dos preguntas ───────────────────────────────

/**
 * Huecos realmente reservables del día: laboral menos ocupado.
 *
 * Es lo que consume `disponibilidadService` para generar slots. Al restar aquí lo ocupado
 * **ya expandido por el buffer**, cualquier slot que quepa en el resultado pasa después la
 * verificación de `verificarReservable`. Ésa es la garantía de F3.
 */
async function huecosReservables({ idNegocio, idProfesional, fechaISO, bufferMin }, opciones = {}) {
    const laborales = await intervalosLaborales({ idNegocio, idProfesional, fechaISO }, opciones);
    if (laborales.length === 0) return [];

    const ocupados = await intervalosOcupados({ idNegocio, idProfesional, fechaISO, bufferMin }, opciones);

    let libres = laborales;
    for (const ocupado of ocupados) {
        libres = libres.flatMap((l) => restarIntervalo(l, ocupado));
    }
    return libres;
}

/**
 * ¿Se puede comprometer `[inicio, fin]`? Lanza un error tipado si no.
 *
 * Es la puerta única por la que pasan `crearCita` y `tomarHold`. Que las dos usen esta
 * función es lo que hace imposible que una acepte lo que la otra rechaza.
 *
 * @throws FUERA_DE_HORARIO · SOBRE_BLOQUEO · SLOT_NO_DISPONIBLE
 */
async function verificarReservable(
    { idNegocio, idProfesional, inicio, fin, bufferMin },
    opciones = {}
) {
    const fechaISO = fechaISOLocal(inicio);

    const laborales = await intervalosLaborales({ idNegocio, idProfesional, fechaISO }, opciones);

    if (laborales.length === 0) {
        // Sin horario y sin bloqueos son dos causas distintas con el mismo síntoma. Se
        // distinguen porque el mensaje al cliente es diferente: «no abrimos los domingos»
        // no es lo mismo que «Laura está de vacaciones».
        const horarioDelDia = await Models.ReservaHorario.count({
            where: {
                id_negocio: idNegocio,
                dia_semana: diaSemanaLocal(inicio),
                [Op.or]: [{ id_profesional: idProfesional }, { id_profesional: null }],
            },
            transaction: opciones.transaction,
        });
        throw horarioDelDia > 0
            ? error('SOBRE_BLOQUEO', 'El profesional no está disponible ese día.')
            : error('FUERA_DE_HORARIO', 'El negocio no atiende ese día.');
    }

    const candidato = [inicio, fin];

    // Debe caber ENTERO en un único intervalo laboral: una cita no puede empezar antes de
    // la pausa del almuerzo y terminar después.
    if (!laborales.some((l) => contenido(candidato, l))) {
        const bloqueoQueEstorba = await Models.ReservaBloqueo.findOne({
            where: {
                id_negocio: idNegocio,
                [Op.or]: [{ id_profesional: idProfesional }, { id_profesional: null }],
                fecha_inicio: { [Op.lt]: fin },
                fecha_fin: { [Op.gt]: inicio },
            },
            attributes: ['id_bloqueo'],
            transaction: opciones.transaction,
        });
        throw bloqueoQueEstorba
            ? error('SOBRE_BLOQUEO', 'Ese horario está bloqueado en la agenda.')
            : error('FUERA_DE_HORARIO', 'Ese horario está fuera del horario de atención.');
    }

    const ocupados = await intervalosOcupados(
        { idNegocio, idProfesional, fechaISO, bufferMin },
        opciones
    );

    if (ocupados.some((o) => seSolapan(candidato, o))) {
        throw error('SLOT_NO_DISPONIBLE', 'Ese horario ya no está disponible.');
    }
}

module.exports = {
    intervalosLaborales,
    intervalosOcupados,
    huecosReservables,
    verificarReservable,
    ESTADOS_QUE_OCUPAN,
    // Exportados para que `disponibilidadService` y los tests compartan la aritmética de
    // tiempo en vez de reimplementarla, que es como empezó la divergencia del buffer.
    addMinutes,
    fechaISOLocal,
    diaSemanaLocal,
    inicioDelDia,
    combinarFechaHora,
};
