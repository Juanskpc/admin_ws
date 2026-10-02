/**
 * La cuota mensual de mensajes de WhatsApp — saber dónde estamos **antes** de la factura.
 *
 * ## Lo que cambió el 1 de octubre de 2026
 *
 * Desde noviembre de 2024 las *service conversations* eran gratis: el asistente podía contestar
 * veinte mensajes para agendar una cita y no costaba nada. Por eso `docs/canal-whatsapp.md` dice
 * «agendó dos citas reales y no costó un centavo», y era verdad.
 *
 * Ya no. Meta cobra los **service messages por mensaje entregado**, con una asignación de
 * `ASIGNACION_MENSUAL` gratis **por número de teléfono y por mes**, que no se acumula. Las
 * plantillas (*utility*: nuestro `recordatorio_cita`) se cobran aparte y **no** consumen esa
 * asignación.
 *
 * O sea que a partir de ahora cada mensaje que el asistente manda de más tiene precio, y el
 * precio lo paga el inquilino. Eso convierte «cuántos mensajes gasta una conversación» en una
 * métrica de producto, no en una curiosidad.
 *
 * ## Por qué se cuenta de `intelligence.mensaje` y no de una tabla nueva
 *
 * Porque el dato ya está ahí y es el bueno: cada saliente es una fila con su negocio, su canal y
 * su estado de entrega. Un contador propio sería una segunda verdad sobre lo mismo, y la primera
 * vez que divergieran —un reintento, un acuse tardío— no habría forma de saber cuál mentía. Es el
 * mismo criterio con el que el aviso de escalado reutiliza la campanita en vez de inventarse un
 * contador (`avisos/escalado.js`).
 *
 * ## Las tres cosas que NO se cuentan, y por qué
 *
 *   - **Los entrantes.** Meta cobra lo que entrega el negocio; lo que escribe el cliente es gratis.
 *   - **Los ecos del dueño** (`crudo->>'origen' = 'app_negocio'`). Con la coexistencia, lo que el
 *     dueño escribe desde su móvil entra al Ledger como saliente para que la Bandeja enseñe la
 *     conversación completa, pero no salió por la Cloud API y nadie nos lo factura. Contarlo haría
 *     que el negocio más atento pareciera el más caro.
 *   - **Lo que no se entregó.** `estado_entrega` es la mejor aproximación que tenemos a lo que Meta
 *     factura: un `fallido` no se cobra, y un `pendiente` todavía no ha salido.
 *
 * La cuenta es una aproximación honesta, no la factura. Sirve para lo que tiene que servir: ver si
 * un número va camino de pasarse **con tiempo para hacer algo**.
 */
'use strict';

const Models = require('../../../app_core/models/conection');
const numeros = require('./numeros');
const { numeroDeEntorno } = require('../../engine/cola');

const SELECT = { type: Models.sequelize.QueryTypes.SELECT };
const CANAL = 'whatsapp';

/**
 * Mensajes de servicio gratis por número y por mes. Es el número de Meta, no una decisión nuestra:
 * cambiarlo es seguir a Meta, y por eso está aquí y no repartido por el código.
 */
const ASIGNACION_MENSUAL = numeroDeEntorno('WHATSAPP_ASIGNACION_MENSUAL', 1000);

const CONFIG = {
    /**
     * A partir de qué parte de la asignación se avisa. 80 % deja margen para reaccionar —apretar
     * el flujo, hablar con el inquilino— en vez de enterarse cuando ya se está pagando.
     */
    umbralAviso: Number(process.env.WHATSAPP_CUOTA_UMBRAL || 0.8),
    /** Cada cuánto se revisa. Una vez al día basta: la asignación es mensual. */
    horasEntreRevisiones: numeroDeEntorno('WHATSAPP_CUOTA_HORAS', 24),
};

/**
 * Lo gastado este mes por cada negocio con número de WhatsApp.
 *
 * El mes es el **natural en hora de Bogotá**, que es la hora de pared de toda la plataforma. Meta
 * cuenta en UTC, así que los dos últimos días del mes la cuenta puede bailar unas horas; para
 * decidir si un número va camino de pasarse, da igual.
 *
 * @param {Object} [opciones]
 * @param {Date}   [opciones.ahora]
 * @returns {Promise<Array<{id_negocio, negocio, servicio, plantilla, asignacion, restantes, porcentaje}>>}
 */
