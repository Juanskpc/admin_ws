'use strict';
/**
 * Sincronización de calendarios con Airbnb, Booking y compañía (formato iCal).
 *
 * ## Por qué es parte de la primera versión y no un extra
 *
 * Casi todo alojamiento pequeño ya publica en esas plataformas. Si una noche vendida allá sigue
 * libre aquí, se vende dos veces, y ese es el fallo que un alojamiento no perdona. Por eso:
 *
 * - **Importar**: cada unidad puede tener calendarios externos; cada 15 minutos se descargan y
 *   cada evento se convierte en un bloqueo de la unidad (`reserva_bloqueo_unidad`, origen
 *   `ical`). Si el evento desaparece allá (cancelaron), el bloqueo se quita aquí.
 * - **Exportar**: cada unidad publica su propio `.ics` con las noches ocupadas por estancias y
 *   bloqueos manuales, para pegarlo en Airbnb/Booking. No exporta lo importado: devolverle a
 *   Airbnb sus propias reservas crearía un eco infinito entre plataformas. Tampoco lleva datos
 *   del huésped: solo «Reservado».
 *
 * El parser es deliberadamente pequeño: solo lee VEVENT con DTSTART/DTEND/UID/SUMMARY, que es
 * todo lo que publican estas plataformas para disponibilidad.
 */
const Models = require('../../../app_core/models/conection');
const { Op } = Models.Sequelize;
const T = require('./tarifas');

