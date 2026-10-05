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
 * ## El saldo no existe en la API de OpenAI
 *
 * No hay endpoint oficial para el crédito prepagado. Se reconstruye con lo que el super admin
 * registra en `general.gener_recarga_ia` (ver la migración): último SALDO + RECARGAS
 * posteriores − gasto oficial desde ese SALDO.
 *
 * OpenAI agrupa los costos por **día UTC** (el día se corta a las 7 p.m. de Colombia), así que
 * del día en que se registró el SALDO solo se resta lo gastado después del registro: ver
 * `calcularSaldo`.
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
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15_000;
/** OpenAI devuelve como mucho 180 cubetas diarias por página. */
const CUBETAS_POR_PAGINA = 180;
/** Tope de páginas: 10 × 180 días = casi 5 años. Evita un bucle si la API se porta raro. */
const MAX_PAGINAS = 10;
const SEG_DIA = 86_400;

let cache = null; // { desde, guardadoEn, filas, consultado_en }

function errorTipado(mensaje, code, statusCode) {
    const err = new Error(mensaje);
    err.code = code;
    err.statusCode = statusCode;
    return err;
}

/** Medianoche UTC (en segundos) del día que contiene `fecha`. */
function inicioDiaUtc(fecha) {
    const d = new Date(fecha);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

function fechaUtc(seg) {
    return new Date(seg * 1000).toISOString().slice(0, 10);
}

function redondear(valor, decimales = 4) {
    const f = 10 ** decimales;
    return Math.round(Number(valor || 0) * f) / f;
}

/**
 * Pide a OpenAI los costos diarios desde `desdeSeg` (medianoche UTC) hasta ahora, agrupados
 * por concepto (`line_item`, p. ej. «gpt-5.6-luna, input»).
 *
 * @returns {{ por_dia: Array<{fecha:string, usd:number}>,
 *             por_concepto: Array<{concepto:string, usd:number}>,
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

    // Filas crudas (día, concepto, usd): así la caché se puede recortar a cualquier ventana
    // más corta sin que el desglose por concepto arrastre días que no se pidieron.
    const filas = [];
    let pagina = null;

    for (let n = 0; n < MAX_PAGINAS; n++) {
        const params = new URLSearchParams({
            start_time: String(desdeSeg),
            bucket_width: '1d',
            limit: String(CUBETAS_POR_PAGINA),
        });
        params.append('group_by', 'line_item');
        if (pagina) params.set('page', pagina);

        let respuesta;
        try {
            respuesta = await fetch(`${URL_COSTOS}?${params}`, {
                headers: { Authorization: `Bearer ${clave}` },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (e) {
            throw errorTipado(
                `No se pudo contactar a OpenAI: ${e.message}`,
                'OPENAI_NO_RESPONDE',
                502
            );
        }

        const cuerpo = await respuesta.json().catch(() => ({}));
        if (!respuesta.ok) {
            const detalle = cuerpo?.error?.message || `HTTP ${respuesta.status}`;
            const code = respuesta.status === 401 || respuesta.status === 403
                ? 'OPENAI_ADMIN_KEY_RECHAZADA'
                : 'OPENAI_ERROR';
            throw errorTipado(`OpenAI rechazó la consulta de costos: ${detalle}`, code, 502);
        }

        for (const cubeta of cuerpo.data || []) {
            const fecha = fechaUtc(cubeta.start_time);
            // Un día sin gasto también es un dato: que salga en la gráfica como cero.
            filas.push({ fecha, concepto: null, usd: 0 });
            for (const r of cubeta.results || []) {
                filas.push({
                    fecha,
                    concepto: r.line_item || 'Sin detalle',
                    usd: Number(r?.amount?.value || 0),
                });
            }
        }

        if (!cuerpo.has_more || !cuerpo.next_page) break;
        pagina = cuerpo.next_page;
    }

    cache = { desde: desdeSeg, guardadoEn: Date.now(), filas, consultado_en: new Date().toISOString() };
    return recortar(cache, desdeSeg);
}

/** Suma las filas crudas de los días `>= desdeSeg`, por día y por concepto. */
function recortar({ filas, consultado_en }, desdeSeg) {
    const desde = fechaUtc(desdeSeg);
    const porDia = new Map();
    const porConcepto = new Map();
    for (const f of filas) {
        if (f.fecha < desde) continue;
        porDia.set(f.fecha, (porDia.get(f.fecha) || 0) + f.usd);
        if (f.concepto) porConcepto.set(f.concepto, (porConcepto.get(f.concepto) || 0) + f.usd);
    }
    return {
        por_dia: [...porDia.entries()]
            .map(([fecha, usd]) => ({ fecha, usd }))
            .sort((a, b) => a.fecha.localeCompare(b.fecha)),
        por_concepto: [...porConcepto.entries()]
            .map(([concepto, usd]) => ({ concepto, usd }))
            .sort((a, b) => b.usd - a.usd),
        consultado_en,
    };
}

/** Suma el gasto de los días `>= desdeFecha` (YYYY-MM-DD, UTC). */
function sumarDesde(porDia, desdeFecha) {
    return porDia.filter((d) => d.fecha >= desdeFecha).reduce((s, d) => s + d.usd, 0);
}

/**
 * Promedio diario de los últimos `n` días UTC **completos** (sin contar hoy, que va a medias
 * y bajaría el promedio cada mañana). Los días sin gasto cuentan como cero.
 */
function promedioDiario(porDia, n = 7, ahora = new Date()) {
    const hoy = inicioDiaUtc(ahora);
    const desde = fechaUtc(hoy - n * SEG_DIA);
    const hasta = fechaUtc(hoy);
    const suma = porDia
        .filter((d) => d.fecha >= desde && d.fecha < hasta)
        .reduce((s, d) => s + d.usd, 0);
    return suma / n;
}

/**
 * El saldo estimado a partir de los movimientos registrados y del gasto diario.
 *
 * ## El día en que se registró el saldo
 *
 * OpenAI agrupa el gasto por día UTC (de 7 p. m. a 7 p. m. en Colombia). Si el saldo se registra
 * a las 11:30 p. m., ese día UTC ya trae cuatro horas y media de gasto que el saldo que se ve en
 * OpenAI YA tiene descontado. Restarlo otra vez dejaba el saldo por debajo del real —le pasó al
 * primer registro, el 2026-10-04: US$1.36 en OpenAI, la vista decía US$0.79—. Así que de ese día
 * solo se resta lo gastado DESPUÉS del registro, por la mejor vía disponible:
 *
 *  1. `foto`: al registrar, se guardó cuánto llevaba gastado OpenAI ese día
 *     (`gasto_dia_previo_usd`); se resta el total del día menos esa foto. Exacto, salvo el
 *     retraso con que OpenAI reporta (que solo puede hacer que se reste de más: lado seguro).
 *  2. `interno`: sin foto (saldo con fecha de otro día, o registrado antes de existir la foto),
 *     lo que el Ledger anotó después de la hora exacta del registro. No ve el gasto fuera del bot.
 *  3. `dia_completo`: sin ninguna de las dos, el día entero (conservador).
 *
 * @param {Array<{tipo:'SALDO'|'RECARGA', monto_usd, fecha, gasto_dia_previo_usd?}>} movimientos
 *        activos, en cualquier orden.
 * @param {Array<{fecha:string, usd:number}>} porDia  gasto por día UTC, que cubra desde el SALDO.
 * @param {{ gastoInternoTrasPartida?: number|null }} [opciones]  lo que el Ledger anotó entre la
 *        hora del SALDO y el fin de ese día UTC.
 * @returns {null | { saldo_partida, fecha_partida, recargas_posteriores, gasto_desde_partida,
 *                    saldo_estimado, metodo_dia_partida }}  `null` si nunca se registró un SALDO.
 */
function calcularSaldo(movimientos, porDia, { gastoInternoTrasPartida = null } = {}) {
    const partida = saldoDePartida(movimientos);
    if (!partida) return null;

    const fechaPartida = new Date(partida.fecha);
    const recargas = movimientos
        .filter((m) => m.tipo === 'RECARGA' && new Date(m.fecha) > fechaPartida)
        .reduce((s, m) => s + Number(m.monto_usd), 0);

    const diaPartida = fechaUtc(inicioDiaUtc(fechaPartida));
    const diaSiguiente = fechaUtc(inicioDiaUtc(fechaPartida) + SEG_DIA);
    const totalDiaPartida = porDia.find((d) => d.fecha === diaPartida)?.usd ?? 0;

    let gastoDiaPartida;
    let metodo;
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

    const gasto = gastoDiaPartida + sumarDesde(porDia, diaSiguiente);
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
    calcularSaldo,
    saldoDePartida,
    promedioDiario,
    diasRestantes,
    sumarDesde,
    inicioDiaUtc,
    fechaUtc,
    redondear,
    SEG_DIA,
    /** Solo para tests. */
    _vaciarCache: () => {
        cache = null;
    },
};
