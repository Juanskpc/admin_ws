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
 * ## El token, desde Embedded Signup (F8-D)
 *
 * Un token de usuario de sistema **cubre la WABA entera**, no un número. Mientras un negocio
 * cuelgue de NUESTRA WABA (`origen = 'manual'`), el token global sirve y no hace falta guardar
 * nada por fila. Desde que existe Embedded Signup, un negocio puede traer su propia WABA
 * (`origen = 'embedded_signup'`) con su propio token — ese sí se guarda aquí, cifrado en la base
 * y descifrado solo al cargarlo en esta caché (nunca en cada envío: el TTL de 60s ya amortigua
 * eso, igual que amortigua la lectura de `platform.numero_canal`).
 */
'use strict';

const Models = require('../../../app_core/models/conection');
const { descifrar } = require('../../../app_core/helpers/credencialCifrada');

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
            // Descifrar aquí, no en cada envío: esta función solo se llama una vez por TTL
            // (60s), igual que ya se acepta que el token global viva en claro todo el proceso.
            // Un token corrupto o con la clave equivocada no debe tumbar la carga de TODOS los
            // negocios — se cae a "sin token propio" (usará el global si lo hay) y se loguea.
            let token = null;
            if (f.origen === 'embedded_signup' && f.token_cifrado) {
                try {
                    token = descifrar(f.token_cifrado);
                } catch (error) {
                    console.error(
                        `[whatsapp] no se pudo descifrar el token del negocio ${f.id_negocio}:`,
                        error.message
                    );
                }
            }
            porNegocio.set(Number(f.id_negocio), {
                idExterno: String(f.id_externo),
                numeroE164: f.numero_e164 || null,
                origen: f.origen || 'manual',
                token,
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
                `SELECT id_externo, id_negocio, numero_e164, origen, token_cifrado
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

/**
 * El token propio del negocio, si conectó su número por Embedded Signup. `null` si no tiene uno
 * (alta manual, o no cargó bien) — quien llama debe caer al token global en ese caso, nunca
 * fallar por esto solo.
 */
function tokenDeNegocio(idNegocio) {
    if (!idNegocio) return null;
    return porNegocio.get(Number(idNegocio))?.token ?? null;
}

/** `'manual'` o `'embedded_signup'` — `null` si el negocio no tiene número cargado. */
function origenDeNegocio(idNegocio) {
    if (!idNegocio) return null;
    return porNegocio.get(Number(idNegocio))?.origen ?? null;
}

/** Lo que hay cargado, para el log de arranque y el diagnóstico. */
function listar() {
    return {
        origen: deLaTabla ? 'platform.numero_canal' : 'variables de entorno',
        numeros: [...porNegocio.entries()].map(([idNegocio, n]) => ({
            id_negocio: idNegocio,
            id_externo: n.idExterno,
            numero_e164: n.numeroE164,
            conexion: n.origen,
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

module.exports = {
    asegurarCargado,
    negocioDe,
    numeroDe,
    tokenDeNegocio,
    origenDeNegocio,
    listar,
    CANAL,
    TTL_MS,
    _reiniciar,
};
