'use strict';
/**
 * Consumo de IA — el gasto OFICIAL de OpenAI y el saldo que queda (vista del super admin).
 *
 * ## Dos fuentes de gasto, y por qué se enseñan las dos
 *
 *  - **Oficial**: `GET /v1/organization/costs` de OpenAI, con `OPENAI_ADMIN_KEY` (clave de
 *    administrador de solo lectura, distinta de `OPENAI_API_KEY`, que es la del bot). Es lo que
 *    OpenAI va a cobrar, y cuenta TODO lo que gasta la organización: el bot, las pruebas, el
 *    computador de otro dev.
 *  - **Interna**: `intelligence.costo`, el Ledger (ADR-022). Solo ve al bot, calculado con los
 *    precios de lista de `intelligence/model/precios.js`, pero sabe de qué negocio y de qué
 *    conversación es cada centavo — cosa que OpenAI no sabe.
 *
 * La diferencia entre las dos es en sí un dato: gasto que no viene del bot.
 *
 * ## Los días son los de Colombia, aunque OpenAI los corte en UTC
 *
 * OpenAI solo entrega los costos por **día UTC** (`bucket_width=1d`, no acepta otro), y ese día
 * se corta a las 7 p. m. de Colombia: lo que el restaurante gastaba de noche salía como gasto
 * «de mañana». Para llevarlo al día de aquí se pide además el **uso por hora**
 * (`/v1/organization/usage/completions`, que sí acepta `1h`) y el costo de cada concepto de cada
 * día se reparte entre sus horas en proporción a los tokens de ese concepto: ver
 * `repartirPorHora`. El total no cambia ni un centavo, solo a qué día se le anota.
 *
 * Si el uso por hora no contesta, el día UTC entero se anota al día de Colombia del mismo
 * nombre (`reparto: 'aproximado'`) y la pantalla lo dice.
 *
 * ## El saldo no existe en la API de OpenAI
 *
 * No hay endpoint oficial para el crédito prepagado. Se reconstruye con lo que el super admin
 * registra en `general.gener_recarga_ia` (ver la migración): último SALDO + RECARGAS
 * posteriores − gasto oficial desde la hora de ese SALDO: ver `calcularSaldo`.
 *
 * ## Caché
 *
 * Los costos de OpenAI se actualizan con horas de retraso, así que preguntar en cada clic no da
 * información nueva y sí gasta su límite de peticiones. Se guardan 10 minutos en memoria; el
 * botón «Actualizar» de la pantalla puede saltársela.
 *
 * No importa `intelligence/`: igual que la Consola, esta vista sigue en pie si se borra ese
 * directorio (test del apagón, ADR-005).
 */

const URL_COSTOS = 'https://api.openai.com/v1/organization/costs';
const URL_USO = 'https://api.openai.com/v1/organization/usage/completions';
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15_000;
/** OpenAI devuelve como mucho 180 cubetas diarias por página. */
const CUBETAS_POR_PAGINA = 180;
/** Tope de páginas: 10 × 180 días = casi 5 años. Evita un bucle si la API se porta raro. */
const MAX_PAGINAS = 10;
/** Y como mucho 168 cubetas de una hora (una semana) por página. */
const HORAS_POR_PAGINA = 168;
/** Cuántas semanas de uso por hora se piden a OpenAI a la vez. */
const SEMANAS_A_LA_VEZ = 8;
const SEG_DIA = 86_400;
const SEG_HORA = 3_600;
/** Colombia no tiene horario de verano: -05:00 todo el año. */
const OFFSET_BOGOTA_SEG = 5 * SEG_HORA;

/**
 * Qué contador de tokens del uso por hora corresponde a cada concepto de la factura
 * (`line_item` = «modelo, concepto»).
 */
const TOKENS_DE_CONCEPTO = {
    input: 'input_uncached_tokens',
    'cached input': 'input_cached_tokens',
    'cache writes': 'input_cache_write_tokens',
    'cache writes - 12hr': 'input_cache_write_12h_tokens',
    output: 'output_tokens',
};

let cache = null; // { desde, guardadoEn, celdas, reparto, consultado_en }

