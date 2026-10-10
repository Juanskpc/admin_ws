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
 *
 * ⚠️ **Esto NO es el techo del inquilino.** Desde el 2026-10-10 el plan incluye 6.000 mensajes de
 * asistente y se amplía con paquetes (`migrate:cobranza-paquetes-mensajes`). Son dos cifras que
 * miden cosas distintas y se confunden con facilidad:
 *
 *   · `ASIGNACION_META` → lo que **Meta** no le cobra al inquilino. Es de Meta y le llega a su
 *     tarjeta (somos Tech Provider), así que decide SU factura, no la nuestra.
 *   · `contratado`      → lo que compró **con nosotros**. Decide cuándo avisamos y cuándo toca
 *     ofrecer un paquete, porque es lo que paga nuestro costo de IA.
 *
 * El aviso mira el segundo. El primero se sigue calculando porque es lo que hay que **decirle**
 * al inquilino: enterarse por la factura de Meta es la peor forma de enterarse.
 */
const ASIGNACION_META = numeroDeEntorno('WHATSAPP_ASIGNACION_MENSUAL', 1000);

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

    // El techo de cada negocio: lo que incluye su plan más los paquetes que haya contratado.
    // Se consulta por separado y no en el JOIN de arriba porque sale de `cobranza`, y este
    // módulo cuenta mensajes — que el techo venga de la facturación es una costura, no un dato
    // del canal.
    const contratados = await contratadoPorNegocio(filas.map((f) => Number(f.id_negocio)));

    return filas.map((f) => {
        const id = Number(f.id_negocio);
        const servicio = Number(f.servicio || 0);
        // Sin fila de plan (un negocio sin plan activo) el techo es el de Meta: es lo único
        // cierto que se sabe de él, y deja el aviso del lado prudente.
        const contratado = contratados.get(id) ?? ASIGNACION_META;

        return {
            id_negocio: id,
            negocio: f.negocio,
            servicio,
            plantilla: Number(f.plantilla || 0),
            /** El techo CONTRATADO. Es contra el que se avisa. */
            asignacion: contratado,
            restantes: Math.max(0, contratado - servicio),
            porcentaje: contratado > 0 ? servicio / contratado : 0,
            /** Lo que Meta no le cobra. Para decírselo, no para avisar. */
            asignacion_meta: ASIGNACION_META,
            /** Cuántos le va a facturar Meta este mes, si la cuenta sigue así. */
            facturables_meta: Math.max(0, servicio - ASIGNACION_META),
        };
    });
}

/**
 * El techo contratado de cada negocio: lo que incluye su plan más sus paquetes.
 *
 * Un negocio sin plan activo no sale en el mapa y quien llama cae al techo de Meta.
 */
async function contratadoPorNegocio(idNegocios) {
    const ids = [...new Set((idNegocios || []).map(Number).filter(Number.isInteger))];
    if (ids.length === 0) return new Map();

    const filas = await Models.sequelize.query(
        `
        SELECT n.id_negocio,
               COALESCE(p.mensajes_incluidos, 0)
             + COALESCE((
                 SELECT SUM(sc.cantidad * c.amplia_cantidad)::int
                   FROM cobranza.cob_suscripcion_complemento sc
                   JOIN cobranza.cob_complemento c ON c.id_complemento = sc.id_complemento
                  WHERE sc.id_negocio = n.id_negocio AND sc.estado = 'A' AND c.amplia = 'mensajes'
               ), 0) AS techo
          FROM general.gener_negocio n
          JOIN general.gener_negocio_plan np ON np.id_negocio = n.id_negocio AND np.estado = 'A'
           AND (np.fecha_fin IS NULL OR np.fecha_fin >= CURRENT_DATE)
          JOIN general.gener_plan p ON p.id_plan = np.id_plan
         WHERE n.id_negocio IN (:ids);
        `,
        { replacements: { ids }, ...SELECT }
    );

    const mapa = new Map();
    for (const f of filas) {
        const techo = Number(f.techo || 0);
        // Un plan sin asistente da techo 0; ahí no hay nada que avisar y se deja fuera para que
        // quien llama use el de Meta en vez de dividir por cero.
        if (techo > 0) mapa.set(Number(f.id_negocio), techo);
    }
    return mapa;
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
        /**
         * Cuántas citas entran a ese ritmo **sin que Meta cobre nada**. Va contra la asignación
         * de Meta y no contra el techo contratado a propósito: la pregunta que contesta es «a
         * partir de cuántas citas empieza a pagar», y eso lo decide Meta. `null` sin datos.
         */
        citasGratisAlMes: Number(fila?.promedio) > 0
            ? Math.floor(ASIGNACION_META / Number(fila.promedio))
            : null,
    };
}