async function consumoDelMes({ ahora = new Date() } = {}) {
    const mes = primerDiaDelMes(ahora);

    const filas = await Models.sequelize.query(
        `
        SELECT n.id_negocio,
               g.nombre                                               AS negocio,
               count(*) FILTER (WHERE m.plantilla IS NULL)::int        AS servicio,
               count(*) FILTER (WHERE m.plantilla IS NOT NULL)::int    AS plantilla
          FROM platform.numero_canal n
          JOIN general.gener_negocio g ON g.id_negocio = n.id_negocio
          LEFT JOIN intelligence.mensaje m
                 ON m.id_negocio = n.id_negocio
                AND m.canal = :canal
                AND m.direccion = 'saliente'
                AND m.estado_entrega = 'entregado'
                AND m.creado_en >= CAST(:desde AS timestamptz)
                -- Lo que el dueño escribió desde su propio móvil no lo factura nadie.
                AND COALESCE(m.crudo->>'origen', '') <> 'app_negocio'
         WHERE n.canal = :canal AND n.estado = 'A'
         GROUP BY n.id_negocio, g.nombre
         ORDER BY 3 DESC;
        `,
        { replacements: { canal: CANAL, desde: mes }, ...SELECT }
    );

    return filas.map((f) => ({
        id_negocio: Number(f.id_negocio),
        negocio: f.negocio,
        servicio: Number(f.servicio || 0),
        plantilla: Number(f.plantilla || 0),
        asignacion: ASIGNACION_MENSUAL,
        restantes: Math.max(0, ASIGNACION_MENSUAL - Number(f.servicio || 0)),
        porcentaje: ASIGNACION_MENSUAL > 0 ? Number(f.servicio || 0) / ASIGNACION_MENSUAL : 0,
    }));
}

/** Lo mismo para un solo negocio. `null` si no tiene número activo. */
async function consumoDe(idNegocio, opciones = {}) {
    const todos = await consumoDelMes(opciones);
    return todos.find((c) => c.id_negocio === Number(idNegocio)) ?? null;
}

/**
 * Cuántos mensajes salientes gasta de media una conversación que acabó en cita.
 *
 * Es **la** métrica para decidir si el flujo está apretado o no: la asignación partida por esto es
 * cuántas citas al mes entran gratis. Se mide sobre lo que de verdad pasó, no sobre lo que el
 * código parece hacer, porque los caminos malos —horas que se ocupan, clientes que se vuelven
 * atrás— son justo los que más mensajes gastan y los que nadie cuenta a mano.
 */
async function mensajesPorCita({ idNegocio = null, dias = 30 } = {}) {
    const [fila] = await Models.sequelize.query(
        `
        WITH citas AS (
            SELECT p.id_turno, t.id_conversacion
              FROM intelligence.paso p
              JOIN intelligence.turno t ON t.id_turno = p.id_turno
             WHERE p.decision = 'cita_creada'
               AND p.creado_en > now() - (:dias || ' days')::interval
               AND (:idNegocio::int IS NULL OR p.id_negocio = :idNegocio)
        ),
        salientes AS (
            SELECT c.id_conversacion, count(*)::int AS cuantos
              FROM citas c
              JOIN intelligence.mensaje m ON m.id_conversacion = c.id_conversacion
             WHERE m.direccion = 'saliente'
               AND m.creado_en > now() - (:dias || ' days')::interval
               AND COALESCE(m.crudo->>'origen', '') <> 'app_negocio'
             GROUP BY c.id_conversacion
        )
        SELECT count(*)::int AS conversaciones,
               COALESCE(round(avg(cuantos), 1), 0)::float AS promedio,
               COALESCE(max(cuantos), 0)::int AS peor
          FROM salientes;
        `,
        { replacements: { dias: String(dias), idNegocio: idNegocio === null ? null : Number(idNegocio) }, ...SELECT }
    );
    return {
        conversaciones: Number(fila?.conversaciones || 0),
        promedio: Number(fila?.promedio || 0),
        peor: Number(fila?.peor || 0),
        /** Cuántas citas caben en la asignación a ese ritmo. `null` sin datos todavía. */
        citasGratisAlMes: Number(fila?.promedio) > 0
            ? Math.floor(ASIGNACION_MENSUAL / Number(fila.promedio))
            : null,
    };
}

/** El primer día del mes en curso, en hora de pared de Bogotá. */
function primerDiaDelMes(ahora) {
    const [anio, mes] = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit',
    }).format(ahora).split('-');
    return `${anio}-${mes}-01 00:00:00-05`;
}

module.exports = {
    ASIGNACION_MENSUAL,
    CONFIG,
    CANAL,
    consumoDelMes,
    consumoDe,
    mensajesPorCita,
    primerDiaDelMes,
    numeros,
};
