/**
 * Informe del asistente: cómo le fue con las conversaciones REALES de los últimos días (fase 3 del
 * diagnóstico, 2026-10-05).
 *
 * Las fases 1 y 2 miran la carta antes de empezar. Esto mira lo que pasó después, que es donde
 * aparecen los problemas que nadie previó: lo que los clientes pidieron y el asistente no encontró,
 * los chats que acabaron en una persona, los pedidos que se arman por chat pudiendo venir de la
 * carta. Es la auditoría que se hacía a mano cada noche con `scripts/auditoria_*.js`, sin leer
 * conversaciones: solo cuenta lo que el Ledger ya guarda.
 *
 * Todo es SQL de lectura sobre el esquema `intelligence`; no llama a ningún modelo. La única parte
 * «viva» es la de búsquedas: los términos que el modelo buscó se vuelven a buscar HOY contra la
 * carta, así la lista dice lo que sigue sin encontrarse (si ya se arregló, desaparece sola).
 *
 * El costo de la IA es un gasto de EscalApp, no del negocio: solo se incluye para el super admin.
 */
'use strict';

const Models = require('../../app_core/models/conection');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };
const MENU = 'App del restaurante → Menú';
const MAX_TERMINOS = 120;

const q = (sql, replacements) => sequelize.query(sql, { replacements, ...SELECT });
const uno = async (sql, replacements) => (await q(sql, replacements))[0] || {};
const n = (v) => Number(v || 0);
const pct = (parte, total) => (total > 0 ? Math.round((100 * parte) / total) : 0);

/** Decisiones del Ledger que significan «esto lo terminó atendiendo una persona». */
const A_PERSONA = {
    modelo_pide_persona: 'El asistente no supo y pidió una persona',
    promesa_de_persona_cumplida: 'El asistente no supo y pidió una persona',
    media_a_persona: 'El cliente mandó una foto, un audio o una ubicación',
    confirmacion_a_persona: 'El cliente no confirmó su pedido tras dos intentos',
    pedido_repreguntado_a_persona: 'El cliente volvió a preguntar por su pedido',
    pedido_de_persona_a_persona: 'Preguntó por un pedido que tomó una persona',
    empaque_a_persona: 'Preguntó por cajas o empaques',
};

/** Errores al tomar un pedido, dichos para quien administra el negocio. */
const ERROR_PEDIDO = {
    SIN_DOMICILIARIO_DISPONIBLE: ['No había domiciliario registrado', 'App del restaurante → Usuarios (rol Domiciliario)'],
    SIN_MESA_LIBRE: ['No había mesas libres para «servir»', 'App del restaurante → Mesas'],
    CAJA_CERRADA: ['La caja estaba cerrada', 'App del restaurante → Caja (abrirla al empezar)'],
    NEGOCIO_CERRADO: ['El local estaba cerrado', 'App del restaurante → Horario'],
    PRODUCTO_NO_DISPONIBLE: ['Un producto del pedido estaba agotado', MENU],
    STOCK_INSUFICIENTE: ['Faltaban insumos en inventario', 'App del restaurante → Inventario'],
};

