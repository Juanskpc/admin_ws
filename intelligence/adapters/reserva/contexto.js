/**
 * El horario de atención de un negocio de `reserva`, para el prefijo del prompt.
 *
 * ## La pregunta que el asistente no sabía contestar
 *
 * «¿A qué hora abren?», «¿abren el domingo?», «¿dónde quedan?». Son las tres cosas que más se
 * preguntan por WhatsApp a un negocio, y hasta hoy `contextoNegocio.leerAtencion()` devolvía
 * `null` siempre: la pregunta subía al modelo —que cuesta— y el modelo no tenía el dato, así que
 * contestaba que no lo sabía. El peor cruce posible: **se paga y además se falla**.
 *
 * ## Por qué vive aquí y no en el núcleo
 *
 * Porque `reserva_horario` es el esquema de una vertical, y el acoplamiento con el esquema de una
 * vertical vive en su adaptador ([ADR-005](../../../docs/adr/ADR-005-independencia-verticales.md),
 * [ADR-009](../../../docs/adr/ADR-009-capability-adapter.md)). El núcleo solo pone la costura
 * (`core/contextoNegocio.registrarProveedor`).
 *
 * Y **no es una capacidad**: [ADR-020](../../../docs/adr/ADR-020-knowledge.md) clasifica el
 * horario como *Business Context* —configuración del inquilino, pequeña, estable, parte del
 * prefijo cacheable—, no como un dato que se consulta por turno. Una capacidad para componer una
 * frase sería un viaje al Gate por nada, y además rompería la caché de prefijo que hace que esto
 * salga casi gratis.
 *
 * ## Las filas que se leen, y por qué ésas
 *
 * `reserva_horario` con `id_profesional IS NULL` es el horario **del negocio**; con un profesional,
 * el de esa persona. No es lo mismo y confundirlos diría una hora que nadie prometió: un barbero
 * que entra a las 15:00 no significa que el local abra a las 15:00. `vitrinaService.horarioEfectivo`
 * ya los usa con esa misma distinción para la página pública, y conviene que digan lo mismo — si
 * la web dice una hora y el bot otra, el cliente cree a ninguno de los dos.
 */
'use strict';

const Models = require('../../../app_core/models/conection');

const SELECT = { type: Models.sequelize.QueryTypes.SELECT };
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** `09:00:00` → `09:00`. Los segundos no los dice nadie. */
function hhmm(valor) {
    const m = /^(\d{2}):(\d{2})/.exec(String(valor ?? ''));
    return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * El horario del negocio por día de la semana.
 *
 * @returns {Promise<{atencion: {desde,hasta}|null, horario: Array|null}>}
 *   `horario` es la semana entera, para que el prompt pueda contestar «¿abren el domingo?».
 *   `atencion` es la horquilla del día de hoy, que es lo que el handoff usa para decir *cuándo*
 *   habrá alguien en vez de prometer un «en un momento» que a las once de la noche no cumple nadie.
 */
async function leerHorario(idNegocio, ahora = new Date()) {
    const filas = await Models.sequelize.query(
        `SELECT dia_semana, hora_inicio, hora_fin
           FROM reserva.reserva_horario
          WHERE id_negocio = :id AND id_profesional IS NULL
          ORDER BY dia_semana, hora_inicio;`,
        { replacements: { id: Number(idNegocio) }, ...SELECT }
    );
    if (filas.length === 0) return { atencion: null, horario: null };

    const porDia = new Map();
    for (const f of filas) {
        const dia = Number(f.dia_semana);
        if (!porDia.has(dia)) porDia.set(dia, []);
        const desde = hhmm(f.hora_inicio);
        const hasta = hhmm(f.hora_fin);
        if (desde && hasta) porDia.get(dia).push({ desde, hasta });
    }

    const horario = [...Array(7).keys()].map((dia) => ({
        dia,
        nombre: DIAS[dia],
        franjas: porDia.get(dia) || [],
        abierto: (porDia.get(dia) || []).length > 0,
    }));

    // El día de HOY en hora de pared de Bogotá, que es la de toda la plataforma. Calcularlo con
    // `getDay()` del proceso daría el día del servidor, que no tiene por qué ser el del negocio.
    const hoyISO = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(ahora);
    const [a, m, d] = hoyISO.split('-').map(Number);
    const franjasDeHoy = horario[new Date(Date.UTC(a, m - 1, d)).getUTCDay()].franjas;

    return {
        horario,
        atencion: franjasDeHoy.length
            ? { desde: franjasDeHoy[0].desde, hasta: franjasDeHoy[franjasDeHoy.length - 1].hasta }
            : null,
    };
}

/**
 * Se engancha a la costura del núcleo. Lo llama la composición, nunca el núcleo.
 *
 * Solo contesta por los negocios de **esta** vertical: un restaurante no tiene `reserva_horario` y
 * preguntarlo por él sería una consulta inútil en cada turno de cada conversación.
 */
function registrar({ contextoNegocio, tipos }) {
    const mios = new Set(tipos.map((t) => String(t).toUpperCase()));
    contextoNegocio.registrarProveedor(async (idNegocio, fila) => {
        const tipo = String(fila?.tipo_negocio || '').toUpperCase();
        if (!mios.has(tipo)) return null;
        return leerHorario(idNegocio);
    });
}

module.exports = { registrar, leerHorario };
