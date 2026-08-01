/**
 * Normalización de teléfonos a E.164 colombiano.
 *
 * IMPORTANTE: esta lógica está duplicada en SQL en dos sitios y las tres copias deben
 * decir lo mismo. Si cambia una, cambian todas:
 *   - migrations/migrate_platform_backfill_restaurante.js  (backfill histórico)
 *   - scripts/medir_calidad_telefonos.js                   (medición)
 *   - este archivo                                         (camino de escritura)
 *
 * La duplicación es deliberada: las migraciones deben poder ejecutarse sin cargar la
 * aplicación, y son la definición de "qué es un teléfono utilizable" para el backfill.
 */

const PREFIJO_PAIS = '+57';

/**
 * Convierte un teléfono capturado en un formulario a E.164 colombiano.
 *
 * Acepta los formatos que aparecen en producción: '3001112233', '300 111 2233',
 * '+57 300 111 2233', '573001112233', '03001112233'. Todos resuelven al mismo valor.
 *
 * Rechaza (devolviendo null) lo que no es un móvil colombiano utilizable: fijos,
 * números demasiado cortos, dígitos repetidos y cualquier otra basura. Devolver null
 * es un resultado válido y esperado — el 5.2% de los teléfonos capturados cae aquí.
 *
 * @param {string|null|undefined} valor
 * @returns {string|null} '+573001112233' o null si no es un móvil válido.
 */
function normalizarE164Colombia(valor) {
    if (valor === null || valor === undefined) return null;

    const digitos = String(valor).replace(/\D/g, '');
    if (!digitos) return null;

    let nacional = digitos;
    if (digitos.length === 12 && digitos.startsWith('57')) {
        nacional = digitos.slice(2);
    } else if (digitos.length === 11 && digitos.startsWith('0')) {
        nacional = digitos.slice(1);
    }

    // Móvil colombiano: 10 dígitos empezando en 3.
    if (nacional.length !== 10 || !nacional.startsWith('3')) return null;

    // Dígito repetido: 0000000000, 3333333333, etc.
    if (/^(.)\1+$/.test(nacional)) return null;

    return `${PREFIJO_PAIS}${nacional}`;
}

module.exports = { normalizarE164Colombia };