/** Los números de una ventana [desde, hasta). */
async function medir(idNegocio, desde, hasta) {
    const r = { idNegocio, desde, hasta };
    const [turnos, mensajes, pedidos, costo] = await Promise.all([
        uno(
            `SELECT count(*)::int AS total, count(*) FILTER (WHERE nivel = 'llm')::int AS con_modelo
               FROM intelligence.turno
              WHERE id_negocio = :idNegocio AND creado_en >= :desde AND creado_en < :hasta;`,
            r
        ),
        uno(
            `SELECT count(*)::int AS entrantes, count(DISTINCT id_conversacion)::int AS conversaciones
               FROM intelligence.mensaje
              WHERE id_negocio = :idNegocio AND direccion = 'entrante'
                AND creado_en >= :desde AND creado_en < :hasta;`,
            r
        ),
        // Un pedido es «de la carta» si en esa conversación entró un carrito del menú digital en la
        // ventana; si no, se armó conversando. Los turnos con modelo se cuentan por conversación.
        uno(
            `WITH pedidos AS (
                 SELECT id_conversacion, count(*)::int AS pedidos
                   FROM intelligence.invocacion_capacidad
                  WHERE id_negocio = :idNegocio AND capacidad = 'tomar_pedido' AND resultado = 'ok'
                    AND NOT dry_run AND creado_en >= :desde AND creado_en < :hasta
                  GROUP BY id_conversacion),
             por_conv AS (
                 SELECT p.id_conversacion, p.pedidos,
                        EXISTS (SELECT 1 FROM intelligence.paso s
                                  JOIN intelligence.turno t ON t.id_turno = s.id_turno
                                 WHERE t.id_conversacion = p.id_conversacion
                                   AND s.decision = 'pedido_del_menu_recibido'
                                   AND s.creado_en >= :desde AND s.creado_en < :hasta) AS de_carta,
                        (SELECT count(*) FROM intelligence.turno t
                          WHERE t.id_conversacion = p.id_conversacion AND t.nivel = 'llm'
                            AND t.creado_en >= :desde AND t.creado_en < :hasta)::int AS turnos_modelo
                   FROM pedidos p)
             SELECT COALESCE(sum(pedidos), 0)::int AS total,
                    COALESCE(sum(pedidos) FILTER (WHERE de_carta), 0)::int AS de_carta,
                    COALESCE(sum(pedidos) FILTER (WHERE NOT de_carta), 0)::int AS por_chat,
                    round(avg(turnos_modelo) FILTER (WHERE de_carta), 1) AS modelo_por_pedido_carta,
                    round(avg(turnos_modelo) FILTER (WHERE NOT de_carta), 1) AS modelo_por_pedido_chat
               FROM por_conv;`,
            r
        ),
        uno(
            `SELECT COALESCE(sum(costo_usd), 0)::numeric(12,4) AS usd, count(*)::int AS llamadas
               FROM intelligence.costo
              WHERE id_negocio = :idNegocio AND creado_en >= :desde AND creado_en < :hasta;`,
            r
        ),
    ]);
    return {
        conversaciones: n(mensajes.conversaciones),
        mensajes_entrantes: n(mensajes.entrantes),
        turnos: n(turnos.total),
        turnos_con_modelo: n(turnos.con_modelo),
        pct_con_modelo: pct(n(turnos.con_modelo), n(turnos.total)),
        pedidos: {
            total: n(pedidos.total),
            de_carta: n(pedidos.de_carta),
            por_chat: n(pedidos.por_chat),
            pct_por_chat: pct(n(pedidos.por_chat), n(pedidos.total)),
            modelo_por_pedido_carta: pedidos.modelo_por_pedido_carta == null ? null : Number(pedidos.modelo_por_pedido_carta),
            modelo_por_pedido_chat: pedidos.modelo_por_pedido_chat == null ? null : Number(pedidos.modelo_por_pedido_chat),
        },
        costo: { usd: Number(costo.usd || 0), llamadas: n(costo.llamadas) },
    };
}

/**
 * ¿Esto es el nombre de algo que se pide? El modelo a veces «busca» un saludo o un número suelto
 * («bu es más noches», «1.5»): eso no es un producto que falte en la carta.
 */
function esTerminoDeProducto(termino) {
    const t = String(termino || '');
    if (t.replace(/[^a-zñáéíóú]/gi, '').length < 4) return false;
    return !/\b(noches|tardes|dias|días|hola|gracias|favor|buenas|buenos)\b/i.test(t);
}

/** Lo que el modelo buscó en la ventana, vuelto a buscar HOY: qué sigue sin encontrarse. */
async function busquedas(idNegocio, desde, hasta, buscar) {
    const terminos = await q(
        `SELECT lower(trim(argumentos->>'termino')) AS termino, count(*)::int AS veces
           FROM intelligence.invocacion_capacidad
          WHERE id_negocio = :idNegocio AND capacidad = 'buscar_producto'
            AND creado_en >= :desde AND creado_en < :hasta AND COALESCE(argumentos->>'termino', '') <> ''
          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT :limite;`,
        { idNegocio, desde, hasta, limite: MAX_TERMINOS }
    );
    const total = terminos.reduce((a, t) => a + t.veces, 0);
    if (!buscar) return { total, distintas: terminos.length, revisadas: false, sin_resultado: [], agotados: [] };

    const sinResultado = [];
    const porProducto = new Map(); // varias formas de pedirlo («dulcinea», «hamburguesa dulcinea») son UN producto
    for (const t of terminos) {
        if (!esTerminoDeProducto(t.termino)) continue;
        let r;
        try {
            r = await buscar(t.termino);
        } catch (_) {
            continue;
        }
        if ((r?.productos || []).length > 0) continue;
        const agotado = (r?.agotados_ahora || [])[0];
        if (agotado) porProducto.set(agotado, (porProducto.get(agotado) || 0) + t.veces);
        else sinResultado.push({ termino: t.termino, veces: t.veces });
    }
    const agotados = [...porProducto.entries()].map(([producto, veces]) => ({ producto, veces })).sort((a, b) => b.veces - a.veces);
    return { total, distintas: terminos.length, revisadas: true, sin_resultado: sinResultado, agotados };
}

