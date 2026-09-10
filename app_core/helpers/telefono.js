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
 * ## De dónde salen las reglas (2026-09-10)
 *
 * Qué es un móvil en cada país ya no se decide aquí: vive en `app_core/helpers/paises.js`,
 * junto a la moneda de ese mismo país. El motivo es que al llegar la moneda hacían falta las
 * dos cosas del mismo sitio, y dos listas de países se desincronizan solas. **Añadir un país
 * es añadir una fila allí**, y con ella llegan su prefijo y su moneda a la vez.
 */
const { PAISES: CATALOGO, PAIS_POR_DEFECTO } = require('./paises');

/** Solo la parte telefónica del catálogo, que es lo único que mira este archivo. */
const PAISES = Object.fromEntries(
    Object.entries(CATALOGO).map(([codigo, info]) => [codigo, info.telefono]),
);

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

    // Se quita el prefijo internacional si viene, y si no, el nacional. Los prefijos
    // alternativos (`cc_alt`) existen para el `1` que México arrastra de WhatsApp: se acepta
    // al leer, pero el número se guarda siempre en la forma canónica de `cc`.
    let nacional = digitos;
    const prefijos = [reglas.cc, ...(reglas.cc_alt || [])];
    const internacional = prefijos.find(
        (p) => digitos.length === p.length + reglas.largo && digitos.startsWith(p),
    );
    if (internacional) {
        nacional = digitos.slice(internacional.length);
    } else if (reglas.trunk && digitos.length === reglas.largo + 1 && digitos.startsWith(reglas.trunk)) {
        nacional = digitos.slice(1);
    }

    if (nacional.length !== reglas.largo) return null;
    // `movil: null` = el país no distingue móvil de fijo por el primer dígito (México). Filtrar
    // ahí por un dígito inventado descartaría números buenos, que es el fallo caro.
    if (reglas.movil && !reglas.movil.some((d) => nacional.startsWith(d))) return null;

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
