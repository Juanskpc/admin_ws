/**
 * Auditoría de SOLO LECTURA (2026-10-02): todo lo relacionado con el domicilio en Zona Burger.
 *
 *   node scripts/auditoria_domicilio_zona_burger.js [id_negocio=6] [desde=2026-10-01 19:00]
 *
 * 1. Panorama de WhatsApp desde que se conectó el número.
 * 2. Cada mensaje del cliente que habla de domicilio / barrio / envío, con lo que vino después
 *    (quién contestó: el bot —tiene turno— o una persona).
 * 3. Llamadas del asistente a consultar_info_negocio y tomar_pedido (direcciones que dieron).
 * 4. Pedidos a DOMICILIO del negocio (todos los canales): dirección y valor cobrado, para ver
 *    cuánto se cobra en la práctica según el sitio.
 *
 * No escribe nada. Sale por consola; contiene datos de clientes: no publicar.
 */
'use strict';
require('dotenv').config();
const Models = require('../app_core/models/conection');

const idNegocio = Number(process.argv[2] || 6);
const desde = process.argv[3] || '2026-10-01 19:00';
const q = (sql, r = {}) =>
    Models.sequelize.query(sql, {
        replacements: { idNegocio, desde, ...r },
        type: Models.sequelize.QueryTypes.SELECT,
        logging: false,
    });
const corto = (t, n = 400) => String(t ?? '').replace(/\s+/g, ' ').slice(0, n);
const hora = (d) =>
    new Date(d).toLocaleString('es-CO', { timeZone: 'America/Bogota', hour12: false });

const TEMA = String.raw`domicil|domi\b|env[ií]o|barrio|comuna|vereda|cu[aá]nto.*(lleva|trae|cobra)|recargo|transporte`;

