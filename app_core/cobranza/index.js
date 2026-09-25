/**
 * Registro de adaptadores de cobro. Ver `docs/cobro-mensualidades.md` §3.4.
 *
 * ## El contrato
 *
 * Todo adaptador expone exactamente esto:
 *
 *   codigo             string — coincide con cobranza.cob_pasarela.codigo
 *   soportaRecurrente  boolean — ¿puede cobrar sin que el pagador esté delante?
 *   estaConfigurada()  boolean — ¿hay credenciales en el entorno?
 *
 *   tokenizarMetodo(datos)      → { tokenExterno, tipo, marca, ultimos4, mesExp, anioExp }
 *   cobrar({ referencia, monto, moneda, token, ... })
 *                               → { estado, idExterno, codigoRespuesta, mensaje, urlPago?, payload }
 *   consultarTransaccion(idExterno) → igual que cobrar()
 *   verificarFirmaWebhook(req)  → { valida, idEvento, tipo, idExterno?, referencia?, payload }
 *   consultarPorReferencia(referencia)  → arreglo de transacciones con la forma de
 *                               `consultarTransaccion` (vacío si no hay ninguna). OPCIONAL: solo
 *                               las pasarelas que abren el checkout SIN devolvernos el id de la
 *                               transacción la necesitan (Wompi); dLocal guarda el id al crear el
 *                               cobro y la conciliación usa `consultarTransaccion`.
 *
 * `estado` solo puede ser: 'aprobada' · 'pendiente' · 'rechazada'. Esos tres valores son el
 * vocabulario del servicio; traducir el de cada pasarela (APPROVED, PAID, DECLINED, EXPIRED…)
 * es trabajo del adaptador y no debe filtrarse hacia arriba.
 *
 * `payload` va SIN datos sensibles: lo limpia el adaptador, no quien lo guarda.
 *
 * ## Configurada ≠ activa
 *
 * Son dos interruptores distintos y a propósito:
 *
 *   - **Configurada** = hay credenciales en el `.env` (lo dice el adaptador).
 *   - **Activa** = `cob_pasarela.estado = 'A'` en la base (lo decide una persona).
 *
 * Tener llaves de sandbox en un `.env` no debería ofrecerle esa pasarela a un cliente, y apagar
 * una pasarela caída no debería exigir un despliegue. Por eso hacen falta las dos cosas, y por
 * eso `dlocal` y `wompi` nacen con estado 'I' aunque su código ya exista.
 */
'use strict';

const manual = require('./adapters/manual');
const dlocal = require('./adapters/dlocal');
const wompi = require('./adapters/wompi');

const ADAPTADORES = new Map([
    [manual.codigo, manual],
    [dlocal.codigo, dlocal],
    [wompi.codigo, wompi],
]);

/**
 * Devuelve el adaptador de una pasarela.
 *
 * Lanza error tipado en vez de devolver `undefined` a propósito: un adaptador que falta es
 * siempre un error de configuración (una pasarela activada en la base sin código que la
 * respalde), y descubrirlo con un `TypeError` tres líneas más abajo cuesta mucho más caro.
 */
function getAdaptador(codigo) {
    const adaptador = ADAPTADORES.get(codigo);
    if (!adaptador) {
        const e = new Error(`La pasarela '${codigo}' no está implementada.`);
        e.code = 'PASARELA_NO_DISPONIBLE';
        e.statusCode = 501;
        throw e;
    }
    return adaptador;
}

/**
 * Como `getAdaptador`, pero además exige credenciales. Se usa antes de cobrar de verdad: es
 * preferible un 503 explicando que faltan llaves a un 500 desde las tripas del adaptador.
 */
function getAdaptadorListo(codigo) {
    const adaptador = getAdaptador(codigo);
    if (adaptador.estaConfigurada && !adaptador.estaConfigurada()) {
        const e = new Error(`La pasarela '${codigo}' no tiene credenciales configuradas.`);
        e.code = 'PASARELA_SIN_CREDENCIALES';
        e.statusCode = 503;
        throw e;
    }
    return adaptador;
}

/** Los códigos con implementación. `manual` siempre está listo: no necesita credenciales. */
function codigosDisponibles() {
    return [...ADAPTADORES.keys()];
}

/** Diagnóstico para la consola y los arranques: qué pasarela podría cobrar hoy mismo. */
function estadoDeConfiguracion() {
    return [...ADAPTADORES.values()].map((a) => ({
        codigo: a.codigo,
        soporta_recurrente: a.soportaRecurrente,
        configurada: a.estaConfigurada ? a.estaConfigurada() : true,
    }));
}

module.exports = { getAdaptador, getAdaptadorListo, codigosDisponibles, estadoDeConfiguracion };
