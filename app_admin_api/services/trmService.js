'use strict';
/**
 * TRM del día (pesos colombianos por dólar), de la Superintendencia Financiera vía datos.gov.co.
 *
 * Existe para una sola suma: «Terceros» junta OpenAI, que cobra en USD, con Meta, que cobra en
 * COP. Es un indicador para comparar, no una conversión contable: el banco cobra la tarjeta a su
 * propia tasa, con su comisión.
 *
 * Si datos.gov.co no contesta, devuelve `null` y la pantalla enseña cada proveedor en su moneda
 * sin sumarlos — mejor que sumar con una tasa inventada.
 */

const URL_TRM =
    'https://www.datos.gov.co/resource/32sa-8pi3.json?$order=vigenciadesde%20DESC&$limit=1';
const CACHE_MS = 6 * 60 * 60 * 1000;

let cache = null; // { guardadoEn, trm }

async function trmVigente() {
    if (cache && Date.now() - cache.guardadoEn < CACHE_MS) return cache.trm;
    try {
        const r = await fetch(URL_TRM, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return cache?.trm ?? null;
        const [fila] = await r.json();
        const valor = Number(fila?.valor);
        if (!(valor > 0)) return cache?.trm ?? null;
        const trm = { valor, vigente_desde: String(fila.vigenciadesde).slice(0, 10) };
        cache = { guardadoEn: Date.now(), trm };
        return trm;
    } catch {
        // Una TRM vieja es mejor que ninguna para un indicador; si nunca hubo, null.
        return cache?.trm ?? null;
    }
}

module.exports = { trmVigente, _vaciarCache: () => (cache = null) };