(async () => {
    console.log(`\n══ 1. Panorama — negocio ${idNegocio}, desde ${desde} (Bogotá) ══`);
    console.log(
        await q(`
        SELECT
          (SELECT count(*) FROM intelligence.conversacion
            WHERE id_negocio=:idNegocio AND canal='whatsapp'
              AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota'))::int AS conversaciones_nuevas,
          (SELECT count(*) FROM intelligence.mensaje WHERE id_negocio=:idNegocio AND direccion='entrante'
              AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota'))::int AS mensajes_cliente,
          (SELECT count(*) FROM intelligence.mensaje WHERE id_negocio=:idNegocio AND direccion='saliente'
              AND id_turno IS NOT NULL
              AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota'))::int AS mensajes_bot,
          (SELECT count(*) FROM intelligence.mensaje WHERE id_negocio=:idNegocio AND direccion='saliente'
              AND id_turno IS NULL
              AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota'))::int AS mensajes_persona`)
    );
    console.log(
        await q(`SELECT direccion, count(*)::int n FROM intelligence.mensaje
                  WHERE id_negocio=:idNegocio AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota')
                  GROUP BY 1`)
    );

    console.log(`\n══ 2. Mensajes del cliente sobre domicilio/barrio/envío, con lo que siguió ══`);
    const temas = await q(
        `SELECT id_mensaje, id_conversacion, contenido, creado_en FROM intelligence.mensaje
          WHERE id_negocio=:idNegocio AND direccion='entrante'
            AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota')
            AND contenido ~* :tema
          ORDER BY creado_en`,
        { tema: TEMA }
    );
    console.log(`(${temas.length} mensajes)`);
    for (const m of temas) {
        console.log(`\n--- conv ${String(m.id_conversacion).slice(-6)} · ${hora(m.creado_en)}`);
        console.log(`  CLIENTE: ${corto(m.contenido)}`);
        const siguientes = await q(
            `SELECT direccion, id_turno, contenido, creado_en FROM intelligence.mensaje
              WHERE id_conversacion=:c AND creado_en > :t ORDER BY creado_en LIMIT 4`,
            { c: m.id_conversacion, t: m.creado_en }
        );
        for (const s of siguientes) {
            const quien = s.direccion === 'entrante' ? 'CLIENTE' : s.id_turno ? 'BOT    ' : 'PERSONA';
            console.log(`  ${quien} (+${Math.round((new Date(s.creado_en) - new Date(m.creado_en)) / 60000)} min): ${corto(s.contenido, 300)}`);
        }
    }

    console.log(`\n══ 2b. Lo que el BOT dijo sobre el domicilio ══`);
    for (const m of await q(
        `SELECT contenido, creado_en FROM intelligence.mensaje
          WHERE id_negocio=:idNegocio AND direccion='saliente' AND id_turno IS NOT NULL
            AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota')
            AND contenido ~* 'domicilio' ORDER BY creado_en`
    )) {
        console.log(`  ${hora(m.creado_en)}: ${corto(m.contenido, 300)}`);
    }

    console.log(`\n══ 2c. Lo que una PERSONA del negocio dijo sobre el domicilio (valores reales) ══`);
    for (const m of await q(
        `SELECT contenido, creado_en FROM intelligence.mensaje
          WHERE id_negocio=:idNegocio AND direccion='saliente' AND id_turno IS NULL
            AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota')
            AND contenido ~* :tema ORDER BY creado_en`,
        { tema: TEMA }
    )) {
        console.log(`  ${hora(m.creado_en)}: ${corto(m.contenido, 300)}`);
    }

    console.log(`\n══ 3. Herramientas del asistente ══`);
    console.log(
        await q(`SELECT capacidad, resultado, error_codigo, dry_run,
                        (creado_en >= ('2026-10-02 00:18'::timestamp AT TIME ZONE 'America/Bogota')) AS tras_arreglos, count(*)::int n
                   FROM intelligence.invocacion_capacidad
                  WHERE id_negocio=:idNegocio AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota')
                  GROUP BY 1,2,3,4,5 ORDER BY 1,5,2`)
    );
    console.log('Turnos por nivel y resultado:');
    console.log(await q(`SELECT nivel, resultado, count(*)::int n FROM intelligence.turno WHERE id_negocio=:idNegocio AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota') GROUP BY 1,2 ORDER BY 3 DESC`));
    console.log('Pasos de domicilio (decisiones del flujo):');
    console.log(await q(`SELECT decision, count(*)::int n FROM intelligence.paso WHERE id_negocio=:idNegocio AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota') AND decision ~* 'domicilio|barrio|entrega' GROUP BY 1 ORDER BY 2 DESC`));
    console.log('Direcciones dadas al asistente (tomar_pedido):');
    for (const i of await q(
        `SELECT DISTINCT ON (argumentos->>'direccion') argumentos->>'direccion' AS dir,
                argumentos->>'tipo_entrega' AS tipo, argumentos->>'id_barrio' AS barrio, creado_en
           FROM intelligence.invocacion_capacidad
          WHERE id_negocio=:idNegocio AND capacidad='tomar_pedido'
            AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota')
            AND argumentos ? 'direccion'`
    )) {
        console.log(`  [${i.tipo || '?'}] ${corto(i.dir, 200)}${i.barrio ? ` (barrio ${i.barrio})` : ''}`);
    }

    console.log(`\n══ 4. Pedidos a DOMICILIO del negocio (todos los canales) ══`);
    console.log(
        await q(`SELECT count(*)::int n, min(fecha_creacion) primero, max(fecha_creacion) ultimo,
                        count(*) FILTER (WHERE valor_domicilio > 0)::int con_valor,
                        min(valor_domicilio) FILTER (WHERE valor_domicilio > 0) min_valor,
                        max(valor_domicilio) max_valor,
                        round(avg(valor_domicilio) FILTER (WHERE valor_domicilio > 0)) prom_valor
                   FROM restaurante.pedid_orden
                  WHERE id_negocio=:idNegocio AND tipo_pedido='DOMICILIO'`)
    );
    console.log('Distribución del valor cobrado:');
    console.log(
        await q(`SELECT valor_domicilio::int valor, count(*)::int n FROM restaurante.pedid_orden
                  WHERE id_negocio=:idNegocio AND tipo_pedido='DOMICILIO'
                  GROUP BY 1 ORDER BY 1`)
    );
    console.log('Direcciones y valor (últimos 300):');
    for (const o of await q(
        `SELECT fecha_creacion, direccion_domicilio, valor_domicilio::int v, estado
           FROM restaurante.pedid_orden
          WHERE id_negocio=:idNegocio AND tipo_pedido='DOMICILIO'
          ORDER BY fecha_creacion DESC LIMIT 5`
    )) {
        console.log(`  ${hora(o.fecha_creacion)} | $${o.v} | ${o.estado} | ${corto(o.direccion_domicilio, 160)}`);
    }

    console.log('\nBarrios con precio cargados (rest_barrio_domicilio):');
    console.log(
        await q(`SELECT nombre, valor::int, estado FROM restaurante.rest_barrio_domicilio
                  WHERE id_negocio=:idNegocio ORDER BY nombre`)
    );
    await Models.sequelize.close();
})().catch(async (e) => {
    console.error('✗', e.message);
    await Models.sequelize.close();
    process.exit(1);
});
