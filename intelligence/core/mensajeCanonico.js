/**
 * Mensaje Canónico (ADR-017) — la representación interna con la que trabaja el núcleo.
 *
 * Vive en `core/` y no en `channels/` a propósito: **no es de nadie en particular**. Es el
 * formato del Conversation Engine, y cada adaptador de canal traduce hacia y desde él. Si
 * viviera junto a los adaptadores, el primer canal acabaría dictando su forma.
 *
 * ## Por qué esto importa más que la mayoría de los módulos
 *
 * ADR-017 avisa: «cambiar de Mensaje Canónico sería tocar todos los adaptadores a la vez, así
 * que su forma debe elegirse con cuidado y evolucionar de forma **aditiva**». Hoy hay un solo
 * canal y cambiarlo es gratis; con WhatsApp y voz detrás, deja de serlo.
 *
 * ## Salida: texto y `opciones[]`, nunca marcado de un canal
 *
 * Una respuesta se expresa en abstracto. **El núcleo no sabe cómo se pinta una opción**: en
 * WhatsApp puede ser un botón, en el WebChat un chip, en voz una enumeración hablada. Lo que
 * no puede pasar es que aquí aparezca un `\n1) …\n2) …` ya formateado, porque entonces el
 * formato de un canal se habría filtrado al núcleo y los demás heredarían su forma.
 *
 * Una opción es `{ id, etiqueta, detalle? }`. El `detalle` llegó en F8-A y es el ejemplo de la
 * evolución aditiva que este ADR pide: WhatsApp recorta el título de un botón a 20 caracteres y
 * «Corte de cabello (30 min) — $35.000» perdía justo el precio. Separar el nombre de su detalle no
 * le enseña al núcleo qué es un botón: le permite decir qué es lo importante y qué es el resto.
 *
 * El riesgo declarado en el ADR es el contrario —el **mínimo común denominador**, quedarse en
 * lo que soportan *todos* los canales—, y se mitiga dejando que cada adaptador aproveche lo
 * que su canal sepa hacer, siempre que degrade con gracia donde no exista.
 */
'use strict';

/** Cuánto puede desviarse `enviadoEn` de la hora del servidor antes de dejar de creérselo. */
const DESVIO_MAXIMO_MS = 60 * 60 * 1000;

/** Tope de texto de un mensaje entrante. Más allá es abuso, no conversación. */
const MAX_TEXTO = 4000;

function error(codigo, mensaje) {
    const e = new Error(mensaje);
    e.code = codigo;
    e.statusCode = 400;
    return e;
}

/**
 * Marca de tiempo del canal, saneada.
 *
 * Se acepta solo si cae dentro de una ventana razonable alrededor de ahora. La razón es que
 * **este valor ordena la conversación**: con él se reconstruye el orden real de una ráfaga
 * que llegó desordenada. Un canal con el reloj mal, o un cliente que la manipule, podría
 * colar un mensaje delante de otro que no le corresponde. Fuera de la ventana se descarta y
 * el motor cae en la hora de llegada, que es peor pero es nuestra.
 *
 * @returns {Date|null}
 */
function sanearEnviadoEn(valor) {
    if (!valor) return null;
    const fecha = valor instanceof Date ? valor : new Date(valor);
    if (Number.isNaN(fecha.getTime())) return null;

    const desvio = Math.abs(Date.now() - fecha.getTime());
    return desvio <= DESVIO_MAXIMO_MS ? fecha : null;
}

/**
 * Normaliza y valida un mensaje **entrante** traducido por un adaptador.
 *
 * @param {Object} mensaje
 * @param {string} mensaje.canal
 * @param {number} mensaje.idNegocio
 * @param {string} mensaje.idExterno       — quién habla, del lado del canal.
 * @param {string} mensaje.texto
 * @param {string} [mensaje.idExternoMensaje] — id del mensaje EN EL CANAL. Sin él no hay
 *                 deduplicación posible y una reentrega se procesa dos veces.
 * @param {Date|string} [mensaje.enviadoEn]  — cuándo lo envió la persona, según el canal.
 * @param {Object} [mensaje.crudo]           — lo que el canal traía y esto no representa.
 */
