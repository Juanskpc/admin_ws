/**
 * Widget del WebChat hostil (F5-C).
 *
 * ## Por qué esto es un archivo aparte y no un `<script>` en el HTML
 *
 * Vivía inline dentro de `index.html` y **el navegador nunca lo ejecutó**: `app.js` monta Helmet
 * con su política por defecto, que incluye `script-src 'self'`, así que Chrome bloqueaba el
 * bloque entero. El widget se pintaba —el HTML y el CSS sí cargan, y `style-src` de Helmet sí
 * admite `'unsafe-inline'`— pero no corría una línea de JS: el campo de texto no enviaba nada y
 * el hilo se quedaba vacío para siempre. Un `curl` contra la API funcionaba, que es justo lo que
 * hacía el fallo tan difícil de ver.
 *
 * Sirviéndolo desde `publico/` es del mismo origen, así que `'self'` lo permite **sin tocar el
 * CSP de toda la plataforma**. Aflojar la política global (`'unsafe-inline'`) o meter un hash a
 * mano habría sido cambiar la seguridad del backend entero para acomodar una página de pruebas.
 *
 * No devuelvas este código al HTML.
 */

const API = location.pathname.replace(/\/webchat\/?$/, '');
const $ = (s) => document.querySelector(s);
const hilo = $('#hilo');

let sesion = localStorage.getItem('webchat_sesion');
if (!sesion) {
    sesion = 'wc-' + crypto.randomUUID().slice(0, 8);
    localStorage.setItem('webchat_sesion', sesion);
}
$('#sesion').textContent = sesion;
const negocio = () => Number($('#negocio').value || 1);

let cursor = 0;

function pintar(clase, texto, opciones) {
    const div = document.createElement('div');
    div.className = 'msg ' + clase;
    div.textContent = texto;
    if (opciones && opciones.length) {
        const caja = document.createElement('div');
        caja.className = 'opciones';
        // ADR-017: el núcleo manda opciones en abstracto y CADA canal las renderiza. Aquí son
        // chips; en WhatsApp serían botones nativos; en voz, una enumeración hablada.
        for (const o of opciones) {
            const b = document.createElement('button');
            // El chip los pinta juntos: aquí caben. `detalle` viaja aparte desde F8-A porque
            // WhatsApp recorta el título de un botón a 20 caracteres y se comía el precio; el
            // WebChat no tiene ese límite, así que su renderizado no cambia.
            b.textContent = o.detalle ? `${o.etiqueta} (${o.detalle})` : o.etiqueta;
            // Se manda el `id`, no la etiqueta, y se pinta la etiqueta. Mandar la etiqueta
            // tiraba justo el dato que ADR-017 pone ahí para esto, y el motor tenía que
            // adivinar: de «Corte de cabello (30 min) — $35.000» sacaba el servicio 30.
            b.onclick = () => enviar(o.id, o.etiqueta);
            caja.appendChild(b);
        }
        div.appendChild(caja);
    }
    hilo.appendChild(div);
    hilo.scrollTop = hilo.scrollHeight;
}

/**
 * @param {string} texto    — lo que viaja al backend (el `id` de la opción, si vino de un chip).
 * @param {string} [visible] — lo que lee la persona. Se separan porque el canal habla en ids y
 *                             la pantalla en etiquetas; mezclarlos fue el bug del servicio 30.
 */
async function enviar(texto, visible) {
    pintar('yo', visible || texto);
    const r = await fetch(API + '/webchat/mensajes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id_negocio: negocio(),
            id_sesion: sesion,
            texto,
            // El id lo pone el cliente: es lo que permite deduplicar una reentrega.
            id_mensaje: 'c-' + crypto.randomUUID(),
            enviado_en: new Date().toISOString(),
        }),
    });
    const cuerpo = await r.json().catch(() => ({}));
    if (!r.ok) {
        pintar('sis', '✗ ' + (cuerpo.message || r.status));
        return;
    }
    // 202: acuse, NO la respuesta del bot. Esa llega por el sondeo de abajo.
    if (cuerpo.data && cuerpo.data.recibidos === 0) pintar('sis', '· retenido por el simulador');
    if (cuerpo.data && cuerpo.data.recibidos > 1)
        pintar('sis', '· el canal lo entregó ' + cuerpo.data.recibidos + ' veces');
}

async function sondear() {
    try {
        const url =
            API +
            '/webchat/mensajes?id_negocio=' +
            negocio() +
            '&id_sesion=' +
            encodeURIComponent(sesion) +
            '&desde=' +
            cursor;
        const r = await fetch(url);
        if (!r.ok) return;
        const { data } = await r.json();
        for (const m of data.mensajes) pintar('bot', m.texto, m.opciones);
        cursor = data.cursor;
    } catch {
        /* el sondeo no se queja: vuelve a intentarlo en un segundo */
    }
}

$('#envio').onsubmit = (e) => {
    e.preventDefault();
    const texto = $('#texto').value.trim();
    if (!texto) return;
    $('#texto').value = '';
    enviar(texto);
};

async function configurarSimulador() {
    const cuerpo = { id_negocio: negocio(), id_sesion: sesion };
    for (const el of document.querySelectorAll('[data-fallo]')) {
        cuerpo[el.dataset.fallo] = el.type === 'checkbox' ? el.checked : Number(el.value);
    }
    const r = await fetch(API + '/webchat/simulador', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
    });
    const { data } = await r.json().catch(() => ({ data: null }));
    if (data && data.soltado) pintar('sis', '· se soltó el mensaje retenido: "' + data.soltado + '"');
}
for (const el of document.querySelectorAll('[data-fallo]')) el.onchange = configurarSimulador;

$('#rafaga').onclick = async () => {
    for (const t of ['hola', 'quiero cita', 'para mañana', 'con Laura', 'gracias']) {
        await enviar(t);
        await new Promise((r) => setTimeout(r, 400));
    }
};

$('#limpiar').onclick = () => {
    localStorage.removeItem('webchat_sesion');
    location.reload();
};

setInterval(sondear, 1000);
