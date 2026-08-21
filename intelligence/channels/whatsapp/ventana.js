/**
 * La ventana de 24 horas (F8-B) — la regla de negocio más restrictiva de todo el sistema.
 *
 * Meta solo deja escribir texto libre a alguien dentro de las **24 horas** siguientes a su último
 * mensaje. Fuera de eso, únicamente **plantillas pre-aprobadas**. No es una recomendación: la Cloud
 * API rechaza el envío.
 *
 * ## Por qué vive aquí y no en el núcleo
 *
 * [ADR-017](../../../docs/adr/ADR-017-channel-gateway.md) lo dice con estas palabras: «las
 * particularidades de cada canal (**la ventana de 24 h de WhatsApp**, la entrega asíncrona, los
 * metadatos) viven en su adaptador, no en el núcleo». El WebChat no tiene ventana y la voz tampoco.
 * Meterla en el motor sería el primer `if (canal === 'whatsapp')` del núcleo, que es exactamente el
 * canario que F9 va a comprobar.
 *
 * ## Y por qué no hay columna nueva para esto
 *
 * La tentación era añadir `conversacion.ventana_abierta_hasta` y mantenerla al recibir. Se descartó:
 * el dato ya existe —el último entrante está en `intelligence.mensaje`— y una columna derivada es
 * una segunda fuente de verdad que se puede desincronizar en silencio. Lo que sí hacía falta era que
 * la consulta no barriera quince particiones, y eso se resuelve acotando por la **clave de
 * partición** (`creado_en`), no por el dato que se lee.
 *
 * `ultimo_mensaje_en` de la conversación tampoco vale, aunque hoy se parezca: lo escribe
 * `asegurarConversacion` con `now()` —nuestro reloj, no el de Meta— y lo refresca también un
 * **duplicado**, así que un reintento del webhook de un mensaje viejo extendería la ventana. Es la
 * clase de error que no se ve hasta que un mensaje se rechaza en producción.
 *
 * ## De qué instante se cuenta
 *
 * Del que Meta pone en el mensaje (`enviado_en`), no del nuestro (`creado_en`): la ventana la cuenta
 * Meta con su reloj, y nuestro `now()` siempre es posterior —por la red, por un reintento, por una
 * cola—. Creerse el nuestro haría que la ventana pareciera abierta cuando ya está cerrada, que es la
 * dirección peligrosa del error. Por eso se toma el **menor** de los dos: nunca se afirma que la
 * ventana está más abierta de lo que Meta la ve.
 */
'use strict';
const Models = require('../../../app_core/models/conection');
const { numeroDeEntorno } = require('../../engine/cola');

const sequelize = Models.sequelize;

const CONFIG = {
    /** Las 24 h de Meta. Configurable solo para poder cerrarla a voluntad en una prueba. */
    horas: numeroDeEntorno('WHATSAPP_VENTANA_HORAS', 24),
};

/**
 * Cuánto hacia atrás se mira. Acota la consulta a una o dos particiones en vez de a las quince.
 * Es la ventana más un margen: si el último entrante es más viejo que esto, la ventana está
 * cerrada con cualquier reloj y no hace falta saber cuánto.
 */
function margenHoras() {
    return CONFIG.horas + 24;
}

/**
 * ¿Se le puede escribir texto libre a esta conversación ahora mismo?
 *
 * @returns {Promise<{abierta: boolean, ultimoEntranteEn: Date|null, expiraEn: Date|null}>}
 */
async function estado(idConversacion, { ahora = new Date(), transaction = null } = {}) {
    const [fila] = await sequelize.query(
        `
        SELECT max(LEAST(COALESCE(enviado_en, creado_en), creado_en)) AS ultimo
          FROM intelligence.mensaje
         WHERE id_conversacion = :idConversacion
           AND direccion = 'entrante'
           -- Por la clave de partición, que es lo que evita el barrido: el filtro útil es
           -- enviado_en, pero quien poda particiones es creado_en.
           AND creado_en > now() - (:margen || ' hours')::interval;
        `,
        {
            replacements: { idConversacion, margen: String(margenHoras()) },
            transaction,
            type: sequelize.QueryTypes.SELECT,
        }
    );

    const ultimo = fila?.ultimo ? new Date(fila.ultimo) : null;
    if (!ultimo) return { abierta: false, ultimoEntranteEn: null, expiraEn: null };

    const expiraEn = new Date(ultimo.getTime() + CONFIG.horas * 3600 * 1000);
    return { abierta: expiraEn > ahora, ultimoEntranteEn: ultimo, expiraEn };
}

module.exports = { CONFIG, estado };
