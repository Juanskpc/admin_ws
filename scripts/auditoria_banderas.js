/**
 * Auditoría de SOLO LECTURA: recorre las conversaciones con actividad desde una hora y levanta
 * banderas sobre lo que suele salir mal, sin leerlas una por una.
 *
 *   node scripts/auditoria_banderas.js <id_negocio> "<desde, hora Bogotá>"
 *
 * Banderas:
 *   PEDIDO_PERDIDO   el cliente quiso pedir y no hay tomar_pedido OK ni intervención de una persona
 *   PROMESA_FALSA    el bot dice que «envió», «pasó», «avisó»… algo que no puede hacer
 *   NO_ENCONTRADO    el bot dijo que un producto no está en la carta
 *   CONFIRMA_CON     el bot manda al cliente a «confirmar con» el mismo negocio
 *   SIN_RESPUESTA    lo último es del cliente y nadie contestó
 *   MEDIA            el cliente mandó imagen/audio/ubicación, y qué se le contestó
 *
 * No escribe nada. Contiene datos de clientes: no publicar.
 */
'use strict';
require('dotenv').config();
const Models = require('../app_core/models/conection');

const idNegocio = Number(process.argv[2] || 6);
const desde = process.argv[3] || '2026-10-02 13:11';
const q = (sql, r = {}) =>
    Models.sequelize.query(sql, {
        replacements: { idNegocio, desde, ...r },
        type: Models.sequelize.QueryTypes.SELECT,
        logging: false,
    });
const hora = (d) =>
    new Date(d).toLocaleString('es-CO', { timeZone: 'America/Bogota', hour12: false });
const corto = (t, n = 160) => String(t ?? '').replace(/\s+/g, ' ').slice(0, n);
const N = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const QUIERE_PEDIR = /\b(regala|regalas|regalame|quiero|quisiera|pedir|pido|me manda|me mandas|mandame|me envia|me traes|para recoger|a domicilio|domicilio|me das|deme|dame)\b|#p\d/;
const PROMESA = /\b(ya (queda|quedo|se) (enviad|enviado|registrad|notificad|avisad)|ya (le|les) (envie|pase|avise|aviso|paso|informo|reenvie)|queda enviado|ya fue enviad|reenviad|le paso el comprobante|enviado el comprobante|ya les avise|le notifico|les notifico)/;
const NO_ENCONTRADO = /no (encuentr|encontr|aparece|esta en la carta|tengo .* en la carta|hay .* en la carta)/;
const CONFIRMA_CON = /(confirmalo|confirmelo|comunicate|comuniquese|escribe|llama|consulta)[a-z]* (directamente )?(con|a|al) /;

(async () => {
    const convs = await q(
        `SELECT c.id_conversacion, c.id_externo, c.estado, c.atendida_en, c.humano_ultimo_en
           FROM intelligence.conversacion c
          WHERE c.id_negocio = :idNegocio AND EXISTS (
                SELECT 1 FROM intelligence.mensaje m
                 WHERE m.id_conversacion = c.id_conversacion
                   AND m.creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota'))
          ORDER BY c.ultimo_mensaje_en`
    );
    const totales = {};
    const marca = (k) => (totales[k] = (totales[k] || 0) + 1);
    console.log(`Conversaciones con actividad desde ${desde}: ${convs.length}\n`);

    for (const c of convs) {
        const ms = await q(
            `SELECT direccion, id_turno, contenido, creado_en, crudo->>'type' AS tipo
               FROM intelligence.mensaje WHERE id_conversacion = :c
                AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota')
              ORDER BY creado_en`,
            { c: c.id_conversacion }
        );
        const invs = await q(
            `SELECT capacidad, resultado, error_codigo, argumentos FROM intelligence.invocacion_capacidad
              WHERE id_conversacion = :c AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota')`,
            { c: c.id_conversacion }
        );
        const banderas = [];
        const cliente = ms.filter((m) => m.direccion === 'entrante');
        const bot = ms.filter((m) => m.direccion === 'saliente' && m.id_turno);
        const persona = ms.filter((m) => m.direccion === 'saliente' && !m.id_turno);
        const pedidoOk = invs.some((i) => i.capacidad === 'tomar_pedido' && i.resultado === 'ok' && !i.error_codigo);
        const pedidoErr = invs.filter((i) => i.capacidad === 'tomar_pedido' && i.resultado !== 'ok');

        if (cliente.some((m) => QUIERE_PEDIR.test(N(m.contenido))) && !pedidoOk && persona.length === 0) {
            banderas.push('PEDIDO_PERDIDO');
        }
        for (const m of bot) {
            const t = N(m.contenido);
            if (PROMESA.test(t)) banderas.push(`PROMESA_FALSA «${corto(m.contenido, 90)}»`);
            if (NO_ENCONTRADO.test(t)) banderas.push(`NO_ENCONTRADO «${corto(m.contenido, 90)}»`);
            if (CONFIRMA_CON.test(t)) banderas.push(`CONFIRMA_CON «${corto(m.contenido, 90)}»`);
        }
        const ultimo = ms[ms.length - 1];
        if (ultimo && ultimo.direccion === 'entrante' && !['reaction'].includes(ultimo.tipo)) {
            banderas.push(`SIN_RESPUESTA (último: «${corto(ultimo.contenido, 60)}» ${hora(ultimo.creado_en)})`);
        }
        for (let i = 0; i < ms.length; i++) {
            const m = ms[i];
            if (m.direccion === 'entrante' && m.tipo && !['text', 'interactive', 'button', 'reaction'].includes(m.tipo)) {
                const sig = ms.slice(i + 1).find((x) => x.direccion === 'saliente');
                banderas.push(`MEDIA ${m.tipo} → ${sig ? (sig.id_turno ? 'bot' : 'persona') + ': «' + corto(sig.contenido, 70) + '»' : 'sin respuesta'}`);
            }
        }
        for (const e of pedidoErr) banderas.push(`TOMAR_PEDIDO_ERROR ${e.error_codigo}`);
        for (const b of banderas) marca(b.split(' ')[0]);

        console.log(
            `── ${String(c.id_conversacion).slice(-6)} ${c.id_externo.slice(0, 4)}… | cliente ${cliente.length} · bot ${bot.length} · persona ${persona.length} | pedido ${pedidoOk ? 'SÍ' : 'no'} | estado ${c.estado}${c.atendida_en ? ' (atendida)' : ''}`
        );
        console.log(`   primero: «${corto(cliente[0]?.contenido, 110)}»`);
        for (const b of banderas) console.log(`   ⚑ ${b}`);
    }

    console.log('\nResumen de banderas:', totales);
    console.log('\nHerramientas en la ventana:');
    console.log(
        await q(`SELECT capacidad, resultado, error_codigo, count(*)::int n FROM intelligence.invocacion_capacidad
                  WHERE id_negocio=:idNegocio AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota')
                  GROUP BY 1,2,3 ORDER BY 1`)
    );
    console.log('Términos que buscó el bot:');
    console.log(
        (await q(`SELECT argumentos->>'termino' t FROM intelligence.invocacion_capacidad
                   WHERE id_negocio=:idNegocio AND capacidad='buscar_producto'
                     AND creado_en >= (:desde::timestamp AT TIME ZONE 'America/Bogota')`)).map((x) => x.t).join(' | ')
    );
    await Models.sequelize.close();
})().catch(async (e) => {
    console.error('✗', e.message);
    await Models.sequelize.close();
    process.exit(1);
});