/* ── El freno: qué pasa cuando un negocio agota su cupo ─────────────────────────────────────
 *
 * Decisión del dueño (2026-10-10). Se evaluaron dos formas y se descartó la primera:
 *
 *   ✗ **Pausar el asistente.** `asistente_pausado` deja el mensaje SIN turno (`motor.js`), o sea
 *     silencio absoluto: el cliente le escribe al restaurante y no le contesta nadie. Medido
 *     contra el cliente real, pasarse 1.000 mensajes nos cuesta $940 y pausar dos días le cuesta
 *     a él ~$900.000 en pedidos. La cura salía mil veces más cara que la enfermedad.
 *   ✓ **Degradar.** El asistente deja de conversar pero NO se calla: contesta una vez con el
 *     mensaje de handoff de siempre y pasa la conversación a una persona. El costo por
 *     conversación cae de ~8,6 mensajes a 1 (−88 %) y nadie se queda sin respuesta.
 *
 * Que baste UNA respuesta no es casualidad: al escalar, la conversación sale de
 * `ESTADOS_PROCESABLES` y el motor ya no le abre turno. Los mensajes siguientes de esa persona
 * se guardan y se ven en la Bandeja, sin costar nada. Si el freno contestara a cada mensaje,
 * generaría justo el gasto que existe para evitar.
 */

/**
 * Cuánto se recuerda el cupo de un negocio antes de volver a contarlo.
 *
 * Esto se consulta **en cada mensaje entrante**, así que sin caché serían dos consultas por
 * mensaje sobre una tabla particionada. Un minuto de desfase no cambia ninguna decisión: el
 * contador se mueve de uno en uno y el freno salta en el mensaje siguiente.
 */
const CUPO_TTL_MS = numeroDeEntorno('WHATSAPP_CUPO_TTL_MS', 60 * 1000);

/** idNegocio → { hasta: epoch, agotado, usados, techo } */
const cacheCupo = new Map();

/**
 * ¿Este negocio ya gastó lo que tiene contratado este mes?
 *
 * Devuelve siempre un objeto; `agotado: false` es la respuesta por defecto y la que se da ante
 * cualquier duda. **Fallar abierto es deliberado**: si la consulta revienta, el asistente sigue
 * atendiendo. El costo de un mes caro es dinero; el de frenar a un negocio que estaba al día es
 * un cliente que no entiende por qué su asistente dejó de trabajar.
 *
 * Un negocio sin techo contratado (plan sin asistente, o sin plan) no se frena aquí: si no
 * debería estar usando el asistente, eso lo decide la feature del plan, no un contador.
 */
async function cupoDelNegocio(idNegocio, { ahora = Date.now() } = {}) {
    const id = Number(idNegocio);
    if (!Number.isInteger(id)) return { agotado: false, usados: 0, techo: null };

    const guardado = cacheCupo.get(id);
    if (guardado && guardado.hasta > ahora) return guardado;

    try {
        const techos = await contratadoPorNegocio([id]);
        const techo = techos.get(id) ?? null;
        if (techo === null) {
            const sinTecho = { hasta: ahora + CUPO_TTL_MS, agotado: false, usados: 0, techo: null };
            cacheCupo.set(id, sinTecho);
            return sinTecho;
        }

        const [fila] = await Models.sequelize.query(
            `
            SELECT count(*)::int AS usados
              FROM intelligence.mensaje m
             WHERE m.id_negocio = :idNegocio
               AND m.canal = :canal
               AND m.direccion = 'saliente'
               AND m.estado_entrega = 'entregado'
               AND m.plantilla IS NULL
               AND COALESCE(m.crudo->>'origen', '') <> 'app_negocio'
               AND m.creado_en >= CAST(:desde AS timestamptz);
            `,
            { replacements: { idNegocio: id, canal: CANAL, desde: primerDiaDelMes(new Date(ahora)) }, ...SELECT }
        );

        const usados = Number(fila?.usados || 0);
        const estado = { hasta: ahora + CUPO_TTL_MS, agotado: usados >= techo, usados, techo };
        cacheCupo.set(id, estado);
        return estado;
    } catch (err) {
        // Ver arriba: ante la duda, se atiende.
        console.error('[cuota] no se pudo calcular el cupo, se deja pasar:', err.message);
        return { agotado: false, usados: 0, techo: null };
    }
}

/** Para los tests y para el momento en que alguien compra un paquete: el techo acaba de cambiar. */
function olvidarCupo(idNegocio = null) {
    if (idNegocio === null) cacheCupo.clear();
    else cacheCupo.delete(Number(idNegocio));
}

/** El primer día del mes en curso, en hora de pared de Bogotá. */
function primerDiaDelMes(ahora) {
    const [anio, mes] = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit',
    }).format(ahora).split('-');
    return `${anio}-${mes}-01 00:00:00-05`;
}

module.exports = {
    ASIGNACION_META,
    /** Alias histórico. Lo usaban el script y el aviso cuando sólo existía el techo de Meta. */
    ASIGNACION_MENSUAL: ASIGNACION_META,
    contratadoPorNegocio,
    cupoDelNegocio,
    olvidarCupo,
    CUPO_TTL_MS,
    CONFIG,
    CANAL,
    consumoDelMes,
    consumoDe,
    mensajesPorCita,
    primerDiaDelMes,
    numeros,
};
