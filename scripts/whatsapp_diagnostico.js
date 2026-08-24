/**
 * Diagnóstico de la cuenta de Meta — qué ve la Cloud API de verdad (F8-C).
 *
 * ## Por qué existe
 *
 * El panel web de Meta y la Graph API no siempre cuentan lo mismo. La pantalla
 * «Configuración de la API» puede decir *«no hay ningún número disponible»* mientras el número
 * existe, está registrado y responde — porque esa pantalla depende del portafolio seleccionado
 * y de la sesión del navegador, y la API no depende de nada de eso.
 *
 * Este script pregunta a la fuente. Es **solo lectura** salvo que se le pase `--enviar`.
 *
 * ## Uso
 *
 *   WHATSAPP_TOKEN=EAAG... WHATSAPP_WABA_ID=4199925320246584 \
 *   WHATSAPP_PHONE_NUMBER_ID=1297624263436786 node scripts/whatsapp_diagnostico.js
 *
 *   ... --enviar=573001234567     # manda la plantilla hello_world (ESTO SÍ ESCRIBE)
 *
 * El token va por variable de entorno y no por argumento a propósito: los argumentos quedan en
 * el historial del shell y en la lista de procesos.
 *
 * ⚠️ **No hay configuración de Prettier en `admin_ws`.** Correrlo aquí aplica sus valores por
 * defecto —comillas dobles, indentación de 2— que son lo contrario del estilo del backend. Este
 * archivo sigue el del resto: comillas simples, 4 espacios, ~100 columnas.
 */
'use strict';
require('dotenv').config();

const VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const BASE = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com';
const TOKEN = process.env.WHATSAPP_TOKEN;
const WABA = process.env.WHATSAPP_WABA_ID;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

const enviarA = (process.argv.find((a) => a.startsWith('--enviar=')) || '').split('=')[1] || null;

function bien(t) {
    console.log(`  \x1b[32m✓\x1b[0m ${t}`);
}
function mal(t) {
    console.log(`  \x1b[31m✗\x1b[0m ${t}`);
}
function aviso(t) {
    console.log(`  \x1b[33m!\x1b[0m ${t}`);
}

/** Una llamada a Graph. Devuelve `{ ok, datos }` en vez de lanzar: aquí un fallo es un dato. */
async function graph(ruta, opciones = {}) {
    const sep = ruta.includes('?') ? '&' : '?';
    const url = `${BASE}/${VERSION}/${ruta}${sep}access_token=${TOKEN}`;
    try {
        const r = await fetch(url, opciones);
        const datos = await r.json().catch(() => null);
        return { ok: r.ok, status: r.status, datos };
    } catch (e) {
        return { ok: false, status: null, datos: { error: { message: e.message } } };
    }
}

function motivo(res) {
    const e = res.datos && res.datos.error;
    if (!e) return String(res.status);
    return `${res.status} — ${e.message}${e.code ? ` (code ${e.code})` : ''}`;
}