/** Chats que terminó atendiendo una persona, por motivo. */
async function aPersona(idNegocio, desde, hasta) {
    const filas = await q(
        `SELECT s.decision, count(*)::int AS veces
           FROM intelligence.paso s
          WHERE s.id_negocio = :idNegocio AND s.creado_en >= :desde AND s.creado_en < :hasta
            AND s.decision IN (:decisiones)
          GROUP BY 1;`,
        { idNegocio, desde, hasta, decisiones: Object.keys(A_PERSONA) }
    );
    const porMotivo = new Map();
    for (const f of filas) {
        const motivo = A_PERSONA[f.decision];
        porMotivo.set(motivo, (porMotivo.get(motivo) || 0) + f.veces);
    }
    const motivos = [...porMotivo.entries()].map(([motivo, veces]) => ({ motivo, veces })).sort((a, b) => b.veces - a.veces);
    // Lo que el propio modelo dijo al pedir una persona («pregunta por empleo», «quiere factura»…).
    const dichos = await q(
        `SELECT left(trim(argumentos->>'motivo'), 120) AS motivo, count(*)::int AS veces
           FROM intelligence.invocacion_capacidad
          WHERE id_negocio = :idNegocio AND capacidad = 'pasar_a_persona'
            AND creado_en >= :desde AND creado_en < :hasta AND COALESCE(argumentos->>'motivo', '') <> ''
          GROUP BY 1 ORDER BY 2 DESC LIMIT 8;`,
        { idNegocio, desde, hasta }
    );
    const esperando = await uno(
        `SELECT count(*)::int AS n FROM intelligence.conversacion
          WHERE id_negocio = :idNegocio AND estado = 'handoff_humano' AND atendida_en IS NULL;`,
        { idNegocio }
    );
    return { total: motivos.reduce((a, m) => a + m.veces, 0), motivos, dichos_por_el_asistente: dichos, esperan_respuesta_ahora: n(esperando.n) };
}

/** Pedidos que el asistente intentó tomar y el sistema rechazó, por causa. */
async function erroresDePedido(idNegocio, desde, hasta) {
    const filas = await q(
        `SELECT COALESCE(error_codigo, 'DESCONOCIDO') AS codigo, count(*)::int AS veces
           FROM intelligence.invocacion_capacidad
          WHERE id_negocio = :idNegocio AND capacidad IN ('tomar_pedido', 'agregar_items_pedido')
            AND resultado <> 'ok' AND NOT dry_run AND creado_en >= :desde AND creado_en < :hasta
          GROUP BY 1 ORDER BY 2 DESC;`,
        { idNegocio, desde, hasta }
    );
    return filas
        .filter((f) => ERROR_PEDIDO[f.codigo])
        .map((f) => ({ codigo: f.codigo, veces: f.veces, que_paso: ERROR_PEDIDO[f.codigo][0], donde: ERROR_PEDIDO[f.codigo][1] }));
}

/** De los números a «qué hacer», en orden de impacto. Pura, para probarla sola. */
function recomendar({ actual, busq, persona, errores }) {
    const acciones = [];
    const p = actual.pedidos;

    for (const e of errores) {
        acciones.push({
            clave: `error_${e.codigo.toLowerCase()}`,
            titulo: `${e.veces} ${e.veces === 1 ? 'pedido rechazado' : 'pedidos rechazados'}: ${e.que_paso.toLowerCase()}`,
            por_que: 'El cliente ya había dicho qué quería y el asistente tuvo que decirle que no podía tomarlo.',
            donde: e.donde,
            detalles: [],
        });
    }
    if (busq.sin_resultado.length > 0) {
        const veces = busq.sin_resultado.reduce((a, t) => a + t.veces, 0);
        acciones.push({
            clave: 'busquedas_sin_resultado',
            titulo: `Tus clientes pidieron ${veces} ${veces === 1 ? 'vez' : 'veces'} algo que el asistente no encuentra en la carta`,
            por_que: 'Si lo vendes, falta en la carta o tiene otro nombre; si no lo vendes, es lo que tu clientela busca.',
            donde: MENU,
            detalles: busq.sin_resultado.slice(0, 12).map((t) => `«${t.termino}»${t.veces > 1 ? ` (${t.veces} veces)` : ''}`),
        });
    }
    if (busq.agotados.length > 0) {
        const veces = busq.agotados.reduce((a, t) => a + t.veces, 0);
        acciones.push({
            clave: 'busquedas_agotados',
            titulo: `Pidieron ${veces} ${veces === 1 ? 'vez' : 'veces'} productos que ahora mismo están marcados como no disponibles`,
            por_que: 'Mientras estén así, el asistente contesta «hoy se nos acabó». Revisa al abrir que lo que sí tienes esté marcado como disponible.',
            donde: MENU,
            detalles: busq.agotados.slice(0, 12).map((t) => `«${t.producto}»${t.veces > 1 ? ` (lo pidieron ${t.veces} veces)` : ''}`),
        });
    }
    if (p.total >= 5 && p.pct_por_chat >= 60) {
        acciones.push({
            clave: 'pedidos_por_chat',
            titulo: `${p.pct_por_chat}% de los pedidos se arman conversando, no desde la carta digital`,
            por_que:
                'Un pedido de la carta entra completo y a la primera' +
                (p.modelo_por_pedido_chat && p.modelo_por_pedido_carta != null
                    ? `; por chat el asistente necesita ${p.modelo_por_pedido_chat} mensajes de ida y vuelta por pedido, frente a ${p.modelo_por_pedido_carta} desde la carta.`
                    : '.') +
                ' Invita a tus clientes a pedir desde el enlace de la carta (en redes, en la puerta, en el empaque).',
            donde: 'Tu carta digital (el enlace que el asistente envía al saludar)',
            detalles: [],
        });
    }
    if (persona.total >= 3) {
        acciones.push({
            clave: 'chats_a_persona',
            titulo: `${persona.total} chats terminaron en una persona`,
            por_que: 'Cada uno es alguien del equipo dejando lo que hacía para contestar. Mira los motivos: varios se resuelven con un dato en la carta o en la información del asistente.',
            donde: 'Aquí, en WhatsApp → Configuración del asistente',
            detalles: [
                ...persona.motivos.slice(0, 5).map((m) => `${m.motivo}: ${m.veces}`),
                ...persona.dichos_por_el_asistente.slice(0, 5).map((d) => `El asistente anotó: «${d.motivo}»${d.veces > 1 ? ` (${d.veces})` : ''}`),
            ],
        });
    }
    if (persona.esperan_respuesta_ahora > 0) {
        acciones.push({
            clave: 'esperan_respuesta',
            titulo: `${persona.esperan_respuesta_ahora} ${persona.esperan_respuesta_ahora === 1 ? 'chat espera' : 'chats esperan'} respuesta ahora mismo`,
            por_que: 'El asistente le dijo al cliente que alguien del equipo le contestaría.',
            donde: 'Aquí, en WhatsApp → Esperan respuesta',
            detalles: [],
        });
    }
    return acciones;
}

