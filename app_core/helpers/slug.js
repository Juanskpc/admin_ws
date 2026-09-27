'use strict';

/**
 * Identificador corto y legible de un negocio, para URLs con su propia identidad
 * (`<slug>.escalapp.cloud`) en vez del genérico `/reserva/p/:id_negocio`.
 *
 * Vive en `general.gener_negocio.slug`, no en el vertical: como el logo y los colores, es
 * identidad del negocio, no de un módulo (ver `migrate_reserva_marca.js`).
 */

/** Palabras que ya son parte de la infraestructura — un negocio no puede quedarse con ellas. */
const RESERVADOS = new Set([
    'www', 'api', 'admin', 'app', 'mail', 'ftp', 'ns1', 'ns2', 'cdn', 'static', 'assets',
    'reserva', 'restaurante', 'parqueadero', 'gym', 'tienda', 'general',
]);

/**
 * `Dalex Barbería & Spa` → `dalex-barberia-spa`. Minúsculas, sin tildes, solo `[a-z0-9-]`, sin
 * guiones repetidos ni al borde. Cadena vacía si no queda nada usable (un nombre solo de
 * símbolos o emojis).
 */
function slugificar(texto) {
    return String(texto ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')   // tildes fuera, letra intacta
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50)
        .replace(/-+$/g, '');   // el `slice` puede dejar un guion colgando al cortar
}

/** ¿Es una forma válida de slug? Lo que ya pasó por `slugificar` siempre lo es; esto valida lo que escribe un dueño a mano. */
function esSlugValido(valor) {
    return typeof valor === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/.test(valor);
}

/**
 * Slug único para un negocio nuevo o sin slug, a partir de su nombre.
 *
 * Prueba el slug base y, si está tomado, `-2`, `-3`… `existe(candidato)` es quien pregunta —una
 * consulta a `gener_negocio` en producción, o una comprobación en memoria durante el backfill de
 * la migración— así que esta función no sabe nada de Sequelize.
 */
async function generarSlugUnico(nombre, existe) {
    const base = slugificar(nombre) || 'negocio';
    const raiz = RESERVADOS.has(base) ? `${base}-negocio` : base;

    let candidato = raiz;
    let sufijo = 2;
    // 200 intentos es una barbaridad para un choque de nombres reales; el límite es solo para
    // que un error en `existe` (que siempre diga «sí existe») no cuelgue la petición para siempre.
    for (let i = 0; i < 200; i += 1) {
        if (!(await existe(candidato))) return candidato;
        candidato = `${raiz}-${sufijo}`;
        sufijo += 1;
    }
    // Última salida: un sufijo aleatorio, para no dejar nunca un registro sin crear por esto.
    return `${raiz}-${Date.now().toString(36).slice(-5)}`;
}

module.exports = { slugificar, esSlugValido, generarSlugUnico, RESERVADOS };