function normalizarEntrada(mensaje) {
    const { canal, idNegocio, idExterno, texto, idExternoMensaje, enviadoEn, crudo } = mensaje || {};

    if (!canal || typeof canal !== 'string') {
        throw error('CANAL_INVALIDO', 'El mensaje canónico necesita un canal.');
    }
    if (!Number.isInteger(idNegocio) || idNegocio <= 0) {
        throw error('NEGOCIO_INVALIDO', 'El mensaje canónico necesita un id_negocio válido.');
    }
    if (!idExterno || typeof idExterno !== 'string') {
        throw error('INTERLOCUTOR_INVALIDO', 'El mensaje canónico necesita saber quién habla.');
    }
    if (typeof texto !== 'string' || texto.trim().length === 0) {
        throw error('TEXTO_VACIO', 'Un mensaje entrante sin texto no es un mensaje.');
    }
    if (texto.length > MAX_TEXTO) {
        throw error('TEXTO_DEMASIADO_LARGO', `El texto supera los ${MAX_TEXTO} caracteres.`);
    }

    return {
        canal,
        idNegocio,
        idExterno: String(idExterno).slice(0, 200),
        idExternoMensaje: idExternoMensaje ? String(idExternoMensaje).slice(0, 200) : null,
        texto,
        enviadoEn: sanearEnviadoEn(enviadoEn),
        crudo: crudo && typeof crudo === 'object' ? crudo : null,
    };
}

/**
 * Normaliza una respuesta a la forma canónica de salida.
 *
 * Acepta una cadena suelta porque es lo que devuelve un manejador que solo tiene texto que
 * decir, y obligarle a envolverla no compra nada.
 *
 * @param {string|{texto: string, opciones?: Array}} respuesta
 * @returns {{texto: string, opciones: Array<{id: string, etiqueta: string}>}}
 */
function normalizarSalida(respuesta) {
    const bruto = typeof respuesta === 'string' ? { texto: respuesta } : respuesta || {};

    if (typeof bruto.texto !== 'string' || bruto.texto.length === 0) {
        throw error('RESPUESTA_SIN_TEXTO', 'Una respuesta canónica necesita texto.');
    }

    const opciones = (bruto.opciones || []).map((opcion, i) => {
        const id = opcion?.id ?? String(i + 1);
        const etiqueta = opcion?.etiqueta ?? opcion?.texto;
        if (typeof etiqueta !== 'string' || etiqueta.length === 0) {
            throw error('OPCION_SIN_ETIQUETA', 'Cada opción necesita una etiqueta.');
        }
        // `detalle` es opcional y es la evolución aditiva que ADR-017 permite (F8-A). Nació de un
        // problema real del canal: WhatsApp recorta el título de un botón a 20 caracteres, así que
        // «Corte de cabello (30 min) — $35.000» llegaba como «Corte de cabello (3…» y el precio
        // —lo que el cliente quiere saber— desaparecía. Partirlo en nombre y detalle deja que cada
        // canal decida: la lista de WhatsApp pinta el detalle debajo, el chip del WebChat al lado,
        // y la voz lo leería después. El núcleo sigue sin saber cómo se pinta ninguno.
        const detalle = opcion?.detalle;
        return {
            id: String(id),
            etiqueta,
            ...(typeof detalle === 'string' && detalle.length > 0 ? { detalle } : {}),
        };
    });

    return { texto: bruto.texto, opciones };
}

module.exports = {
    DESVIO_MAXIMO_MS,
    MAX_TEXTO,
    sanearEnviadoEn,
    normalizarEntrada,
    normalizarSalida,
};
