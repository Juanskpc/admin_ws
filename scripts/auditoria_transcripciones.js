/**
 * Auditoría de SOLO LECTURA: todas las conversaciones con actividad desde una hora, completas y
 * en orden, con las decisiones relevantes de cada turno y los pedidos que salieron.
 *
 *   node scripts/auditoria_transcripciones.js <id_negocio> "<desde, hora Bogotá>"
 *
 * Complementa a `auditoria_banderas.js`: aquélla resume, ésta deja leer. No escribe nada.
 * Contiene datos de clientes: no publicar.
 */
'use strict';
require('dotenv').config();
const Models = require('../app_core/models/conection');

const idNegocio = Number(process.argv[2] || 6);
const desde = process.argv[3] || '2026-10-02 19:41';
const q = (sql, r = {}) =>
    Models.sequelize.query(sql, {
        replacements: { idNegocio, desde, ...r },
        type: Models.sequelize.QueryTypes.SELECT,
        logging: false,
    });
const hora = (d) =>
    d ? new Date(d).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour12: false }) : '—';
const corto = (t, n = 260) => String(t ?? '').replace(/\s+/g, ' ').slice(0, n);

// Pasos que no dicen nada al leer una conversación.
const RUIDO = new Set(['prompt_armado', 'mensaje_encolado', 'actividad_senalada', 'turno', 'capacidades', 'pregunta_libre']);

(async () => {
    const convs = await q(
        `SELECT c.id_conversacion, c.id_externo, c.estado, c.tarea_actual
           FROM intelligence.conversacion c
          WHERE c.id_negocio = :idNegocio AND EXISTS (
                SELECT 1 FROM intelligence.mensaje m
                 WHERE m.id_conversacion = c.id_conversacion
                   AND m.creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota'))
          ORDER BY c.ultimo_mensaje_en`
    );
    console.log(`Conversaciones con actividad desde ${desde}: ${convs.length}`);

    for (const c of convs) {
        console.log(
            `\n════ ${String(c.id_conversacion).slice(-6)} · ${c.id_externo.slice(0, 8)}… · estado=${c.estado}` +
                `${c.tarea_actual ? ` · tarea=${c.tarea_actual}` : ''}`
        );
        const ms = await q(
            `SELECT m.direccion, m.id_turno, m.contenido, m.creado_en, m.sin_turno_motivo, m.estado_entrega
               FROM intelligence.mensaje m
              WHERE m.id_conversacion = :c
                AND m.creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota') - interval '30 minutes'
              ORDER BY m.creado_en`,
            { c: c.id_conversacion }
        );
        const turnosVistos = new Set();
        for (const m of ms) {
            const quien = m.direccion === 'entrante' ? 'CLIENTE' : m.id_turno ? 'BOT    ' : 'PERSONA';
            const extra = [
                m.sin_turno_motivo ? `sin_turno=${m.sin_turno_motivo}` : null,
                m.direccion === 'saliente' && m.estado_entrega !== 'entregado' ? `entrega=${m.estado_entrega}` : null,
            ].filter(Boolean).join(' ');
            console.log(`${hora(m.creado_en)} ${quien}: ${corto(m.contenido)}${extra ? `  [${extra}]` : ''}`);

            if (m.id_turno && !turnosVistos.has(m.id_turno)) {
                turnosVistos.add(m.id_turno);
                const [t] = await q(
                    `SELECT nivel, resultado, error_codigo FROM intelligence.turno WHERE id_turno = :t`,
                    { t: m.id_turno }
                );
                const pasos = (await q(
                    `SELECT tipo, decision, motivo FROM intelligence.paso WHERE id_turno = :t ORDER BY secuencia`,
                    { t: m.id_turno }
                )).filter((p) => !RUIDO.has(p.decision));
                const invs = await q(
                    `SELECT capacidad, resultado, error_codigo, argumentos FROM intelligence.invocacion_capacidad
                      WHERE id_turno = :t ORDER BY creado_en`,
                    { t: m.id_turno }
                );
                const resumen = [
                    t ? `${t.nivel}/${t.resultado}${t.error_codigo ? ' ERR=' + t.error_codigo : ''}` : '',
                    ...pasos.map((p) => p.decision),
                    ...invs.map((i) => `⚙${i.capacidad}:${i.resultado}${i.error_codigo ? '(' + i.error_codigo + ')' : ''}`),
                ].filter(Boolean);
                if (resumen.length) console.log(`         ↳ ${resumen.join(' · ')}`);
                for (const i of invs.filter((x) => x.capacidad === 'tomar_pedido' || x.error_codigo)) {
                    console.log(`           args ${i.capacidad}: ${corto(JSON.stringify(i.argumentos), 220)}`);
                }
            }
        }
    }

    console.log('\n════ Pedidos creados en la ventana ════');
    for (const o of await q(
        `SELECT o.numero_orden, o.estado, o.tipo_pedido, o.total::int AS total, o.contacto_nombre,
                o.para_servir, o.id_mesa, u.primer_nombre AS usuario, o.nota
           FROM restaurante.pedid_orden o
           LEFT JOIN general.gener_usuario u ON u.id_usuario = o.id_usuario
          WHERE o.id_negocio = :idNegocio
            AND o.id_orden > (SELECT max(id_orden) FROM restaurante.pedid_orden
                               WHERE id_negocio = :idNegocio AND numero_orden <= 'ORD-7570')
          ORDER BY o.numero_orden`
    )) {
        console.log(`  ${o.numero_orden} ${o.estado} ${o.tipo_pedido}${o.para_servir ? ' (para servir)' : ''} $${o.total} · ${o.contacto_nombre || '—'} · por ${o.usuario}${o.nota ? ' · nota: ' + corto(o.nota, 60) : ''}`);
    }
    await Models.sequelize.close();
})().catch(async (e) => {
    console.error('✗', e.message);
    await Models.sequelize.close();
    process.exit(1);
});
