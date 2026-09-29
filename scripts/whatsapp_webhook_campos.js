/**
 * ¿Está la app de Meta suscrita a los campos del webhook que necesita la coexistencia?
 *
 * ## Por qué existe
 *
 * Que la app esté suscrita a la WABA de un cliente (`POST /{waba}/subscribed_apps`, lo hace
 * `canalEmbeddedSignup.conectar()`) no basta: Meta solo manda los campos que la **app** tiene
 * activados en su configuración de Webhooks (objeto `whatsapp_business_account`). Si falta
 * `smb_message_echoes`, el asistente le contesta encima al dueño cuando él responde desde su
 * celular; si falta `account_update`, nunca nos enteramos de que el número se desconectó.
 *
 * Esto se puede mirar en developers.facebook.com → app Escalapp → WhatsApp → Configuración →
 * Webhooks. Este script lo mira (y opcionalmente lo arregla) por API, con el token de la app.
 *
 * ## Uso
 *
 *   cd /var/www/admin_ws && node scripts/whatsapp_webhook_campos.js            # solo mira
 *   cd /var/www/admin_ws && node scripts/whatsapp_webhook_campos.js --aplicar  # añade los que falten
 *
 * `--aplicar` conserva la URL de callback y los campos que ya hubiera; solo AÑADE los que faltan.
 * Toca la configuración de la app de Meta en producción: correrlo a conciencia.
 *
 * Necesita WHATSAPP_APP_ID, WHATSAPP_APP_SECRET y WHATSAPP_VERIFY_TOKEN en el .env.
 */
'use strict';
require('dotenv').config();

const VERSION = process.env.META_EMBEDDED_SIGNUP_API_VERSION || 'v23.0';
const BASE = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com';
const APP_ID = process.env.WHATSAPP_APP_ID;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const OBJETO = 'whatsapp_business_account';

/** Lo que usa el canal hoy. `messages` incluye los acuses (`statuses`). */
const NECESARIOS = ['messages', 'smb_message_echoes', 'history', 'smb_app_state_sync', 'account_update'];

function bien(t) {
    console.log(`  \x1b[32m✓\x1b[0m ${t}`);
}
function mal(t) {
    console.log(`  \x1b[31m✗\x1b[0m ${t}`);
}

async function main() {
    const aplicar = process.argv.includes('--aplicar');
    if (!APP_ID || !APP_SECRET) {
        mal('Faltan WHATSAPP_APP_ID o WHATSAPP_APP_SECRET en el .env.');
        process.exit(1);
    }
    const tokenApp = encodeURIComponent(`${APP_ID}|${APP_SECRET}`);

    const r = await fetch(`${BASE}/${VERSION}/${APP_ID}/subscriptions?access_token=${tokenApp}`);
    const datos = await r.json().catch(() => null);
    if (!r.ok) {
        mal(`Meta rechazó la consulta (${r.status}): ${datos?.error?.message || 'sin detalle'}`);
        process.exit(1);
    }

    const sub = (datos?.data || []).find((s) => s.object === OBJETO);
    if (!sub) {
        mal(`La app no tiene webhook para ${OBJETO}. Configúralo primero en el panel de Meta.`);
        process.exit(1);
    }

    const activos = new Set((sub.fields || []).map((f) => (typeof f === 'string' ? f : f.name)));
    console.log(`\nWebhook de ${OBJETO} → ${sub.callback_url} (${sub.active ? 'activo' : 'INACTIVO'})\n`);
    const faltan = [];
    for (const campo of NECESARIOS) {
        if (activos.has(campo)) bien(campo);
        else {
            mal(`${campo} — falta`);
            faltan.push(campo);
        }
    }

    if (faltan.length === 0) {
        console.log('\nTodo en orden.\n');
        return;
    }
    if (!aplicar) {
        console.log(`\nFaltan ${faltan.length}. Vuelve a correrlo con --aplicar para añadirlos.\n`);
        process.exitCode = 2;
        return;
    }
    if (!VERIFY_TOKEN) {
        mal('Falta WHATSAPP_VERIFY_TOKEN: Meta lo pide para volver a verificar el callback.');
        process.exit(1);
    }

    const campos = [...new Set([...activos, ...NECESARIOS])].join(',');
    const cuerpo = new URLSearchParams({
        object: OBJETO,
        callback_url: sub.callback_url,
        verify_token: VERIFY_TOKEN,
        fields: campos,
        include_values: 'true',
    });
    const p = await fetch(`${BASE}/${VERSION}/${APP_ID}/subscriptions?access_token=${tokenApp}`, {
        method: 'POST',
        body: cuerpo,
    });
    const resp = await p.json().catch(() => null);
    if (!p.ok || !resp?.success) {
        mal(`Meta rechazó la actualización (${p.status}): ${resp?.error?.message || 'sin detalle'}`);
        process.exit(1);
    }
    bien(`Añadidos: ${faltan.join(', ')}. Campos ahora: ${campos}\n`);
}

main().catch((e) => {
    mal(e.message);
    process.exit(1);
});
