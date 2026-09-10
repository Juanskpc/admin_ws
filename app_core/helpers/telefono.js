/**
 * Normalización de teléfonos a E.164.
 *
 * IMPORTANTE: esta lógica está duplicada en SQL en dos sitios y las tres copias deben
 * decir lo mismo para Colombia. Si cambia una, cambian todas:
 *   - migrations/migrate_platform_backfill_restaurante.js  (backfill histórico)
 *   - scripts/medir_calidad_telefonos.js                   (medición)
 *   - este archivo                                         (camino de escritura)
 *
 * La duplicación es deliberada: las migraciones deben poder ejecutarse sin cargar la
 * aplicación, y son la definición de "qué es un teléfono utilizable" para el backfill.
 *
 * ## El país dejó de ser una constante (2026-09-09)
 *
 * Durante año y medio esto solo supo de Colombia, y no se notaba porque todos los negocios lo
 * eran. El primer cliente de reserva es chileno, y el fallo que eso destapa es del tipo peor:
 * devolver `null` es un resultado **legítimo** («este teléfono no sirve»), así que un móvil
 * chileno perfectamente válido no producía ningún error —simplemente la cita se guardaba sin
 * enlazar con la ficha del cliente y el recordatorio no salía—. Por eso el país se guarda ahora
 * en `general.gener_negocio.pais` (migrate:pais-negocio) y viaja hasta aquí.
 *
 * `normalizarE164Colombia` se conserva como envoltorio: los sitios que hoy solo atienden negocios
 * colombianos —los adaptadores de Intelligence— siguen llamándola y su comportamiento no cambia
 * ni un caso.
 */

/**
 * Qué es un móvil en cada país que atendemos.
 *
 * Solo móviles: el objetivo del número es poder escribirle por WhatsApp, así que un fijo es
 * tan inservible como un número mal escrito. Añadir un país es añadir una fila aquí.
 *
 *   `cc`      prefijo internacional, sin el '+'
 *   `largo`   dígitos del número nacional
 *   `movil`   con qué dígito empieza un móvil
 *   `trunk`   prefijo nacional que la gente escribe de más y hay que quitar (null si no se usa)
 */
const PAISES = {
    CO: { cc: '57', largo: 10, movil: '3', trunk: '0' },
    CL: { cc: '56', largo: 9,  movil: '9', trunk: null },
};

const PAIS_POR_DEFECTO = 'CO';

/**
 * Convierte un teléfono capturado en un formulario a E.164.
 *
 * Acepta los formatos que aparecen en producción para el país dado: '3001112233',
 * '300 111 2233', '+57 300 111 2233', '573001112233', '03001112233' en Colombia;
 * '912345678', '+56 9 1234 5678', '56912345678' en Chile. Todos resuelven al mismo valor.
 *
 * Rechaza (devolviendo null) lo que no es un móvil utilizable: fijos, números demasiado
 * cortos, dígitos repetidos y cualquier otra basura. Devolver null es un resultado válido y
 * esperado — el 5.2% de los teléfonos capturados cae aquí.
 *
 * Un número que ya viene con el prefijo de **otro** país también da null, y es lo correcto:
 * el negocio chileno que apunte un número argentino no puede escribirle por su canal, y
 * fingir que sí es peor que decir que no. Ese caso se atiende cuando exista, no antes.
 *
 * @param {string|null|undefined} valor
 * @param {string} [pais] — ISO 3166-1 alfa-2. Por defecto Colombia, que es lo que había.
 * @returns {string|null} '+573001112233' / '+56912345678', o null si no es un móvil válido.
 */
function normalizarE164(valor, pais = PAIS_POR_DEFECTO) {
    if (valor === null || valor === undefined) return null;

    const reglas = PAISES[String(pais || PAIS_POR_DEFECTO).toUpperCase()];
    if (!reglas) return null;

    const digitos = String(valor).replace(/\D/g, '');
    if (!digitos) return null;

    let nacional = digitos;
    if (digitos.length === reglas.cc.length + reglas.largo && digitos.startsWith(reglas.cc)) {
        nacional = digitos.slice(reglas.cc.length);
    } else if (reglas.trunk && digitos.length === reglas.largo + 1 && digitos.startsWith(reglas.trunk)) {
        nacional = digitos.slice(1);
    }

    if (nacional.length !== reglas.largo || !nacional.startsWith(reglas.movil)) return null;

    // Dígito repetido: 0000000000, 3333333333, etc.
    if (/^(.)\1+$/.test(nacional)) return null;

    return `+${reglas.cc}${nacional}`;
}

/**
 * Envoltorio histórico. Idéntico a `normalizarE164(valor, 'CO')`.
 */
function normalizarE164Colombia(valor) {
    return normalizarE164(valor, 'CO');
}

/** Los países que sabemos normalizar. Para validar entradas antes de guardarlas. */
function paisesSoportados() {
    return Object.keys(PAISES);
}

module.exports = { normalizarE164, normalizarE164Colombia, paisesSoportados };
