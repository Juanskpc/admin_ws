'use strict';
/**
 * Consumo de WhatsApp — lo que Meta cuenta y cobra por cada cuenta (WABA). Vista «Terceros».
 *
 * ## De dónde sale
 *
 * `GET /{waba_id}?fields=pricing_analytics...` de la Graph API, con granularidad diaria y por
 * número, categoría y tipo de precio. Es la cifra de Meta, no la nuestra: `whatsapp:cuota`
 * (`intelligence/channels/whatsapp/cuota.js`) cuenta desde `intelligence.mensaje`, que es una
 * aproximación; esto es lo que Meta factura.
 *
 * Probado en producción el 2026-10-04: el token global (`WHATSAPP_TOKEN`) lee también las WABA
 * de los clientes conectados por Embedded Signup, así que no hace falta descifrar el token de
 * cada uno. Si algún día deja de alcanzar, el error sale por cuenta y no tumba a las demás.
 *
 * ## Quién paga
 *
 * - La WABA de EscalApp (`WHATSAPP_WABA_ID`) la paga **EscalApp**. Ahí cuelgan los números dados
 *   de alta a mano (`origen = 'manual'`, sin `waba_id` propio).
 * - Las WABA de Embedded Signup son **del cliente** y las paga el cliente con su tarjeta
 *   (`docs/embedded-signup.md` §9.1). Se enseñan igual —si un número se pasa de la cuota, el
 *   cliente se va a enterar por su factura y conviene enterarse antes—, pero aparte.
 *
 * ## Días y moneda
 *
 * Meta corta los días a la medianoche de **Colombia** (la zona de la WABA), no en UTC como
 * OpenAI. Y cobra en la moneda de la WABA (COP en todas las de hoy), así que el costo viaja con
 * su moneda y la conversión, si hace falta, la hace quien suma.
 *
 * La asignación gratis de 1.000 mensajes de servicio es **por número y por mes**
 * (`docs/whatsapp-costo-mensajes.md`). Por eso se cuenta por número, no por cuenta.
 */

const Models = require('../../app_core/models/conection');

const GRAPH = 'https://graph.facebook.com/v21.0';
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15_000;
/** Colombia no tiene horario de verano: -05:00 todo el año. */
const OFFSET_BOGOTA_SEG = 5 * 3600;
const GRATIS_SERVICIO_MES = 1000;

let cache = null; // { desde, guardadoEn, datos }

function errorTipado(mensaje, code, statusCode) {
    const err = new Error(mensaje);
    err.code = code;
    err.statusCode = statusCode;
    return err;
}

/** `start` de Meta (medianoche de Bogotá en segundos) → `YYYY-MM-DD`. */
function fechaBogota(seg) {
    return new Date((seg - OFFSET_BOGOTA_SEG) * 1000).toISOString().slice(0, 10);
}

/** Medianoche de Bogotá del día de `fecha`, en segundos. */
function inicioDiaBogota(fecha = new Date()) {
    const ms = new Date(fecha).getTime() - OFFSET_BOGOTA_SEG * 1000;
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000 + OFFSET_BOGOTA_SEG;
}

