/**
 * Conciliación de pagos — que un pago aprobado en la pasarela SIEMPRE termine aplicado, aunque no
 * llegue el webhook y el cliente no vuelva del checkout.
 *
 * ## Por qué existe
 *
 * Wompi nunca ha enviado un evento a producción (2026-09-24: 0 filas reales en
 * `cob_evento_webhook`). Un pago solo se confirmaba si el cliente volvía por la redirect-url con
 * `?id=`; quien pagaba desde el teléfono y no volvía (El Callejero, factura 3) se quedaba sin plan
 * con la plata ya cobrada. Aquí no se espera a nadie: se PREGUNTA a la pasarela.
 *
 * ## Cuándo corre: cuando el usuario entra, no cada cierto tiempo
 *
 * NO hay cron. Decisión del dueño (2026-09-24): el admin llama `POST /cobranza/conciliar-pendientes`
 * al iniciar sesión, al abrir la app con sesión y al volver a la pestaña. Así la consulta ocurre
 * justo cuando alguien mira, y en el 99 % de los casos —no hay intentos de pago pendientes— es una
 * sola consulta a NUESTRA base y ninguna llamada a una pasarela.
 *
 * ## Qué hace
 *
 * Toma los intentos de pago pendientes (`cob_transaccion` en `pendiente`) de las facturas de los
 * negocios que el usuario administra y le pregunta a su pasarela:
 *   - Wompi: por la referencia de intento que guardamos al abrir el checkout
 *     (`consultarPorReferencia`), o por id si ya lo tenemos.
 *   - dLocal Go: por el id del pago (`consultarTransaccion`); ese id SÍ se guarda al crear el cobro.
 * Lo que encuentre lo entrega a `resolverEstadoReal`, la ÚNICA función que aplica pagos (la misma
 * del webhook, del retorno y de «Verificar pago Wompi»): aprobada → se aplica una vez; rechazada →
 * el intento se marca rechazado y la factura sigue pendiente; pendiente → se espera. Un intento de
 * más de 7 días que no pagó pasa a `expirada` (la factura NO se toca).
 *
 * ## Límites que protegen a la pasarela
 *
 *   - Como mucho UNA consulta por negocio cada 60 s (en memoria): recargar no martilla la API.
 *   - Tope de ~3 s: si la pasarela tarda, se responde con lo que ya hay y el trabajo sigue en
 *     segundo plano.
 *   - Un error de la pasarela en un intento no detiene los demás.
 */
'use strict';
const Models = require('../../app_core/models/conection');
const Dao = require('../../app_core/dao/cobranzaDao');
const { getAdaptador } = require('../../app_core/cobranza');
const WebhookService = require('./cobranzaWebhookService');

const sequelize = Models.sequelize;

const DIA = 24 * 60 * 60 * 1000;
const EDAD_EXPIRACION = 7 * DIA;
const LIMITE_POR_NEGOCIO_MS = 60_000;
const TOPE_MS = 3_000;
/** Las pasarelas que abren un intento de pago pendiente (`manual` no tiene nada que preguntar). */
const PASARELAS = ['wompi', 'dlocal'];

/** id_negocio → cuándo se consultó por última vez a la pasarela (límite de 60 s). */
const ultimaPorNegocio = new Map();

/**
 * Los intentos pendientes de estos negocios, con su edad. `edad_ms` se calcula en la base para no
 * depender de la zona horaria del proceso (las fechas son hora de Bogotá sin zona).
 */
async function intentosPendientes(idNegocios) {
    if (!idNegocios?.length) return [];
    return sequelize.query(
        `SELECT t.id_transaccion, t.id_factura, t.pasarela, t.id_externo, t.payload,
                f.id_negocio, f.referencia AS referencia_factura,
                (EXTRACT(EPOCH FROM (LOCALTIMESTAMP - t.creado_en)) * 1000)::bigint AS edad_ms
           FROM cobranza.cob_transaccion t
           JOIN cobranza.cob_factura f ON f.id_factura = t.id_factura
          WHERE t.pasarela IN (:pasarelas)
            AND t.estado = 'pendiente'
            AND f.id_negocio IN (:idNegocios)
          ORDER BY t.creado_en ASC;`,
        {
            replacements: { pasarelas: PASARELAS, idNegocios },
            type: sequelize.QueryTypes.SELECT,
        }
    );
}