const LIMITE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** Deshace el plegado de líneas de RFC 5545 (una línea que sigue empieza con espacio o tab). */
function desplegar(texto) {
    return String(texto || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

/** `20261010` o `20261010T150000Z` → `2026-10-10`. Solo la fecha: las noches no tienen hora. */
function fechaIcal(valor) {
    const m = String(valor || '').match(/(\d{4})(\d{2})(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Eventos de un iCal: `[{ uid, desde, hasta, resumen }]`, con `hasta` exclusivo (la mañana de
 * salida), igual que una estancia. Un evento de un solo día sin DTEND ocupa esa noche.
 */
function parsear(texto) {
    const lineas = desplegar(texto).split('\n');
    const eventos = [];
    let actual = null;
    for (const linea of lineas) {
        if (linea.startsWith('BEGIN:VEVENT')) { actual = {}; continue; }
        if (linea.startsWith('END:VEVENT')) {
            if (actual?.desde) {
                const hasta = actual.hasta && actual.hasta > actual.desde ? actual.hasta : T.sumarDias(actual.desde, 1);
                eventos.push({
                    uid: (actual.uid || `${actual.desde}-${hasta}`).slice(0, 255),
                    desde: actual.desde,
                    hasta,
                    resumen: (actual.resumen || '').slice(0, 200),
                });
            }
            actual = null;
            continue;
        }
        if (!actual) continue;
        const i = linea.indexOf(':');
        if (i < 0) continue;
        const clave = linea.slice(0, i).split(';')[0].toUpperCase();
        const valor = linea.slice(i + 1).trim();
        if (clave === 'DTSTART') actual.desde = fechaIcal(valor);
        else if (clave === 'DTEND') actual.hasta = fechaIcal(valor);
        else if (clave === 'UID') actual.uid = valor;
        else if (clave === 'SUMMARY') actual.resumen = valor.replace(/\\,/g, ',').replace(/\\n/gi, ' ');
    }
    return eventos;
}

async function descargar(url) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, { signal: control.signal, headers: { 'User-Agent': 'EscalApp-Reservas/1.0' } });
        if (!r.ok) throw new Error(`El calendario respondió ${r.status}`);
        const texto = await r.text();
        if (texto.length > LIMITE_BYTES) throw new Error('El calendario es demasiado grande.');
        if (!texto.includes('BEGIN:VCALENDAR')) throw new Error('La dirección no devuelve un calendario iCal.');
        return texto;
    } finally {
        clearTimeout(reloj);
    }
}

/**
 * Sincroniza un calendario: crea los bloqueos de los eventos nuevos, actualiza los que movieron
 * sus fechas y quita los de eventos que ya no están. Solo mira desde hoy: el pasado no se toca.
 */
async function sincronizarCalendario(calendario, { texto = null } = {}) {
    try {
        const ics = texto ?? (await descargar(calendario.url_ical));
        const hoy = new Date().toISOString().slice(0, 10);
        const eventos = parsear(ics).filter((e) => e.hasta > hoy);
        const resultado = await Models.sequelize.transaction(async (t) => {
            const existentes = await Models.ReservaBloqueoUnidad.findAll({
                where: { id_calendario: calendario.id_calendario }, transaction: t,
            });
            const porUid = new Map(existentes.map((b) => [b.uid_externo, b]));
            const vistos = new Set();
            let creados = 0;
            let actualizados = 0;
            for (const e of eventos) {
                vistos.add(e.uid);
                const previo = porUid.get(e.uid);
                if (!previo) {
                    await Models.ReservaBloqueoUnidad.create({
                        id_negocio: calendario.id_negocio, id_unidad: calendario.id_unidad,
                        fecha_desde: e.desde, fecha_hasta: e.hasta,
                        motivo: `${calendario.nombre}${e.resumen ? `: ${e.resumen}` : ''}`.slice(0, 255),
                        origen: 'ical', id_calendario: calendario.id_calendario, uid_externo: e.uid,
                    }, { transaction: t });
                    creados += 1;
                } else if (previo.fecha_desde !== e.desde || previo.fecha_hasta !== e.hasta) {
                    await previo.update({ fecha_desde: e.desde, fecha_hasta: e.hasta }, { transaction: t });
                    actualizados += 1;
                }
            }
            const sobrantes = existentes.filter((b) => !vistos.has(b.uid_externo) && b.fecha_hasta > hoy);
            for (const b of sobrantes) await b.destroy({ transaction: t });
            await Models.ReservaCalendarioExterno.update(
                { ultima_sincronizacion: new Date(), ultimo_error: null },
                { where: { id_calendario: calendario.id_calendario }, transaction: t },
            );
            return { creados, actualizados, eliminados: sobrantes.length, eventos: eventos.length };
        });

        // Un bloqueo recién importado que pisa una estancia de aquí es una sobreventa real:
        // se avisa en el calendario para que el negocio la resuelva hoy, no el día de llegada.
        const choques = await choquesDe(calendario);
        if (choques.length) {
            await Models.ReservaCalendarioExterno.update(
                { ultimo_error: `Choca con ${choques.length} estancia(s) de aquí: ${choques.map((c) => `#${c}`).join(', ')}` },
                { where: { id_calendario: calendario.id_calendario } },
            );
        }
        return { ...resultado, choques };
    } catch (err) {
        await Models.ReservaCalendarioExterno.update(
            { ultimo_error: String(err.message || err).slice(0, 500), ultima_sincronizacion: new Date() },
            { where: { id_calendario: calendario.id_calendario } },
        );
        return { error: err.message };
    }
}

async function choquesDe(calendario) {
    const bloqueos = await Models.ReservaBloqueoUnidad.findAll({
        where: { id_calendario: calendario.id_calendario }, attributes: ['fecha_desde', 'fecha_hasta'], raw: true,
    });
    if (!bloqueos.length) return [];
    const estancias = await Models.ReservaEstancia.findAll({
        where: {
            id_unidad: calendario.id_unidad, estado: ['pendiente', 'confirmada', 'en_curso'],
            [Op.or]: bloqueos.map((b) => ({ fecha_entrada: { [Op.lt]: b.fecha_hasta }, fecha_salida: { [Op.gt]: b.fecha_desde } })),
        },
        attributes: ['id_estancia'], raw: true,
    });
    return estancias.map((e) => e.id_estancia);
}

async function sincronizarNegocio(idNegocio, idUnidad = null) {
    const where = { id_negocio: idNegocio, estado: 'A' };
    if (idUnidad) where.id_unidad = idUnidad;
    const calendarios = await Models.ReservaCalendarioExterno.findAll({ where });
    const salida = [];
    for (const c of calendarios) salida.push({ id_calendario: c.id_calendario, nombre: c.nombre, ...(await sincronizarCalendario(c)) });
    return salida;
}

async function sincronizarTodos() {
    const calendarios = await Models.ReservaCalendarioExterno.findAll({ where: { estado: 'A' } });
    for (const c of calendarios) {
        const r = await sincronizarCalendario(c);
        if (r.error) console.warn(`[Reserva/iCal] calendario ${c.id_calendario} (${c.nombre}): ${r.error}`);
    }
    return calendarios.length;
}

function escapar(texto) {
    return String(texto || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function plegar(linea) {
    const partes = [];
    let resto = linea;
    while (resto.length > 74) { partes.push(resto.slice(0, 74)); resto = ` ${resto.slice(74)}`; }
    partes.push(resto);
    return partes.join('\r\n');
}

/**
 * El `.ics` de una unidad, por su token secreto. Estancias vivas y bloqueos manuales desde hace
 * un mes; sin datos del huésped.
 */
async function exportar(token) {
    const unidad = await Models.ReservaUnidad.findOne({
        where: { ical_token: token, estado: 'A' },
        include: [{ model: Models.GenerNegocio, as: 'negocio', attributes: ['nombre'], required: false }],
    });
    if (!unidad) return null;
    const desde = T.sumarDias(new Date().toISOString().slice(0, 10), -30);
    const [estancias, bloqueos] = await Promise.all([
        Models.ReservaEstancia.findAll({
            where: { id_unidad: unidad.id_unidad, estado: ['pendiente', 'confirmada', 'en_curso'], fecha_salida: { [Op.gt]: desde } },
            attributes: ['id_estancia', 'fecha_entrada', 'fecha_salida', 'fecha_actualizacion'], raw: true,
        }),
        Models.ReservaBloqueoUnidad.findAll({
            where: { id_unidad: unidad.id_unidad, origen: 'manual', fecha_hasta: { [Op.gt]: desde } },
            attributes: ['id_bloqueo', 'fecha_desde', 'fecha_hasta', 'motivo'], raw: true,
        }),
    ]);
    const sello = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const d = (f) => String(f).replace(/-/g, '');
    const lineas = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EscalApp//Reservas//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        `X-WR-CALNAME:${escapar(unidad.nombre)}`,
    ];
    for (const e of estancias) {
        lineas.push('BEGIN:VEVENT', `UID:estancia-${e.id_estancia}@escalapp`, `DTSTAMP:${sello}`,
            `DTSTART;VALUE=DATE:${d(e.fecha_entrada)}`, `DTEND;VALUE=DATE:${d(e.fecha_salida)}`,
            'SUMMARY:Reservado', 'END:VEVENT');
    }
    for (const b of bloqueos) {
        lineas.push('BEGIN:VEVENT', `UID:bloqueo-${b.id_bloqueo}@escalapp`, `DTSTAMP:${sello}`,
            `DTSTART;VALUE=DATE:${d(b.fecha_desde)}`, `DTEND;VALUE=DATE:${d(b.fecha_hasta)}`,
            'SUMMARY:No disponible', 'END:VEVENT');
    }
    lineas.push('END:VCALENDAR');
    return { nombre: unidad.nombre, ics: lineas.map(plegar).join('\r\n') + '\r\n' };
}

let iniciado = false;
/** Programa la importación cada 15 minutos (`RESERVA_ICAL_CRON`). Apagable con `RESERVA_ICAL_ENABLED=false`. */
function iniciar() {
    if (iniciado || process.env.RESERVA_ICAL_ENABLED === 'false') return;
    iniciado = true;
    const cron = require('node-cron');
    const expresion = process.env.RESERVA_ICAL_CRON || '*/15 * * * *';
    console.log(`📆 Sincronización iCal de estancias programada: "${expresion}"`);
    cron.schedule(expresion, () => {
        sincronizarTodos().catch((err) => console.error('[Reserva/iCal] sincronización:', err.message));
    }, { timezone: process.env.APP_TIMEZONE || 'America/Bogota' });
}

module.exports = { parsear, sincronizarCalendario, sincronizarNegocio, sincronizarTodos, exportar, iniciar };
