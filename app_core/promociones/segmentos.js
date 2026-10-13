/**
 * Los segmentos de clientes (F1 de `docs/promociones-masivas.md`).
 *
 * ## El caso de uso que esto resuelve, con las palabras del dueño
 *
 * > «Quiero sacar una promoción de 2 hamburguesas por $20.000, será para todos. Pero como tengo
 * > clientes activos, a estos no necesito enviarles mensaje, sino a los clientes no frecuentes
 * > para recuperar esta clientela.»
 *
 * O sea: lo que vale no es poder mandar a todos, es **poder NO mandarle al que ya viene**. Cada
 * mensaje que se le ahorra al cliente frecuente es plata que no se gasta y una promoción que no
 * malacostumbra a quien iba a volver de todas formas.
 *
 * ## Las reglas, y por qué son excluyentes
 *
 * El documento llevaba una tabla con rangos que se solapaban («frecuente: ≥4 y ≤30 días» junto a
 * «en riesgo: 45–120 días»): sirve para explicar la idea, no para contar gente. Una persona tiene
 * que caer en **un solo** segmento o los conteos no suman y el dueño no puede confiar en el total.
 *
 * Así que se evalúa **por antigüedad primero** y la primera regla que casa gana:
 *
 * | Orden | Segmento | Regla | Para qué |
 * |---|---|---|---|
 * | 1 | `sin_actividad` | sin ningún evento | ficha abierta a mano (tiquetera, fiado) que nunca pidió |
 * | 2 | `dormido` | última visita hace más de 120 días | último intento, y el más barato |
 * | 3 | `en_riesgo` | entre 46 y 120 días | **el de más valor**: todavía se acuerda del negocio |
 * | 4 | `frecuente` | ≤ 45 días y 4+ visitas | **los que NO necesitan promoción** |
 * | 5 | `intermedio` | ≤ 45 días y 2–3 visitas | subir frecuencia |
 * | 6 | `ocasional` | ≤ 45 días y 1 visita | que vuelva una segunda vez |
 *
 * El corte en 45 días no es sagrado y por eso está en `UMBRALES`: es el punto en el que un cliente
 * de restaurante de barrio deja de ser «de la casa». Cuando haya datos de una campaña real se
 * mueve con números en la mano, no antes.
 *
 * `alto_valor` va **aparte y como bandera**, no como segmento: un cliente puede ser a la vez el que
 * más gasta y el que no viene desde hace tres meses, y meterlo en un cajón distinto escondería
 * justo al que más urge recuperar. Es el top 20 % por dinero dentro del negocio.
 *
 * ## Una sola consulta, y por qué
 *
 * Todo —los hechos del vertical, el estado de baja, la conversación bloqueada y el segmento— sale
 * de un `SELECT`. Un negocio con 800 clientes tiene que poder abrir esta pantalla en un servidor
 * de un núcleo, y la alternativa (una consulta por cliente, o unir listas en memoria) es la misma
 * que ya se descartó en `cuentaService.listarCuentas` por el mismo motivo.
 */
'use strict';

const Models = require('../models/conection');
const hechos = require('./hechos');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };

/** Los cortes. En un solo sitio para que moverlos sea una decisión y no una búsqueda. */
const UMBRALES = {
    /** Hasta aquí el cliente «está viniendo». */
    DIAS_ACTIVO: 45,
    /** Pasado esto ya no se acuerda del negocio; antes, todavía sí. */
    DIAS_DORMIDO: 120,
    /** Visitas para considerarlo frecuente. */
    VISITAS_FRECUENTE: 4,
    /** Percentil de gasto que marca `alto_valor`. */
    PERCENTIL_ALTO_VALOR: 0.8,
};

/**
 * Los segmentos, en el orden en que se enseñan y con el texto que lee el dueño.
 *
 * `recomendado_para` es lo que hace útil la pantalla: el dueño no piensa en percentiles, piensa
 * en «a quién le mando esto». La descripción se escribe para él, no para nosotros.
 */