function errorTipado(mensaje, code, statusCode) {
    const err = new Error(mensaje);
    err.code = code;
    err.statusCode = statusCode;
    return err;
}

/** Medianoche UTC (en segundos) del día que contiene `fecha`. Solo para hablar con OpenAI. */
function inicioDiaUtc(fecha) {
    const d = new Date(fecha);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

/** Medianoche de Colombia (en segundos) del día que contiene `fecha`. */
function inicioDiaBogota(fecha = new Date()) {
    const d = new Date(new Date(fecha).getTime() - OFFSET_BOGOTA_SEG * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000 + OFFSET_BOGOTA_SEG;
}

/** Medianoche de Colombia del día 1 del mes en curso, en segundos. */
function inicioMesBogota(fecha = new Date()) {
    const d = new Date(new Date(fecha).getTime() - OFFSET_BOGOTA_SEG * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 + OFFSET_BOGOTA_SEG;
}

/** Un instante (en segundos) → su fecha `YYYY-MM-DD` en Colombia. */
function fechaBogota(seg) {
    return new Date((seg - OFFSET_BOGOTA_SEG) * 1000).toISOString().slice(0, 10);
}

function redondear(valor, decimales = 4) {
    const f = 10 ** decimales;
    return Math.round(Number(valor || 0) * f) / f;
}

async function pedirOpenAI(url, clave, queEs) {
    let respuesta;
    try {
        respuesta = await fetch(url, {
            headers: { Authorization: `Bearer ${clave}` },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (e) {
        throw errorTipado(`No se pudo contactar a OpenAI: ${e.message}`, 'OPENAI_NO_RESPONDE', 502);
    }

    const cuerpo = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) {
        const detalle = cuerpo?.error?.message || `HTTP ${respuesta.status}`;
        const code = respuesta.status === 401 || respuesta.status === 403
            ? 'OPENAI_ADMIN_KEY_RECHAZADA'
            : 'OPENAI_ERROR';
        throw errorTipado(`OpenAI rechazó la consulta de ${queEs}: ${detalle}`, code, 502);
    }
    return cuerpo;
}

/** Los costos por día UTC y concepto, desde `desdeUtcSeg` hasta ahora. */
async function pedirCostosPorDia(desdeUtcSeg, clave) {
    const dias = [];
    let pagina = null;
    for (let n = 0; n < MAX_PAGINAS; n++) {
        const params = new URLSearchParams({
            start_time: String(desdeUtcSeg),
            bucket_width: '1d',
            limit: String(CUBETAS_POR_PAGINA),
        });
        params.append('group_by', 'line_item');
        if (pagina) params.set('page', pagina);

        const cuerpo = await pedirOpenAI(`${URL_COSTOS}?${params}`, clave, 'costos');
        for (const cubeta of cuerpo.data || []) {
            dias.push({
                inicio: cubeta.start_time,
                conceptos: (cubeta.results || []).map((r) => ({
                    concepto: r.line_item || 'Sin detalle',
                    usd: Number(r?.amount?.value || 0),
                })),
            });
        }
        if (!cuerpo.has_more || !cuerpo.next_page) break;
        pagina = cuerpo.next_page;
    }
    return dias;
}

/**
 * Los tokens por hora y modelo, desde `desdeUtcSeg` hasta ahora.
 *
 * OpenAI da una semana por página y las páginas se piden una tras otra: 90 días eran 13
 * peticiones en fila y diez segundos de espera. Se parte en semanas y se piden a la vez.
 */
async function pedirUsoPorHora(desdeUtcSeg, clave) {
    const ahora = Math.floor(Date.now() / 1000);
    const semanas = [];
    for (let ini = desdeUtcSeg; ini < ahora; ini += HORAS_POR_PAGINA * SEG_HORA) {
        semanas.push(ini);
    }

    const pedirSemana = async (ini) => {
        const params = new URLSearchParams({
            start_time: String(ini),
            end_time: String(Math.min(ini + HORAS_POR_PAGINA * SEG_HORA, ahora + SEG_HORA)),
            bucket_width: '1h',
            limit: String(HORAS_POR_PAGINA),
        });
        params.append('group_by', 'model');
        const cuerpo = await pedirOpenAI(`${URL_USO}?${params}`, clave, 'uso por hora');
        return (cuerpo.data || []).flatMap((cubeta) =>
            (cubeta.results || []).map((r) => ({
                inicio: cubeta.start_time,
                modelo: r.model || '',
                tokens: r,
            }))
        );
    };

    const horas = [];
    for (let n = 0; n < semanas.length; n += SEMANAS_A_LA_VEZ) {
        const tanda = await Promise.all(semanas.slice(n, n + SEMANAS_A_LA_VEZ).map(pedirSemana));
        horas.push(...tanda.flat());
    }
    return horas;
}

/**
 * Reparte el costo de cada día UTC entre sus horas.
 *
 * Cada concepto de la factura («gpt-5.6-luna, output») se reparte en proporción a los tokens de
 * ESE concepto y ESE modelo en cada hora. Si no casa con nada (un concepto que no es de texto,
 * o un nombre de modelo que no coincide), en proporción a todos los tokens de la hora; y si ese
 * día no hay uso registrado, al mediodía UTC, que cae en el día de Colombia del mismo nombre.
 *
 * @param {Array<{inicio:number, conceptos:Array<{concepto:string, usd:number}>}>} dias
 * @param {Array<{inicio:number, modelo:string, tokens:object}>|null} horas  `null` = sin uso
 *        por hora: todo va al mediodía UTC.
 * @returns {Array<{inicio:number, concepto:string|null, usd:number}>} celdas por hora.
 */
function repartirPorHora(dias, horas) {
    const celdas = [];
    const horasDeDia = new Map();
    for (const h of horas || []) {
        const dia = inicioDiaUtc(h.inicio * 1000);
        if (!horasDeDia.has(dia)) horasDeDia.set(dia, []);
        horasDeDia.get(dia).push(h);
    }
    const totalTokens = (t) => Number(t.input_tokens || 0) + Number(t.output_tokens || 0);

    for (const dia of dias) {
        const mediodia = dia.inicio + 12 * SEG_HORA;
        // Un día sin gasto también es un dato: que salga en la gráfica como cero.
        celdas.push({ inicio: mediodia, concepto: null, usd: 0 });
        const delDia = horasDeDia.get(dia.inicio) || [];

        for (const { concepto, usd } of dia.conceptos) {
            if (!usd) continue;
            const corte = concepto.lastIndexOf(', ');
            const modelo = corte > 0 ? concepto.slice(0, corte) : null;
            const campo = corte > 0 ? TOKENS_DE_CONCEPTO[concepto.slice(corte + 2)] : null;

            let pesos = campo
                ? delDia
                      .filter((h) => h.modelo === modelo)
                      .map((h) => ({ inicio: h.inicio, peso: Number(h.tokens[campo] || 0) }))
                : [];
            if (!pesos.some((p) => p.peso > 0)) {
                pesos = delDia.map((h) => ({ inicio: h.inicio, peso: totalTokens(h.tokens) }));
            }
            const suma = pesos.reduce((s, p) => s + p.peso, 0);
            if (!(suma > 0)) {
                celdas.push({ inicio: mediodia, concepto, usd });
                continue;
            }
            for (const p of pesos) {
                if (p.peso > 0) celdas.push({ inicio: p.inicio, concepto, usd: (usd * p.peso) / suma });
            }
        }
    }
    return celdas;
}

/**
 * Pide a OpenAI los costos desde `desdeSeg` (una medianoche de Colombia) hasta ahora, por día
 * de Colombia y por concepto (`line_item`, p. ej. «gpt-5.6-luna, input»).
 *
 * @returns {{ por_dia: Array<{fecha:string, usd:number}>,
 *             por_concepto: Array<{concepto:string, usd:number}>,
 *             por_hora: Array<{inicio:number, usd:number}>,
 *             reparto: 'por_hora'|'aproximado',
 *             consultado_en: string }}
 */
async function consultarCostosOficiales(desdeSeg, { forzar = false } = {}) {
    const clave = process.env.OPENAI_ADMIN_KEY;
    if (!clave) {
        throw errorTipado(
            'Falta OPENAI_ADMIN_KEY en el .env del servidor.',
            'OPENAI_ADMIN_KEY_FALTA',
            503
        );
    }

    // Una consulta que empieza antes cubre a una que empieza después: se reutiliza.
    if (!forzar && cache && cache.desde <= desdeSeg && Date.now() - cache.guardadoEn < CACHE_MS) {
        return recortar(cache, desdeSeg);
    }

    // Se pide desde la medianoche UTC anterior: sus cinco primeras horas son del día de Colombia
    // de antes y `recortar` las deja fuera, pero hacen falta para repartir bien ese día UTC.
    const desdeUtc = inicioDiaUtc(desdeSeg * 1000);
    const [dias, horas] = await Promise.all([
        pedirCostosPorDia(desdeUtc, clave),
        // El reparto por hora es un refinamiento: si falla, la vista sigue con el aproximado.
        pedirUsoPorHora(desdeUtc, clave).catch(() => null),
    ]);

    cache = {
        desde: desdeSeg,
        guardadoEn: Date.now(),
        celdas: repartirPorHora(dias, horas),
        reparto: horas ? 'por_hora' : 'aproximado',
        consultado_en: new Date().toISOString(),
    };
    return recortar(cache, desdeSeg);
}

/** Suma las celdas desde `desdeSeg`, por día de Colombia, por concepto y por hora. */
function recortar({ celdas, reparto, consultado_en }, desdeSeg) {
    const porDia = new Map();
    const porConcepto = new Map();
    const porHora = new Map();
    for (const c of celdas) {
        if (c.inicio < desdeSeg) continue;
        const fecha = fechaBogota(c.inicio);
        porDia.set(fecha, (porDia.get(fecha) || 0) + c.usd);
        if (!c.concepto) continue;
        porConcepto.set(c.concepto, (porConcepto.get(c.concepto) || 0) + c.usd);
        porHora.set(c.inicio, (porHora.get(c.inicio) || 0) + c.usd);
    }
    return {
        por_dia: [...porDia.entries()]
            .map(([fecha, usd]) => ({ fecha, usd }))
            .sort((a, b) => a.fecha.localeCompare(b.fecha)),
        por_concepto: [...porConcepto.entries()]
            .map(([concepto, usd]) => ({ concepto, usd }))
            .sort((a, b) => b.usd - a.usd),
        por_hora: [...porHora.entries()]
            .map(([inicio, usd]) => ({ inicio, usd }))
            .sort((a, b) => a.inicio - b.inicio),
        reparto,
        consultado_en,
    };
}

/** Suma el gasto de los días `>= desdeFecha` (YYYY-MM-DD, de Colombia). */
function sumarDesde(porDia, desdeFecha) {
    return porDia.filter((d) => d.fecha >= desdeFecha).reduce((s, d) => s + d.usd, 0);
}

/**
 * Promedio diario de los últimos `n` días **completos** de Colombia (sin contar hoy, que va a
 * medias y bajaría el promedio cada mañana). Los días sin gasto cuentan como cero.
 */
function promedioDiario(porDia, n = 7, ahora = new Date()) {
    const hoy = inicioDiaBogota(ahora);
    const desde = fechaBogota(hoy - n * SEG_DIA);
    const hasta = fechaBogota(hoy);
    const suma = porDia
        .filter((d) => d.fecha >= desde && d.fecha < hasta)
        .reduce((s, d) => s + d.usd, 0);
    return suma / n;
}

/**
 * El saldo estimado a partir de los movimientos registrados y del gasto.
 *
 * ## Desde la hora del saldo, no desde su día
 *
 * El saldo que se copia de OpenAI ya tiene descontado todo lo gastado hasta ese minuto, así que
 * solo se resta lo de DESPUÉS, por la mejor vía disponible:
 *
 *  1. `por_hora`: el gasto oficial repartido por hora (`consultarCostosOficiales`). Se suman las
 *     horas posteriores al registro, y de la hora en que cayó, la parte que quedaba. Es lo que
 *     cobra OpenAI, incluido lo que no pasa por el bot.
 *  2. `foto`: sin reparto por hora; al registrar se guardó cuánto llevaba gastado ese día
 *     (`gasto_dia_previo_usd`) y se resta el total del día menos esa foto.
 *  3. `interno`: sin ninguna de las dos, lo que el Ledger anotó después de la hora exacta del
 *     registro. No ve el gasto fuera del bot, así que deja el saldo por encima del real: fue
 *     el descuadre del 2026-10-07 (OpenAI decía US$10.98; con `por_hora` da US$10.99).
 *  4. `dia_completo`: sin nada, el día entero (conservador).
 *
 * @param {Array<{tipo:'SALDO'|'RECARGA', monto_usd, fecha, gasto_dia_previo_usd?}>} movimientos
 *        activos, en cualquier orden.
 * @param {Array<{fecha:string, usd:number}>} porDia  gasto por día de Colombia, que cubra desde
 *        el SALDO.
 * @param {{ porHora?: Array<{inicio:number, usd:number}>|null,
 *           gastoInternoTrasPartida?: number|null }} [opciones]  `porHora` es el gasto oficial
 *        por hora; `gastoInternoTrasPartida`, lo que el Ledger anotó entre la hora del SALDO y
 *        el fin de ese día.
 * @returns {null | { saldo_partida, fecha_partida, recargas_posteriores, gasto_desde_partida,
 *                    saldo_estimado, metodo_dia_partida }}  `null` si nunca se registró un SALDO.
 */
function calcularSaldo(movimientos, porDia, { porHora = null, gastoInternoTrasPartida = null } = {}) {
    const partida = saldoDePartida(movimientos);
    if (!partida) return null;

    const fechaPartida = new Date(partida.fecha);
    const recargas = movimientos
        .filter((m) => m.tipo === 'RECARGA' && new Date(m.fecha) > fechaPartida)
        .reduce((s, m) => s + Number(m.monto_usd), 0);

    let gasto;
    let metodo;
    if (porHora) {
        const desde = fechaPartida.getTime() / 1000;
        gasto = porHora.reduce((s, h) => {
            const queda = Math.min(1, Math.max(0, (h.inicio + SEG_HORA - desde) / SEG_HORA));
            return s + h.usd * queda;
        }, 0);
        metodo = 'por_hora';
    } else {
        const diaPartida = fechaBogota(inicioDiaBogota(fechaPartida));
        const diaSiguiente = fechaBogota(inicioDiaBogota(fechaPartida) + SEG_DIA);
        const totalDiaPartida = porDia.find((d) => d.fecha === diaPartida)?.usd ?? 0;

        let gastoDiaPartida;
        if (partida.gasto_dia_previo_usd != null) {
            gastoDiaPartida = Math.max(0, totalDiaPartida - Number(partida.gasto_dia_previo_usd));
            metodo = 'foto';
        } else if (gastoInternoTrasPartida != null) {
            gastoDiaPartida = Number(gastoInternoTrasPartida);
            metodo = 'interno';
        } else {
            gastoDiaPartida = totalDiaPartida;
            metodo = 'dia_completo';
        }
        gasto = gastoDiaPartida + sumarDesde(porDia, diaSiguiente);
    }

    const saldoPartida = Number(partida.monto_usd);

    return {
        saldo_partida: redondear(saldoPartida, 2),
        fecha_partida: fechaPartida.toISOString(),
        recargas_posteriores: redondear(recargas, 2),
        gasto_desde_partida: redondear(gasto),
        saldo_estimado: redondear(saldoPartida + recargas - gasto),
        metodo_dia_partida: metodo,
    };
}

/** El SALDO más reciente, o `null`. */
function saldoDePartida(movimientos) {
    return (
        movimientos
            .filter((m) => m.tipo === 'SALDO')
            .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))[0] ?? null
    );
}

/** Días que alcanza el saldo al ritmo actual. `null` si no hay gasto con qué estimarlo. */
function diasRestantes(saldo, promedio) {
    if (saldo == null || !(promedio > 0)) return null;
    return Math.max(0, Math.floor(saldo / promedio));
}

module.exports = {
    consultarCostosOficiales,
    repartirPorHora,
    calcularSaldo,
    saldoDePartida,
    promedioDiario,
    diasRestantes,
    sumarDesde,
    inicioDiaBogota,
    inicioMesBogota,
    fechaBogota,
    redondear,
    SEG_DIA,
    /** Solo para tests. */
    _vaciarCache: () => {
        cache = null;
    },
};