/** De todo lo que la pasarela devolvió: aprobada > pendiente > la primera que haya. */
function elegirTransaccion(candidatas) {
    const lista = (candidatas || []).filter(Boolean);
    return (
        lista.find((c) => c.estado === 'aprobada') ||
        lista.find((c) => c.estado === 'pendiente') ||
        lista[0] ||
        null
    );
}

async function cerrarPorId(idTransaccion, estado, { mensaje = null, estadoReal = null } = {}) {
    await sequelize.query(
        `UPDATE cobranza.cob_transaccion
            SET estado = :estado,
                id_externo = COALESCE(:idExterno, id_externo),
                codigo_respuesta = COALESCE(:codigo, codigo_respuesta),
                mensaje = COALESCE(:mensaje, mensaje)
          WHERE id_transaccion = :idTransaccion AND estado = 'pendiente';`,
        {
            replacements: {
                idTransaccion,
                estado,
                idExterno: estadoReal?.idExterno ?? null,
                codigo: estadoReal?.codigoRespuesta ?? null,
                mensaje,
            },
        }
    );
}

/**
 * Concilia UN intento pendiente. Lanza si la pasarela falla (quien llama lo cuenta y sigue).
 *
 * @returns {Promise<{resultado: 'aplicada'|'rechazada'|'expirada'|'pendiente'|'sin_transaccion'|'sin_soporte'|'sin_credenciales'|'sin_factura'|string, referencia?: string}>}
 */
async function conciliarIntento(intento, { via }) {
    const adaptador = getAdaptador(intento.pasarela);
    if (adaptador.estaConfigurada && !adaptador.estaConfigurada()) {
        return { resultado: 'sin_credenciales' };
    }

    const expira = Number(intento.edad_ms) >= EDAD_EXPIRACION;
    const referencia = intento.payload?.reference ?? intento.payload?.order_id ?? null;

    let candidatas = [];
    if (intento.id_externo) {
        candidatas = [await adaptador.consultarTransaccion(intento.id_externo)];
    } else if (referencia && typeof adaptador.consultarPorReferencia === 'function') {
        candidatas = await adaptador.consultarPorReferencia(referencia);
    } else if (!expira) {
        return { resultado: 'sin_soporte' };
    }

    const elegida = elegirTransaccion(candidatas);

    if (elegida?.estado === 'aprobada' || elegida?.estado === 'rechazada') {
        const factura = await Dao.getFactura(intento.id_factura);
        if (!factura) return { resultado: 'sin_factura' };

        if (elegida.estado === 'rechazada') {
            // El intento queda rechazado tanto si la factura sigue pendiente como si ya la pagó otro.
            await cerrarPorId(intento.id_transaccion, 'rechazada', {
                mensaje: elegida.mensaje ?? null,
                estadoReal: elegida,
            });
            if (factura.estado === 'pendiente') {
                await WebhookService.resolverEstadoReal({
                    pasarela: intento.pasarela,
                    factura,
                    estadoReal: elegida,
                    via,
                });
            }
            return { resultado: 'rechazada' };
        }

        const r = await WebhookService.resolverEstadoReal({
            pasarela: intento.pasarela,
            factura,
            estadoReal: elegida,
            via,
        });
        return {
            resultado: r.accion === 'pago_aplicado' ? 'aplicada' : r.accion,
            referencia: r.referencia ?? factura.referencia,
        };
    }

    // Pendiente en la pasarela, o sin ninguna transacción (abrió el checkout y no pagó).
    if (expira) {
        await cerrarPorId(intento.id_transaccion, 'expirada', {
            mensaje: 'Sin pago tras 7 días: el intento expiró. La factura sigue pendiente.',
        });
        return { resultado: 'expirada' };
    }
    return { resultado: elegida ? 'pendiente' : 'sin_transaccion' };
}