/**
 * @param {number} idNegocio
 * @param {Object} [opciones]
 * @param {number}  [opciones.dias=7]       — tamaño de la ventana (1 a 31).
 * @param {boolean} [opciones.conCosto]     — incluir el gasto en IA (solo super admin).
 * @param {Function} [opciones.buscar]      — inyectable; por defecto la `buscar_producto` real.
 * @param {Date}    [opciones.ahora]
 */
async function informe(idNegocio, { dias = 7, conCosto = false, buscar = null, ahora = new Date() } = {}) {
    const ventana = Math.min(31, Math.max(1, Number(dias) || 7));
    const hasta = ahora;
    const desde = new Date(hasta.getTime() - ventana * 86400000);
    const antes = new Date(desde.getTime() - ventana * 86400000);

    let buscador = buscar;
    if (!buscador) {
        try {
            const capacidad = require('../../intelligence/core/registry').obtener('buscar_producto');
            if (capacidad) buscador = (termino) => capacidad.ejecutar({ idNegocio, args: { termino }, contexto: {} });
        } catch (_) {
            buscador = null;
        }
    }

    const [actual, anterior, busq, persona, errores] = await Promise.all([
        medir(idNegocio, desde, hasta),
        medir(idNegocio, antes, desde),
        busquedas(idNegocio, desde, hasta, buscador),
        aPersona(idNegocio, desde, hasta),
        erroresDePedido(idNegocio, desde, hasta),
    ]);

    const sinCosto = ({ costo: _c, ...resto }) => resto;
    const resultado = {
        dias: ventana,
        desde: desde.toISOString(),
        hasta: hasta.toISOString(),
        con_actividad: actual.turnos > 0 || actual.mensajes_entrantes > 0,
        actual: conCosto ? actual : sinCosto(actual),
        anterior: conCosto ? anterior : sinCosto(anterior),
        busquedas: busq,
        a_persona: persona,
        errores_de_pedido: errores,
        que_hacer: recomendar({ actual, busq, persona, errores }),
    };
    if (conCosto) {
        const conv = actual.conversaciones;
        resultado.costo = {
            usd: actual.costo.usd,
            usd_anterior: anterior.costo.usd,
            llamadas: actual.costo.llamadas,
            usd_por_conversacion: conv > 0 ? Number((actual.costo.usd / conv).toFixed(4)) : null,
            usd_por_pedido: actual.pedidos.total > 0 ? Number((actual.costo.usd / actual.pedidos.total).toFixed(4)) : null,
            usd_proyeccion_mes: Number(((actual.costo.usd / ventana) * 30).toFixed(2)),
        };
    }
    return resultado;
}

module.exports = { informe, recomendar, medir, esTerminoDeProducto };