/** Medianoche de Bogotá del día 1 del mes en curso, en segundos. */
function inicioMesBogota(fecha = new Date()) {
    const d = new Date(new Date(fecha).getTime() - OFFSET_BOGOTA_SEG * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 + OFFSET_BOGOTA_SEG;
}

const soloDigitos = (v) => String(v || '').replace(/\D/g, '');

/** Un mensaje es cobrado si Meta le puso precio o lo marcó como tarifa normal. */
function esCobrado(p) {
    return Number(p.cost || 0) > 0 || p.pricing_type === 'REGULAR';
}

/**
 * Las cuentas a consultar: la de EscalApp y una por cada WABA de cliente activa, con los
 * números que se conocen para poder decir de qué negocio es cada uno.
 */
async function cuentasConocidas() {
    const numeros = await Models.sequelize.query(
        `SELECT n.id_negocio, g.nombre, n.waba_id, n.numero_e164, n.origen, n.estado
           FROM platform.numero_canal n
           LEFT JOIN general.gener_negocio g ON g.id_negocio = n.id_negocio
          WHERE n.canal = 'whatsapp';`,
        { type: Models.sequelize.QueryTypes.SELECT }
    );

    const porTelefono = new Map();
    for (const n of numeros) {
        const tel = soloDigitos(n.numero_e164);
        // Un número reconectado deja filas inactivas: manda la activa.
        if (tel && (!porTelefono.has(tel) || n.estado === 'A')) {
            porTelefono.set(tel, { id_negocio: n.id_negocio, negocio: n.nombre });
        }
    }

    const cuentas = [];
    if (process.env.WHATSAPP_WABA_ID) {
        cuentas.push({
            waba_id: process.env.WHATSAPP_WABA_ID,
            nombre: 'EscalApp',
            paga: 'escalapp',
            id_negocio: null,
        });
    }
    const vistas = new Set(cuentas.map((c) => c.waba_id));
    for (const n of numeros) {
        if (n.estado !== 'A' || !n.waba_id || vistas.has(n.waba_id)) continue;
        vistas.add(n.waba_id);
        cuentas.push({
            waba_id: n.waba_id,
            nombre: n.nombre || `Negocio ${n.id_negocio}`,
            paga: n.origen === 'embedded_signup' ? 'cliente' : 'escalapp',
            id_negocio: n.id_negocio,
        });
    }
    return { cuentas, porTelefono };
}

async function consultarCuenta(cuenta, desdeSeg, hastaSeg, token) {
    const campos =
        `pricing_analytics.start(${desdeSeg}).end(${hastaSeg}).granularity(DAILY)` +
        `.dimensions(["PHONE","PRICING_CATEGORY","PRICING_TYPE"])`;
    const base = `${GRAPH}/${cuenta.waba_id}`;
    const pedir = async (url) => {
        const r = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error?.error_user_msg || j?.error?.message || `HTTP ${r.status}`);
        return j;
    };

    const [analitica, info] = await Promise.all([
        pedir(`${base}?fields=${encodeURIComponent(campos)}`),
        pedir(`${base}?fields=currency`),
    ]);
    const puntos = (analitica.pricing_analytics?.data || []).flatMap((d) => d.data_points || []);
    return { moneda: info.currency || null, puntos };
}

/**
 * Consumo de WhatsApp de todas las cuentas desde `desdeSeg` (medianoche de Bogotá).
 *
 * @returns {{ consultado_en: string, cuentas: Array<{ nombre, paga, id_negocio, moneda,
 *            error: string|null, puntos: Array<{fecha, telefono, id_negocio, negocio,
 *            categoria, tipo, mensajes, costo, cobrado}> }> }}
 */
async function consultarConsumoMeta(desdeSeg, { forzar = false } = {}) {
    const token = process.env.WHATSAPP_TOKEN;
    if (!token) {
        throw errorTipado('Falta WHATSAPP_TOKEN en el .env del servidor.', 'META_TOKEN_FALTA', 503);
    }
    if (!forzar && cache && cache.desde <= desdeSeg && Date.now() - cache.guardadoEn < CACHE_MS) {
        return recortar(cache.datos, desdeSeg);
    }

    const { cuentas, porTelefono } = await cuentasConocidas();
    const hastaSeg = Math.floor(Date.now() / 1000);

    const resultado = await Promise.all(
        cuentas.map(async (c) => {
            const salida = { nombre: c.nombre, paga: c.paga, id_negocio: c.id_negocio, moneda: null, error: null, puntos: [] };
            try {
                const { moneda, puntos } = await consultarCuenta(c, desdeSeg, hastaSeg, token);
                salida.moneda = moneda;
                salida.puntos = puntos.map((p) => {
                    const tel = soloDigitos(p.phone_number);
                    const dueno = porTelefono.get(tel);
                    return {
                        fecha: fechaBogota(p.start),
                        telefono: tel,
                        id_negocio: dueno?.id_negocio ?? c.id_negocio,
                        negocio: dueno?.negocio ?? c.nombre,
                        categoria: p.pricing_category || 'DESCONOCIDA',
                        tipo: p.pricing_type || 'DESCONOCIDO',
                        mensajes: Number(p.volume || 0),
                        costo: Number(p.cost || 0),
                        cobrado: esCobrado(p),
                    };
                });
            } catch (e) {
                salida.error = e.message;
            }
            return salida;
        })
    );

    const datos = { consultado_en: new Date().toISOString(), cuentas: resultado };
    cache = { desde: desdeSeg, guardadoEn: Date.now(), datos };
    return recortar(datos, desdeSeg);
}