function conTope(promesa, ms) {
    let temporizador;
    const tope = new Promise((resolve) => {
        temporizador = setTimeout(resolve, ms);
    });
    return Promise.race([promesa, tope]).finally(() => clearTimeout(temporizador));
}

/**
 * Concilia los intentos pendientes de estos negocios. Es lo que llama el endpoint que usa el admin
 * al iniciar sesión y al volver.
 *
 * Sin intentos pendientes responde al instante y SIN llamar a ninguna pasarela (el caso del 99 %).
 * Nunca lanza: una conciliación que falla no puede impedir que el usuario entre.
 *
 * @param {number[]} idNegocios  ya autorizados por quien llama
 * @param {object}   opciones
 * @param {'al_iniciar_sesion'|'al_volver'} [opciones.via]
 * @param {number}   [opciones.topeMs]   cuánto esperar antes de responder con lo que haya
 * @param {number}   [opciones.ahoraMs]
 * @returns {Promise<{aplicados: Array<{id_negocio:number, referencia:string}>, pendientes: number}>}
 */
async function conciliarPendientes(
    idNegocios,
    { via = 'al_iniciar_sesion', topeMs = TOPE_MS, ahoraMs = Date.now() } = {}
) {
    const aplicados = [];
    try {
        const ids = [...new Set((idNegocios || []).map(Number).filter(Boolean))];
        const intentos = await intentosPendientes(ids);
        if (intentos.length === 0) return { aplicados, pendientes: 0 };

        // Como mucho una consulta a la pasarela por negocio cada 60 s.
        const permitidos = new Set(
            ids.filter((id) => {
                const anterior = ultimaPorNegocio.get(id);
                return anterior == null || ahoraMs - anterior >= LIMITE_POR_NEGOCIO_MS;
            })
        );
        const aConsultar = intentos.filter((i) => permitidos.has(Number(i.id_negocio)));
        for (const id of permitidos) ultimaPorNegocio.set(id, ahoraMs);

        let resueltos = 0;
        const trabajo = Promise.all(
            aConsultar.map(async (intento) => {
                try {
                    const r = await conciliarIntento(intento, { via });
                    if (r.resultado === 'aplicada') {
                        aplicados.push({ id_negocio: Number(intento.id_negocio), referencia: r.referencia });
                    }
                    if (['aplicada', 'rechazada', 'expirada'].includes(r.resultado)) resueltos += 1;
                } catch (err) {
                    // Un error de la pasarela en un intento no detiene a los demás.
                    console.error(
                        `[Cobranza/conciliación] intento ${intento.id_transaccion} ` +
                            `(factura ${intento.id_factura}, ${intento.pasarela}): ${err.message}`
                    );
                }
            })
        ).catch((err) => console.error('[Cobranza/conciliación]', err.message));

        await conTope(trabajo, topeMs);
        // Lo que no terminó sigue corriendo: `aplicados` se va llenando y el siguiente llamado lo verá
        // reflejado en el estado del plan.
        return { aplicados: [...aplicados], pendientes: Math.max(0, intentos.length - resueltos) };
    } catch (err) {
        console.error('[Cobranza/conciliación]', err.message);
        return { aplicados: [...aplicados], pendientes: 0 };
    }
}

/** Para las pruebas: vuelve al estado inicial (el límite de 60 s por negocio). */
function _reiniciar() {
    ultimaPorNegocio.clear();
}

module.exports = {
    conciliarPendientes,
    conciliarIntento,
    intentosPendientes,
    elegirTransaccion,
    EDAD_EXPIRACION,
    LIMITE_POR_NEGOCIO_MS,
    _reiniciar,
};
