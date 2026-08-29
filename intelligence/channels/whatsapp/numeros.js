/**
 * Qué número atiende a qué negocio, en las dos direcciones (F8-C, puntos 4 y 5).
 *
 * ## Por qué hay una caché y no una consulta
 *
 * `interpretarWebhook()` es **una función pura** —lo dice su cabecera y sus pruebas dependen de
 * ello: se verifica con cargas reales de Meta sin levantar base ni red—. Si la traducción
 * «número → negocio» pasara a ser una consulta, esa función tendría que volverse asíncrona y
 * tocar la base, y se perdería la mitad del canal que hoy se puede probar de verdad.
 *
 * Así que la tabla se lee **antes**, en `recibirWebhook()`, que ya es asíncrono y ya toca la base;
 * y la traducción sigue siendo una lectura de memoria. La caché no es una optimización: es lo que
 * mantiene la costura donde estaba.
 *
 * ## El respaldo por variables de entorno no es transitorio
 *
 * Si la tabla está vacía se usa el par del `.env`. Eso hace que el cambio **no tenga corte** —un
 * despliegue sin migrar sigue funcionando igual— y que un entorno de desarrollo pueda apuntar un
 * número sin tocar la base. Cuando hay filas, mandan las filas.
 *
 * ## El token no está aquí, y es una decisión
 *
 * Un token de usuario de sistema **cubre la WABA entera**, no un número. Mientras todos los
 * números cuelguen de nuestra WABA, el mismo token sirve para todos y lo único que cambia es el
 * `phone_number_id`. Guardar un token por negocio sería guardar el mismo secreto N veces. Con
 * *Embedded Signup* —cada cliente con su WABA— eso cambia; hasta entonces, no.
 */
'use strict';

const Models = require('../../../app_core/models/conection');

const CANAL = 'whatsapp';

/**
 * Cuánto vale la caché. Un minuto es el retardo con el que un número recién conectado empieza a
 * atender, y a cambio el webhook no consulta la base en cada mensaje.
 *
 * No se recarga «cuando falla una búsqueda»: eso convertiría un webhook ajeno —o hostil— en una
 * consulta a la base por mensaje.
 */
const TTL_MS = 60_000;

let porNumero = new Map(); // phone_number_id → id_negocio
let porNegocio = new Map(); // id_negocio → { idExterno, numeroE164 }
let cargadoEn = 0;
let deLaTabla = false;

function desdeEntorno() {
    const idExterno = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const idNegocio = process.env.WHATSAPP_NEGOCIO_ID;
    if (!idExterno || !idNegocio) return [];
    return [
        {
            id_externo: String(idExterno),
            id_negocio: Number(idNegocio),
            numero_e164: process.env.WHATSAPP_NUMBER || null,
        },
    ];
}

function reconstruir(filas) {
    porNumero = new Map();
    porNegocio = new Map();
    for (const f of filas) {
        porNumero.set(String(f.id_externo), Number(f.id_negocio));
        // El primero gana. El único parcial de la tabla ya impide que haya dos activos por
        // negocio, así que esto solo importa con el respaldo del entorno.
        if (!porNegocio.has(Number(f.id_negocio))) {
            porNegocio.set(Number(f.id_negocio), {
                idExterno: String(f.id_externo),
                numeroE164: f.numero_e164 || null,
            });
        }
    }
}

/** ¿Existe la tabla? En un entorno sin migrar, no — y eso no es un fallo. */
async function hayTabla() {
    const filas = await Models.sequelize.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'platform' AND table_name = 'numero_canal' LIMIT 1;`,
        { type: Models.sequelize.QueryTypes.SELECT }
    );
    return filas.length > 0;
}

/**
 * Deja la caché utilizable. Se llama desde donde ya se puede esperar: el arranque y
 * `recibirWebhook()`.
 *
 * Un fallo al leer la tabla **no tumba el canal**: se sigue con lo que hubiera cargado, o con el
 * entorno. Quedarse sin atender a nadie porque la base tardó es peor que atender con un mapa de
 * hace un minuto.
 */
async function asegurarCargado({ forzar = false } = {}) {
    if (!forzar && Date.now() - cargadoEn < TTL_MS && (porNumero.size > 0 || cargadoEn > 0)) {
        return;
    }

    try {
        if (await hayTabla()) {
            const filas = await Models.sequelize.query(
                `SELECT id_externo, id_negocio, numero_e164
                   FROM platform.numero_canal
                  WHERE canal = :canal AND estado = 'A'
                  ORDER BY id_negocio;`,
                { replacements: { canal: CANAL }, type: Models.sequelize.QueryTypes.SELECT }
            );
            if (filas.length > 0) {
                reconstruir(filas);
                deLaTabla = true;
                cargadoEn = Date.now();
                return;
            }
        }
        reconstruir(desdeEntorno());
        deLaTabla = false;
        cargadoEn = Date.now();
    } catch (error) {
        console.error('[whatsapp] no se pudo leer platform.numero_canal:', error.message);
        if (porNumero.size === 0) reconstruir(desdeEntorno());
        cargadoEn = Date.now();
    }
}

/**
 * Traduce el número de Meta al negocio de EscalApp. **Síncrona a propósito** — ver la cabecera.
 *
 * Devuelve `null` si no es nuestro número, y el webhook lo trata como lo que es: tráfico que no
 * nos corresponde. No se adivina el negocio ni se cae en un valor por defecto: un webhook mal
 * enrutado escribiría en la conversación de otro inquilino, que es la fuga que F2 cerró.
 */
function negocioDe(phoneNumberId) {
    if (!phoneNumberId) return null;
    return porNumero.get(String(phoneNumberId)) ?? null;
}

/**
 * Y la dirección contraria: desde qué número contesta este negocio.
 *
 * Es el punto 6 de F8-C, «el cambio que más fácil se olvida y el que peor falla»: sin él, el bot
 * de un cliente contesta desde el número de otro. Devuelve `null` si el negocio no tiene número, y
 * quien envía debe negarse — mandar «por el que haya» es justo el fallo.
 */
function numeroDe(idNegocio) {
    if (!idNegocio) return null;
    return porNegocio.get(Number(idNegocio))?.idExterno ?? null;
}

/** Lo que hay cargado, para el log de arranque y el diagnóstico. */
function listar() {
    return {
        origen: deLaTabla ? 'platform.numero_canal' : 'variables de entorno',
        numeros: [...porNegocio.entries()].map(([idNegocio, n]) => ({
            id_negocio: idNegocio,
            id_externo: n.idExterno,
            numero_e164: n.numeroE164,
        })),
    };
}

/** Solo para pruebas: vacía la caché para que la siguiente lectura vuelva a la base. */
function _reiniciar() {
    porNumero = new Map();
    porNegocio = new Map();
    cargadoEn = 0;
    deLaTabla = false;
}

module.exports = { asegurarCargado, negocioDe, numeroDe, listar, CANAL, TTL_MS, _reiniciar };