function recortar(datos, desdeSeg) {
    const desde = fechaBogota(desdeSeg);
    return {
        consultado_en: datos.consultado_en,
        cuentas: datos.cuentas.map((c) => ({ ...c, puntos: c.puntos.filter((p) => p.fecha >= desde) })),
    };
}

/**
 * Resume las cuentas para la pantalla: por cuenta, por número (con la cuota del mes), por
 * categoría y por día.
 */
function resumirMeta(consumo, { desdeVentana, inicioMes }) {
    const enVentana = (p) => p.fecha >= desdeVentana;
    const delMes = (p) => p.fecha >= inicioMes;

    const cuentas = consumo.cuentas.map((c) => {
        const numeros = new Map();
        const categorias = new Map();
        for (const p of c.puntos) {
            if (delMes(p)) {
                const n = numeros.get(p.telefono) || {
                    telefono: p.telefono,
                    id_negocio: p.id_negocio,
                    negocio: p.negocio,
                    mensajes_mes: 0,
                    servicio_mes: 0,
                    cobrados_mes: 0,
                    costo_mes: 0,
                };
                n.mensajes_mes += p.mensajes;
                if (p.categoria === 'SERVICE') n.servicio_mes += p.mensajes;
                if (p.cobrado) n.cobrados_mes += p.mensajes;
                n.costo_mes += p.costo;
                numeros.set(p.telefono, n);
            }
            if (enVentana(p)) {
                const clave = `${p.categoria}|${p.tipo}`;
                const k = categorias.get(clave) || { categoria: p.categoria, tipo: p.tipo, mensajes: 0, costo: 0 };
                k.mensajes += p.mensajes;
                k.costo += p.costo;
                categorias.set(clave, k);
            }
        }
        const sumar = (filtro, campo) => c.puntos.filter(filtro).reduce((s, p) => s + p[campo], 0);
        return {
            nombre: c.nombre,
            paga: c.paga,
            id_negocio: c.id_negocio,
            moneda: c.moneda,
            error: c.error,
            mensajes_periodo: sumar(enVentana, 'mensajes'),
            costo_periodo: sumar(enVentana, 'costo'),
            mensajes_mes: sumar(delMes, 'mensajes'),
            costo_mes: sumar(delMes, 'costo'),
            numeros: [...numeros.values()]
                .map((n) => ({
                    ...n,
                    // El número se enseña enmascarado: basta para reconocerlo.
                    telefono: n.telefono ? `+${n.telefono.slice(0, 2)} ··· ${n.telefono.slice(-4)}` : '—',
                    gratis_limite: GRATIS_SERVICIO_MES,
                }))
                .sort((a, b) => b.mensajes_mes - a.mensajes_mes),
            por_categoria: [...categorias.values()].sort((a, b) => b.mensajes - a.mensajes),
        };
    });

    const serie = new Map();
    for (const c of consumo.cuentas) {
        for (const p of c.puntos) {
            if (!enVentana(p)) continue;
            const d = serie.get(p.fecha) || { fecha: p.fecha, escalapp: 0, clientes: 0, costo_escalapp: 0 };
            d[c.paga === 'escalapp' ? 'escalapp' : 'clientes'] += p.mensajes;
            if (c.paga === 'escalapp') d.costo_escalapp += p.costo;
            serie.set(p.fecha, d);
        }
    }

    return { cuentas, por_dia: serie };
}

module.exports = {
    consultarConsumoMeta,
    resumirMeta,
    fechaBogota,
    inicioDiaBogota,
    inicioMesBogota,
    esCobrado,
    GRATIS_SERVICIO_MES,
    OFFSET_BOGOTA_SEG,
    /** Solo para tests. */
    _vaciarCache: () => {
        cache = null;
    },
};
