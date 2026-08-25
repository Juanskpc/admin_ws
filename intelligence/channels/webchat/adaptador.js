/**
 * Adaptador del canal WebChat (ADR-016, ADR-017) — el primer `ChannelPort`.
 *
 * Traduce en las dos direcciones y **es el único sitio de todo Intelligence que sabe qué es
 * una sesión de WebChat**. El motor solo ve Mensaje Canónico.
 *
 * ## El buzón, y por qué no es un atajo
 *
 * Entregar, para este canal, es dejar el mensaje en un buzón que el widget vacía preguntando
 * («¿hay algo nuevo desde el 7?»). Es en memoria a propósito: modela lo que hace un canal de
 * verdad — entregar es **soltar el mensaje en un sistema ajeno**, que puede tardar o fallar,
 * y a partir de ahí ya no es nuestro. Con WhatsApp, «entregado» significará que Meta lo
 * aceptó, no que alguien lo leyó.
 *
 * De ahí se sigue lo que a primera vista parece un defecto: si el proceso se reinicia, el
 * buzón se vacía. Correcto, y deliberado. Lo que **no** se pierde es la conversación: sigue
 * entera en `intelligence.mensaje`, que es el registro que importa. El buzón es la última
 * milla, no el archivo.
 *
 * ## Renderizado de opciones
 *
 * ADR-017 dice que el núcleo no sabe cómo se pinta una opción. Aquí se pintan como **chips**:
 * el buzón las entrega como datos estructurados y el widget las dibuja como botones. En
 * WhatsApp serán botones nativos; en voz, una enumeración hablada. Ninguno de esos tres
 * formatos aparece en el núcleo.
 */
'use strict';
const motor = require('../../engine/motor');
const simulador = require('./simuladorFallos');

const NOMBRE = 'webchat';

/** Cuántos mensajes guarda el buzón de una sesión antes de tirar los viejos. */
const BUZON_MAXIMO = 200;

/** Map<clave, { secuencia, mensajes: [] }> */
const buzones = new Map();

const clave = (idNegocio, idExterno) => `${idNegocio}:${idExterno}`;

function buzonDe(idNegocio, idExterno) {
    const k = clave(idNegocio, idExterno);
    if (!buzones.has(k)) buzones.set(k, { secuencia: 0, mensajes: [] });
    return buzones.get(k);
}

// ── Entrada: WebChat → Mensaje Canónico ─────────────────────────────────────────────────

/**
 * Traduce lo que manda el widget y se lo pasa al motor.
 *
 * Devuelve **en cuanto está guardado**, sin la respuesta del bot. Es la regla que ADR-016
 * llama «la corrección que cambia la naturaleza del WebChat»: si esto devolviera lo que el
 * bot contesta, no estaríamos probando el motor, estaríamos probando una función.
 *
 * @returns {Promise<Array>} un acuse por cada mensaje que el «canal» acabó entregando —que
 *          puede no ser uno, si el simulador está duplicando o reteniendo.
 */
async function recibirDelWidget({ idNegocio, idSesion, texto, idMensajeCliente, enviadoEn }) {
    const canonico = {
        canal: NOMBRE,
        idNegocio,
        idExterno: idSesion,
        texto,
        // El widget genera el id. Es lo que hace posible deduplicar una reentrega: sin él,
        // dos POST idénticos son dos mensajes distintos y nadie puede saber que no lo eran.
        idExternoMensaje: idMensajeCliente || null,
        enviadoEn: enviadoEn || new Date(),
        crudo: null,
    };

    const aEntregar = simulador.aplicarEntrada(canonico);
    const acuses = [];

    for (const mensaje of aEntregar) {
        acuses.push(await motor.recibir(mensaje));
    }
    return acuses;
}

// ── Salida: Mensaje Canónico → WebChat ──────────────────────────────────────────────────

/**
 * Entrega al buzón de la sesión. La llama el Channel Gateway, no el motor.
 *
 * Idempotente por `idMensaje`: la entrega es «al menos una vez» y una reentrega no debe
 * pintar el mismo globo dos veces en la pantalla.
 */
async function entregar({ idMensaje, idNegocio, idExterno, mensaje }) {
    await simulador.aplicarSalida({ idNegocio, idExterno, idMensaje });

    const buzon = buzonDe(idNegocio, idExterno);
    if (buzon.mensajes.some((m) => m.id_mensaje === idMensaje)) return;

    buzon.mensajes.push({
        seq: ++buzon.secuencia,
        id_mensaje: idMensaje,
        texto: mensaje.texto,
        // Datos, no marcado: el widget decide si son botones, una lista o nada.
        opciones: mensaje.opciones || [],
        entregado_en: new Date().toISOString(),
    });

    if (buzon.mensajes.length > BUZON_MAXIMO) {
        buzon.mensajes.splice(0, buzon.mensajes.length - BUZON_MAXIMO);
    }
}

/**
 * Lo que el widget todavía no ha visto.
 *
 * Con cursor y no «vaciar el buzón» porque el widget puede perder una respuesta HTTP y volver
 * a preguntar: con cursor, repetir la pregunta devuelve lo mismo; vaciando, se habría comido
 * los mensajes sin pintarlos.
 */
function leerDesde(idNegocio, idExterno, desde = 0) {
    const buzon = buzonDe(idNegocio, idExterno);
    const mensajes = buzon.mensajes.filter((m) => m.seq > desde);
    return { mensajes, cursor: buzon.secuencia };
}

function limpiarBuzones() {
    buzones.clear();
}

module.exports = {
    nombre: NOMBRE,
    /**
     * En WebChat el `id_externo` es una sesión de navegador que se inventa el propio cliente: no
     * prueba nada de nadie. Se declara en `false` explícitamente —en vez de omitirlo— porque la
     * diferencia con WhatsApp es de seguridad y merece verse al leer el archivo.
     */
    idExternoEsIdentidad: false,
    NOMBRE,
    entregar,
    recibirDelWidget,
    leerDesde,
    limpiarBuzones,
};