async function main() {
    if (!TOKEN) {
        mal('Falta WHATSAPP_TOKEN.');
        process.exit(1);
    }
    console.log(`\nDiagnóstico de WhatsApp Cloud API (${VERSION})\n${'-'.repeat(62)}`);

    // 1. ¿El token sirve, de quién es y hasta cuándo vive?
    console.log('\n1. El token');
    const dbg = await graph(`debug_token?input_token=${TOKEN}`);
    if (!dbg.ok) {
        mal(`no se pudo inspeccionar: ${motivo(dbg)}`);
    } else {
        const d = (dbg.datos && dbg.datos.data) || {};
        d.is_valid ? bien('válido') : mal('NO válido — genera uno nuevo');
        console.log(`      app: ${d.app_id ?? '?'} · tipo: ${d.type ?? '?'}`);
        if (d.expires_at === 0) {
            bien('sin caducidad (permanente)');
        } else if (d.expires_at) {
            const cuando = new Date(d.expires_at * 1000);
            const horas = Math.round((cuando - Date.now()) / 3.6e6);
            (horas < 24 ? aviso : bien)(`caduca ${cuando.toISOString()} (en ~${horas} h)`);
            if (horas < 24) console.log('      → un token temporal de 24 h no sirve para producción');
        }
        const scopes = d.scopes || [];
        for (const p of ['whatsapp_business_messaging', 'whatsapp_business_management']) {
            scopes.includes(p) ? bien(`permiso ${p}`) : mal(`FALTA el permiso ${p}`);
        }

        // Tener el permiso NO es tener el activo. En Meta son dos cosas distintas y esta es la
        // que engaña: un token de USUARIO con `whatsapp_business_management` y CERO activos
        // concedidos parece correcto en todas las pantallas y no puede leer una sola WABA.
        //
        // ⚠️ Pero esto **solo vale para tokens de usuario**. Un `SYSTEM_USER` saca su acceso de los
        // activos asignados al usuario del sistema, no de `granular_scopes`, que le viene vacío
        // siempre. Tratarlo como error ahí es gritar por nada — pasó el 2026-08-22 con un token
        // permanente perfectamente bueno. Para un usuario del sistema, la prueba de verdad es el
        // bloque 2: si lista los números de la WABA, tiene el activo.
        const granular = d.granular_scopes || [];
        const activos = new Set();
        for (const s of granular) for (const id of s.target_ids || []) activos.add(id);
        if (activos.size > 0) {
            bien(`activos concedidos: ${[...activos].join(', ')}`);
        } else if (d.type === 'SYSTEM_USER') {
            aviso('sin activos en granular_scopes — normal en un usuario del sistema');
            console.log('      → su acceso viene de los activos asignados; lo comprueba el bloque 2');
        } else {
            mal('el token no tiene NINGUNA cuenta de WhatsApp concedida (granular_scopes vacío)');
            console.log('      → tener el permiso no es tener el activo: al generar el token hay');
            console.log('        que elegir explícitamente el portafolio y la WABA.');
        }
    }

    if (WABA) {
        // 2. Los números que cuelgan de la WABA. Esta es la respuesta a «no hay número disponible».
        console.log('\n2. Números en la WABA');
        const nums = await graph(
            `${WABA}/phone_numbers?fields=id,display_phone_number,verified_name,` +
                `code_verification_status,quality_rating,platform_type,status`
        );
        if (!nums.ok) {
            mal(`no se pudo listar: ${motivo(nums)}`);
            console.log('      → si dice "does not exist or you do not have permission",');
            console.log('        el problema es de asignación de activos, no del panel web.');
        } else {
            const lista = (nums.datos && nums.datos.data) || [];
            if (lista.length === 0) {
                mal('la WABA no tiene NINGÚN número — aquí sí coincide con el panel');
            } else {
                bien(`${lista.length} número(s):`);
                for (const n of lista) {
                    const yo = n.id === PHONE_ID ? '  <-- el tuyo' : '';
                    console.log(`      · ${n.display_phone_number} (id ${n.id})${yo}`);
                    console.log(`        nombre: ${n.verified_name ?? '?'} · estado: ${n.status ?? '?'}`);
                    console.log(
                        `        verificación: ${n.code_verification_status ?? '?'} · plataforma: ${n.platform_type ?? '?'}`
                    );
                }
                if (PHONE_ID && !lista.some((n) => n.id === PHONE_ID)) {
                    mal(`WHATSAPP_PHONE_NUMBER_ID (${PHONE_ID}) NO está en esta WABA`);
                }
            }
        }

        // 3. ¿Está la app suscrita a la WABA? Sin esto no llega un solo webhook.
        console.log('\n3. Apps suscritas a la WABA (esto es lo que hace llegar los webhooks)');
        const subs = await graph(`${WABA}/subscribed_apps`);
        if (!subs.ok) {
            mal(`no se pudo consultar: ${motivo(subs)}`);
        } else {
            const apps = (subs.datos && subs.datos.data) || [];
            if (apps.length === 0) {
                mal('NINGUNA app suscrita — los webhooks no llegarán aunque el envío funcione');
                console.log(`      → se arregla con: POST /${VERSION}/${WABA}/subscribed_apps`);
            } else {
                for (const a of apps) {
                    const d = a.whatsapp_business_api_data || {};
                    bien(`${d.name ?? '?'} (id ${d.id ?? '?'})`);
                }
            }
        }

        // 4. Las plantillas. `recordatorio_cita` es requisito de F8-C y tiene plazo de aprobación.
        console.log('\n4. Plantillas');
        const tpl = await graph(`${WABA}/message_templates?fields=name,status,category,language&limit=50`);
        if (!tpl.ok) {
            mal(`no se pudieron listar: ${motivo(tpl)}`);
        } else {
            const lista = (tpl.datos && tpl.datos.data) || [];
            if (lista.length === 0) aviso('ninguna plantilla registrada');
            for (const t of lista) {
                const f = t.status === 'APPROVED' ? bien : aviso;
                f(`${t.name} [${t.language}] · ${t.status} · ${t.category}`);
            }
            lista.some((t) => t.name === 'recordatorio_cita')
                ? bien('recordatorio_cita existe')
                : aviso('FALTA recordatorio_cita — es requisito de F8-C y su aprobación tarda');
        }
    } else {
        aviso('\n2-4. Sin WHATSAPP_WABA_ID no se puede revisar la WABA.');
    }

    // 5. El número en sí.
    if (PHONE_ID) {
        console.log('\n5. El número');
        const p = await graph(
            `${PHONE_ID}?fields=display_phone_number,verified_name,status,` +
                `code_verification_status,platform_type,throughput,quality_rating`
        );
        if (!p.ok) {
            mal(`no accesible: ${motivo(p)}`);
        } else {
            const d = p.datos || {};
            bien(`${d.display_phone_number} — ${d.verified_name ?? 'sin nombre'}`);
            console.log(`      estado: ${d.status ?? '?'} · calidad: ${d.quality_rating ?? '?'}`);
            console.log(
                `      plataforma: ${d.platform_type ?? '?'} · caudal: ${(d.throughput && d.throughput.level) ?? '?'}`
            );
        }
    }

    // 6. Envío real. Solo bajo petición explícita: esto le escribe a un teléfono de verdad.
    if (enviarA) {
        console.log(`\n6. Enviando hello_world a ${enviarA}`);
        if (!PHONE_ID) {
            mal('falta WHATSAPP_PHONE_NUMBER_ID');
            return;
        }
        const r = await graph(`${PHONE_ID}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: enviarA,
                type: 'template',
                template: { name: 'hello_world', language: { code: 'en_US' } },
            }),
        });
        if (r.ok) {
            const wamid = r.datos && r.datos.messages && r.datos.messages[0] && r.datos.messages[0].id;
            bien(`aceptado — wamid ${wamid ?? '?'}`);
            aviso('«aceptado» no es «entregado»: Meta avisa de los fallos después, por webhook');
        } else {
            mal(motivo(r));
            const c = r.datos && r.datos.error && r.datos.error.code;
            if (c === 131030)
                console.log('      → 131030: el destinatario NO está en la lista de permitidos del número de prueba');
            if (c === 100) console.log('      → 100: revisa el formato del número (sin +: 573001234567)');
            if (c === 190) console.log('      → 190: token caducado o revocado');
        }
    } else {
        console.log('\n6. Envío: omitido (añade --enviar=573001234567 para probarlo)');
    }

    console.log(`\n${'-'.repeat(62)}\n`);
}

main().catch((e) => {
    mal(e.message);
    process.exit(1);
});
