/**
 * Estado de salud de la cuenta de WhatsApp — ¿puede enviar, y si no, por qué? (F8-C)
 *
 * ## Por qué existe
 *
 * `whatsapp_diagnostico.js` contesta «¿está bien cableado?». Este contesta otra pregunta
 * distinta y que cambia sola con el tiempo: **«¿me deja Meta enviar hoy?»**. Son cosas
 * separadas — el número puede estar CONNECTED, la plantilla APPROVED y el webhook suscrito,
 * y aun así no salir un solo mensaje porque la tarjeta falló o falta verificar el negocio.
 *
 * `canal-whatsapp.md` mandaba a copiar un `curl` a mano cada vez. Durante el trámite de
 * verificación eso hay que mirarlo cada pocos días, así que mejor un comando.
 *
 * Los dos códigos que importan:
 *   · 141006 — método de pago con error → bloquea los mensajes que INICIA la empresa
 *              (los recordatorios de F8-B). Se arregla en Billing & Payments, no en el código.
 *   · 141010 — negocio sin verificar → techo de 2 números = 2 inquilinos.
 *
 * ## Uso
 *
 *   cd /var/www/admin_ws && node scripts/whatsapp_salud.js
 *
 * Solo lectura. No escribe nada, ni en Meta ni en la base.
 */
'use strict';
require('dotenv').config();

const VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const BASE = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com';
const TOKEN = process.env.WHATSAPP_TOKEN;
const WABA = process.env.WHATSAPP_WABA_ID;

function bien(t) {
    console.log(`  \x1b[32m✓\x1b[0m ${t}`);
}
function mal(t) {
    console.log(`  \x1b[31m✗\x1b[0m ${t}`);
}
function aviso(t) {
    console.log(`  \x1b[33m!\x1b[0m ${t}`);
}

async function graph(ruta) {
    const sep = ruta.includes('?') ? '&' : '?';
    const url = `${BASE}/${VERSION}/${ruta}${sep}access_token=${TOKEN}`;
    try {
        const r = await fetch(url);
        const datos = await r.json().catch(() => null);
        return { ok: r.ok, status: r.status, datos };
    } catch (e) {
        return { ok: false, status: null, datos: { error: { message: e.message } } };
    }
}

/** Traduce los códigos que ya nos han mordido. Los demás se imprimen tal cual. */
function explicar(codigo) {
    if (codigo === 141006) return 'método de pago con error → Billing & Payments (NO lo arregla verificar)';
    if (codigo === 141010) return 'negocio SIN VERIFICAR → techo de 2 números';
    return null;
}

async function main() {
    if (!TOKEN || !WABA) {
        mal('Faltan WHATSAPP_TOKEN o WHATSAPP_WABA_ID en el entorno.');
        process.exit(1);
    }

    console.log(`\nSalud de la cuenta de WhatsApp (${VERSION})`);
    console.log('-'.repeat(62));

    const res = await graph(`${WABA}?fields=name,account_review_status,health_status`);
    if (!res.ok) {
        const e = (res.datos && res.datos.error) || {};
        mal(`no se pudo consultar: ${res.status} — ${e.message || '?'}`);
        process.exit(1);
    }

    const d = res.datos;
    console.log(`\nWABA: ${d.name || '?'} (${WABA})`);
    console.log(`Revisión de la cuenta: ${d.account_review_status || '?'}`);

    const salud = d.health_status;
    if (!salud) {
        aviso('Meta no devolvió health_status en esta llamada.');
        process.exit(0);
    }

    console.log(`\nPuede enviar (global): ${salud.can_send_message}`);
    console.log('\nPor entidad:');

    let bloqueos = 0;
    for (const ent of salud.entities || []) {
        const etiqueta = `${ent.entity_type} ${ent.id || ''}`.trim();
        const estado = ent.can_send_message;
        if (estado === 'AVAILABLE') {
            bien(`${etiqueta}: AVAILABLE`);
        } else {
            bloqueos++;
            mal(`${etiqueta}: ${estado}`);
        }
        for (const err of ent.errors || []) {
            const nota = explicar(err.error_code);
            console.log(`      · ${err.error_code} — ${err.error_description}`);
            if (nota) console.log(`        \x1b[33m→ ${nota}\x1b[0m`);
            else if (err.possible_solution) console.log(`        → ${err.possible_solution}`);
        }
    }

    console.log('\n' + '-'.repeat(62));
    if (bloqueos === 0) {
        bien('Nada bloqueado: puede enviar, incluidos mensajes iniciados por la empresa.');
    } else {
        aviso(`${bloqueos} entidad(es) con restricción — ver los códigos de arriba.`);
    }
    console.log();
}

main();
