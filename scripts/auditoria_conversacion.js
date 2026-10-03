/**
 * Auditoría de SOLO LECTURA: una conversación completa, con lo que el asistente decidió en cada
 * turno (nivel, pasos, herramientas) y los pedidos que salieron de ella.
 *
 *   node scripts/auditoria_conversacion.js <id_negocio> <texto del id_externo o del teléfono>
 *
 * No escribe nada. Contiene datos de clientes: no publicar.
 */
'use strict';
require('dotenv').config();
const Models = require('../app_core/models/conection');

const idNegocio = Number(process.argv[2]);
const busca = String(process.argv[3] || '').replace(/\D/g, '');
const q = (sql, r = {}) =>
    Models.sequelize.query(sql, {
        replacements: { idNegocio, ...r },
        type: Models.sequelize.QueryTypes.SELECT,
        logging: false,
    });
const hora = (d) =>
    d ? new Date(d).toLocaleString('es-CO', { timeZone: 'America/Bogota', hour12: false }) : '—';
const corto = (t, n = 600) => String(t ?? '').replace(/\s+/g, ' ').slice(0, n);

(async () => {
    const convs = await q(
        `SELECT * FROM intelligence.conversacion
          WHERE id_negocio = :idNegocio AND regexp_replace(id_externo, '\\D', '', 'g') LIKE :b
          ORDER BY creado_en`,
        { b: `%${busca}%` }
    );
    console.log(`Conversaciones que coinciden: ${convs.length}`);
    for (const c of convs) {
        const { variables, tarea_datos, ...resto } = c;
        console.log('\n════ CONVERSACIÓN', JSON.stringify(resto, null, 1));
        console.log('variables:', JSON.stringify(variables));
        console.log('tarea_datos:', JSON.stringify(tarea_datos));

        const mensajes = await q(
            `SELECT id_mensaje, id_turno, direccion, contenido, creado_en, estado_entrega, enviado_en,
                    sin_turno_motivo, crudo->>'type' AS tipo_crudo
               FROM intelligence.mensaje WHERE id_conversacion = :c ORDER BY creado_en`,
            { c: c.id_conversacion }
        );
        const turnos = await q(
            `SELECT id_turno, secuencia, nivel, estado, resultado, error_codigo, creado_en, terminado_en
               FROM intelligence.turno WHERE id_conversacion = :c ORDER BY secuencia`,
            { c: c.id_conversacion }
        );
        const pasos = await q(
            `SELECT p.id_turno, p.secuencia, p.tipo, p.decision, p.motivo
               FROM intelligence.paso p JOIN intelligence.turno t ON t.id_turno = p.id_turno
              WHERE t.id_conversacion = :c ORDER BY t.secuencia, p.secuencia`,
            { c: c.id_conversacion }
        );
        const invs = await q(
            `SELECT id_turno, capacidad, argumentos, resultado, error_codigo, dry_run, creado_en
               FROM intelligence.invocacion_capacidad WHERE id_conversacion = :c ORDER BY creado_en`,
            { c: c.id_conversacion }
        );

        console.log(`\n── Línea de tiempo (${mensajes.length} mensajes, ${turnos.length} turnos) ──`);
        const vistos = new Set();
        for (const m of mensajes) {
            const quien =
                m.direccion === 'entrante' ? 'CLIENTE' : m.id_turno ? 'BOT    ' : 'PERSONA';
            const extra = [
                m.tipo_crudo && m.tipo_crudo !== 'text' ? `tipo=${m.tipo_crudo}` : null,
                m.sin_turno_motivo ? `sin_turno=${m.sin_turno_motivo}` : null,
                m.direccion === 'saliente' ? `entrega=${m.estado_entrega}` : null,
            ].filter(Boolean).join(' ');
            console.log(`${hora(m.creado_en)} ${quien}: ${corto(m.contenido)}${extra ? `   [${extra}]` : ''}`);
            // Tras el primer mensaje del bot de un turno, cómo se decidió ese turno.
            if (m.id_turno && !vistos.has(m.id_turno) && m.direccion === 'saliente') {
                vistos.add(m.id_turno);
                const t = turnos.find((x) => x.id_turno === m.id_turno);
                if (t) console.log(`        ↳ turno ${t.secuencia}: nivel=${t.nivel} resultado=${t.resultado}${t.error_codigo ? ' error=' + t.error_codigo : ''}`);
                for (const p of pasos.filter((x) => x.id_turno === m.id_turno)) {
                    console.log(`          · ${p.tipo}/${p.decision} ${corto(JSON.stringify(p.motivo), 220)}`);
                }
                for (const i of invs.filter((x) => x.id_turno === m.id_turno)) {
                    console.log(`          ⚙ ${i.capacidad} → ${i.resultado}${i.error_codigo ? ' ' + i.error_codigo : ''}${i.dry_run ? ' (dry-run)' : ''} ${corto(JSON.stringify(i.argumentos), 300)}`);
                }
            }
        }

        // Turnos que no dejaron mensaje (silencios, errores).
        const mudos = turnos.filter((t) => !vistos.has(t.id_turno));
        if (mudos.length) {
            console.log('\n── Turnos sin mensaje del bot ──');
            for (const t of mudos) {
                console.log(`${hora(t.creado_en)} turno ${t.secuencia}: nivel=${t.nivel} estado=${t.estado} resultado=${t.resultado} error=${t.error_codigo}`);
                for (const p of pasos.filter((x) => x.id_turno === t.id_turno)) {
                    console.log(`          · ${p.tipo}/${p.decision} ${corto(JSON.stringify(p.motivo), 220)}`);
                }
            }
        }
    }

    // Pedidos que pudieron salir de esas conversaciones (por teléfono de contacto).
    if (busca.length >= 7) {
        const pedidos = await q(
            `SELECT numero_orden, estado, tipo_pedido, total::int, valor_domicilio::int, estado_pago,
                    direccion_domicilio, fecha_creacion
               FROM restaurante.pedid_orden
              WHERE id_negocio = :idNegocio
                AND regexp_replace(coalesce(contacto_telefono, ''), '\\D', '', 'g') LIKE :b
              ORDER BY fecha_creacion DESC LIMIT 10`,
            { b: `%${busca.slice(-10)}%` }
        ).catch((e) => [{ error: e.message }]);
        console.log('\n── Pedidos con ese teléfono ──');
        console.log(pedidos);
    }
    await Models.sequelize.close();
})().catch(async (e) => {
    console.error('✗', e.message);
    await Models.sequelize.close();
    process.exit(1);
});