const SEGMENTOS = [
    {
        codigo: 'en_riesgo',
        nombre: 'En riesgo',
        descripcion: 'Vinieron hace entre 1 y 4 meses. Todavía se acuerdan del negocio.',
        recomendado_para: 'Recuperar clientela. Es a quien más le rinde una promoción.',
        orden: 1,
        recomendado: true,
    },
    {
        codigo: 'dormido',
        nombre: 'Dormidos',
        descripcion: 'Hace más de 4 meses que no vienen.',
        recomendado_para: 'Último intento. Muchos ya no responden: manda primero a «En riesgo».',
        orden: 2,
        recomendado: false,
    },
    {
        codigo: 'ocasional',
        nombre: 'De una sola vez',
        descripcion: 'Vinieron una vez, hace poco.',
        recomendado_para: 'Conseguir la segunda compra, que es la que crea el hábito.',
        orden: 3,
        recomendado: true,
    },
    {
        codigo: 'intermedio',
        nombre: 'Intermedios',
        descripcion: 'Vienen de vez en cuando (2 o 3 veces), y hace poco.',
        recomendado_para: 'Subirles la frecuencia.',
        orden: 4,
        recomendado: false,
    },
    {
        codigo: 'frecuente',
        nombre: 'Frecuentes',
        descripcion: 'Vienen seguido y hace poco.',
        recomendado_para:
            'Normalmente NO hace falta escribirles: ya vuelven solos. Cada mensaje que te ahorras aquí es plata.',
        orden: 5,
        recomendado: false,
    },
    {
        codigo: 'sin_actividad',
        nombre: 'Sin pedidos',
        descripcion: 'Fichas que se abrieron a mano y que nunca han pedido.',
        recomendado_para: 'Casi nunca vale la pena: no hay nada que recuperar todavía.',
        orden: 6,
        recomendado: false,
    },
];

const CODIGOS = new Set(SEGMENTOS.map((s) => s.codigo));

/**
 * El `CASE` que asigna el segmento. Es la misma expresión para contar y para listar: tenerla dos
 * veces sería la forma más fácil de que el conteo y la lista discrepen en un borde.
 */
const CASE_SEGMENTO = `
    CASE
        WHEN h.eventos IS NULL OR h.eventos = 0            THEN 'sin_actividad'
        WHEN h.dias_desde_ultimo > ${UMBRALES.DIAS_DORMIDO} THEN 'dormido'
        WHEN h.dias_desde_ultimo > ${UMBRALES.DIAS_ACTIVO}  THEN 'en_riesgo'
        WHEN h.eventos >= ${UMBRALES.VISITAS_FRECUENTE}     THEN 'frecuente'
        WHEN h.eventos >= 2                                 THEN 'intermedio'
        ELSE 'ocasional'
    END
`;

/**
 * El cuerpo común: cada `persona_negocio` del negocio con sus hechos, su segmento y si hoy se le
 * puede escribir.
 *
 * ⚠️ `sqlHechos` es **SQL de un adaptador nuestro**, nunca de una petición: se interpola porque es
 * una constante del programa (ver `hechos/index.js`). Todo lo que viene del usuario viaja en
 * `replacements`.
 */
function cte(sqlHechos) {
    return `
        WITH h AS (
            SELECT f.id_persona_negocio,
                   f.eventos,
                   f.ultimo_evento,
                   f.valor_total,
                   -- La antigüedad se mide en días de calendario de Bogotá: las fechas del dominio
                   -- son hora de pared (CLAUDE.md), así que CURRENT_DATE es la referencia correcta.
                   (CURRENT_DATE - f.ultimo_evento::date) AS dias_desde_ultimo
              FROM (${sqlHechos}) f
        ),
        base AS (
            SELECT pn.id_persona_negocio,
                   pn.nombre_mostrado,
                   pn.telefono_e164,
                   pn.promos_excluido,
                   COALESCE(h.eventos, 0)      AS eventos,
                   h.ultimo_evento,
                   h.dias_desde_ultimo,
                   COALESCE(h.valor_total, 0)  AS valor_total,
                   ${CASE_SEGMENTO}            AS segmento,
                   EXISTS (
                       SELECT 1
                         FROM intelligence.conversacion c
                        WHERE c.id_negocio = pn.id_negocio
                          AND c.canal = 'whatsapp'
                          AND c.id_externo = ltrim(pn.telefono_e164, '+')
                          AND c.estado = 'bloqueada'
                   ) AS bloqueado
              FROM platform.persona_negocio pn
              LEFT JOIN h ON h.id_persona_negocio = pn.id_persona_negocio
             WHERE pn.id_negocio = :idNegocio
        ),
        conValor AS (
            SELECT b.*,
                   -- El top 20 % por dinero, dentro de los que han gastado algo. PERCENT_RANK
                   -- sobre el negocio entero y no un umbral fijo: «alto valor» en un restaurante de
                   -- menú del día y en una barbería de corte premium no es la misma cifra.
                   CASE
                       WHEN b.valor_total > 0
                            AND PERCENT_RANK() OVER (ORDER BY b.valor_total)
                                >= ${UMBRALES.PERCENTIL_ALTO_VALOR}
                       THEN true ELSE false
                   END AS alto_valor,
                   (b.telefono_e164 IS NOT NULL AND NOT b.promos_excluido AND NOT b.bloqueado)
                       AS contactable
              FROM base b
        )
    `;
}

