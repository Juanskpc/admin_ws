/**
 * Firma del webhook de Meta — lo único que separa un mensaje de un cliente de uno inventado (F8-A).
 *
 * ## Por qué esto es la pieza crítica del canal
 *
 * El WebChat no está autenticado y se acepta a sabiendas: está apagado y su único daño posible es
 * escribirle al asistente de un negocio (ADR-016, decisión abierta 9). WhatsApp es otra cosa: la
 * URL del webhook es pública, y sin verificar la firma **cualquiera puede POSTear un mensaje que
 * el sistema atribuirá a un cliente real**. Con F7 encima, ese mensaje puede acabar en una
 * confirmación de cancelación. La firma no es una capa más de seguridad: es *la* autenticación de
 * este canal.
 *
 * ## Las tres cosas que hay que hacer bien
 *
 * 1. **HMAC-SHA256 sobre el cuerpo CRUDO**, con el App Secret. Sobre el crudo y no sobre el JSON
 *    reparseado: `express.json()` lee, parsea y **descarta los bytes**, y volver a serializar
 *    produce otros bytes —otro orden de claves, otro espaciado, otro escapado de Unicode— así que
 *    la firma no casa. Es la trampa que el master-plan anticipó, y la razón de que este canal
 *    obligue a un cambio en la composición del servidor y no solo en el gateway.
 * 2. **Comparación en tiempo constante** (`crypto.timingSafeEqual`). Un `===` filtra por cuánto
 *    tarda en fallar cuántos bytes iniciales acertó quien lo intenta.
 * 3. **Sin secreto, no se acepta nada.** Nunca «si no hay App Secret, pasa» — ése es el modo de
 *    fallo que convierte una configuración a medias en un endpoint abierto.
 */
'use strict';
const crypto = require('crypto');

const CABECERA = 'x-hub-signature-256';
const PREFIJO = 'sha256=';

/**
 * @param {Buffer|string} cuerpoCrudo — los bytes exactos que llegaron.
 * @param {string} secreto — el App Secret de la app de Meta.
 * @returns {string} la firma esperada, con su prefijo, tal como la manda Meta.
 */
function calcular(cuerpoCrudo, secreto) {
    const hmac = crypto.createHmac('sha256', secreto);
    hmac.update(Buffer.isBuffer(cuerpoCrudo) ? cuerpoCrudo : Buffer.from(String(cuerpoCrudo), 'utf8'));
    return `${PREFIJO}${hmac.digest('hex')}`;
}

/**
 * ¿La firma de esta petición es de Meta?
 *
 * @param {Object} opciones
 * @param {Buffer|string} opciones.cuerpoCrudo
 * @param {string} [opciones.firma] — el valor de la cabecera `X-Hub-Signature-256`.
 * @param {string} [opciones.secreto]
 * @returns {{valida: boolean, motivo: string|null}} — el motivo se audita, no se le devuelve a
 *          quien llamó: decirle a un atacante *por qué* falló su firma es ayudarle.
 */
function verificar({ cuerpoCrudo, firma, secreto }) {
    if (!secreto) return { valida: false, motivo: 'SIN_APP_SECRET' };
    if (!firma || typeof firma !== 'string') return { valida: false, motivo: 'SIN_FIRMA' };
    if (!firma.startsWith(PREFIJO)) return { valida: false, motivo: 'FIRMA_SIN_PREFIJO' };
    if (cuerpoCrudo === undefined || cuerpoCrudo === null) {
        // Llegar aquí significa que la rama de parseo crudo no está montada, no que la firma sea
        // mala. Se distingue porque el arreglo es completamente distinto: uno es composición del
        // servidor, el otro es un secreto mal puesto.
        return { valida: false, motivo: 'SIN_CUERPO_CRUDO' };
    }

    const esperada = calcular(cuerpoCrudo, secreto);
    const a = Buffer.from(esperada, 'utf8');
    const b = Buffer.from(firma, 'utf8');

    // `timingSafeEqual` exige longitudes iguales, y comparar las longitudes antes ya filtra sin
    // revelar nada útil: la longitud de un HMAC-SHA256 en hexadecimal es siempre la misma.
    if (a.length !== b.length) return { valida: false, motivo: 'FIRMA_LONGITUD' };

    return crypto.timingSafeEqual(a, b)
        ? { valida: true, motivo: null }
        : { valida: false, motivo: 'FIRMA_NO_COINCIDE' };
}

module.exports = { verificar, calcular, CABECERA, PREFIJO };