/** El vertical del negocio, o un error tipado si no tiene promociones. */
async function exigirAdaptador(idNegocio) {
    const par = await hechos.paraNegocio(idNegocio);
    if (!par) {
        const error = new Error('Las promociones no están disponibles para este tipo de negocio.');
        error.code = 'PROMOS_VERTICAL_NO_SOPORTADO';
        error.statusCode = 422;
        throw error;
    }
    return par;
}

/**
 * Cuántos clientes hay en cada segmento, y cuántos de ellos se puede contactar.
 *
 * Devuelve **todos** los segmentos, incluidos los que están en cero: una pantalla en la que los
 * segmentos vacíos desaparecen no deja entender la clientela, y «no tienes dormidos» es
 * información.
 */
async function contarPorSegmento({ idNegocio } = {}) {
    const { vertical, adaptador } = await exigirAdaptador(idNegocio);

    const filas = await sequelize.query(
        `${cte(adaptador.sql)}
         SELECT segmento,
                COUNT(*)::int                                   AS personas,
                COUNT(*) FILTER (WHERE contactable)::int        AS contactables,
                COUNT(*) FILTER (WHERE alto_valor)::int         AS alto_valor,
                COALESCE(AVG(valor_total) FILTER (WHERE valor_total > 0), 0)::numeric AS ticket_medio
           FROM conValor
          GROUP BY segmento;`,
        { replacements: { idNegocio: Number(idNegocio) }, ...SELECT }
    );

    const porCodigo = new Map(filas.map((f) => [f.segmento, f]));

    return {
        vertical,
        etiqueta: adaptador.etiqueta,
        umbrales: UMBRALES,
        segmentos: SEGMENTOS.map((s) => {
            const f = porCodigo.get(s.codigo);
            return {
                ...s,
                personas: Number(f?.personas || 0),
                contactables: Number(f?.contactables || 0),
                alto_valor: Number(f?.alto_valor || 0),
                ticket_medio: Math.round(Number(f?.ticket_medio || 0)),
            };
        }),
    };
}

/**
 * Los clientes de uno o varios segmentos, para la tabla y para la selección a mano.
 *
 * `soloContactables` por defecto en `true`: la pantalla que arma una promoción no tiene por qué
 * enseñar a quien no la va a recibir. Se puede apagar para la vista de «quién quedó fuera», que es
 * donde esa lista sí significa algo.
 */
async function listarDestinatarios({
    idNegocio,
    segmentos = null,
    busqueda = null,
    soloContactables = true,
    limite = 200,
    offset = 0,
} = {}) {
    const { adaptador } = await exigirAdaptador(idNegocio);

    const pedidos = Array.isArray(segmentos) ? segmentos.filter((s) => CODIGOS.has(s)) : null;
    const condiciones = [];
    // `IN (:lista)` y no `= ANY(:lista)`: Sequelize expande un array de `replacements` como
    // lista separada por comas, así que `ANY('a','b')` sería un error de sintaxis de Postgres.
    // Es la forma que ya usa el resto del repo (`cuota.js`, `cuentaService`).
    if (pedidos && pedidos.length) condiciones.push('segmento IN (:segmentos)');
    if (soloContactables) condiciones.push('contactable');
    if (busqueda) condiciones.push('(nombre_mostrado ILIKE :busqueda OR telefono_e164 ILIKE :busqueda)');
    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    const filas = await sequelize.query(
        `${cte(adaptador.sql)}
         SELECT id_persona_negocio, nombre_mostrado, telefono_e164, eventos, ultimo_evento,
                dias_desde_ultimo, valor_total, segmento, alto_valor, contactable,
                promos_excluido, bloqueado,
                COUNT(*) OVER ()::int AS total
           FROM conValor
           ${where}
          ORDER BY dias_desde_ultimo ASC NULLS LAST, valor_total DESC
          LIMIT :limite OFFSET :offset;`,
        {
            replacements: {
                idNegocio: Number(idNegocio),
                segmentos: pedidos && pedidos.length ? pedidos : null,
                busqueda: busqueda ? `%${busqueda}%` : null,
                limite: Math.min(Number(limite) || 200, 1000),
                offset: Number(offset) || 0,
            },
            ...SELECT,
        }
    );

    return {
        total: filas.length ? Number(filas[0].total) : 0,
        destinatarios: filas.map((f) => ({
            id_persona_negocio: f.id_persona_negocio,
            cliente: f.nombre_mostrado || 'Sin nombre',
            telefono: f.telefono_e164,
            eventos: Number(f.eventos) || 0,
            ultimo_evento: f.ultimo_evento,
            dias_desde_ultimo: f.dias_desde_ultimo != null ? Number(f.dias_desde_ultimo) : null,
            valor_total: Number(f.valor_total) || 0,
            segmento: f.segmento,
            alto_valor: Boolean(f.alto_valor),
            contactable: Boolean(f.contactable),
            motivo_exclusion: !f.contactable
                ? f.promos_excluido
                    ? 'pidio_baja'
                    : f.bloqueado
                      ? 'bloqueo_whatsapp'
                      : 'sin_telefono'
                : null,
        })),
    };
}

/**
 * Los teléfonos a los que iría la promoción, agrupados por indicativo de país.
 *
 * Es lo que necesita el simulador, y la razón de que vaya agrupado es que **Meta cobra según el
 * país del destinatario**: una campaña con 300 colombianos y 20 chilenos tiene dos precios, y
 * presentar un total con una sola tarifa sería un presupuesto equivocado.
 *
 * ⚠️ Esta es la función que de verdad decide a quién se le escribe, así que **vuelve a filtrar por
 * `contactable`** aunque la pantalla ya lo haya hecho. Entre que el dueño arma la campaña y se
 * manda pueden pasar horas, y en esas horas alguien puede haberse dado de baja.
 */
async function destinatariosParaEnvio({ idNegocio, segmentos = null, personas = null } = {}) {
    const { adaptador } = await exigirAdaptador(idNegocio);

    const pedidos = Array.isArray(segmentos) ? segmentos.filter((s) => CODIGOS.has(s)) : null;
    const condiciones = ['contactable'];
    if (Array.isArray(personas) && personas.length) {
        condiciones.push('id_persona_negocio IN (:personas)');
    } else if (pedidos && pedidos.length) {
        condiciones.push('segmento IN (:segmentos)');
    } else {
        // Sin segmentos ni personas no se asume «todos»: una campaña a toda la base por omisión
        // es el error más caro que puede cometer esta pantalla.
        const error = new Error('Hay que decir a qué segmentos o a qué clientes se manda.');
        error.code = 'PROMOS_SIN_DESTINATARIOS';
        error.statusCode = 422;
        throw error;
    }

    const filas = await sequelize.query(
        `${cte(adaptador.sql)}
         SELECT id_persona_negocio, telefono_e164, segmento, valor_total
           FROM conValor
          WHERE ${condiciones.join(' AND ')};`,
        {
            replacements: {
                idNegocio: Number(idNegocio),
                segmentos: pedidos && pedidos.length ? pedidos : null,
                personas: Array.isArray(personas) && personas.length ? personas : null,
            },
            ...SELECT,
        }
    );

    return filas.map((f) => ({
        id_persona_negocio: f.id_persona_negocio,
        telefono: f.telefono_e164,
        segmento: f.segmento,
        valor_total: Number(f.valor_total) || 0,
    }));
}

module.exports = {
    UMBRALES,
    SEGMENTOS,
    CODIGOS,
    contarPorSegmento,
    listarDestinatarios,
    destinatariosParaEnvio,
};
