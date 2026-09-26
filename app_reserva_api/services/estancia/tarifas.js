'use strict';
/**
 * Noches y precios de una estancia. Puro: sin base de datos.
 *
 * ## Convenciones que no se discuten
 *
 * - Una estancia es `[entrada, salida)`: quien entra el 10 y sale el 12 paga las noches del 10
 *   y del 11. La fecha de salida **no** es una noche.
 * - Las fechas son `YYYY-MM-DD` sin hora ni zona. Se opera en UTC a mediodía solo para sumar
 *   días sin que un cambio de hora mueva la fecha; nunca se interpreta como un instante.
 * - Precio de una noche, en este orden: la temporada que la cubra (la más reciente si se
 *   pisan dos) → la tarifa de fin de semana si es viernes o sábado → la tarifa base. Encima,
 *   el recargo por huésped adicional sobre la ocupación base.
 */

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function error(mensaje, code, statusCode = 400) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

function aDia(fecha) {
    const s = String(fecha || '').slice(0, 10);
    if (!RE_FECHA.test(s)) throw error('Fecha no válida (se espera AAAA-MM-DD).', 'FECHA_INVALIDA');
    const d = new Date(`${s}T12:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
        throw error('Fecha no válida.', 'FECHA_INVALIDA');
    }
    return d;
}

function iso(d) {
    return d.toISOString().slice(0, 10);
}

function sumarDias(fecha, n) {
    const d = aDia(fecha);
    d.setUTCDate(d.getUTCDate() + n);
    return iso(d);
}

/** Las noches de `[entrada, salida)`. Falla si la salida no es posterior a la entrada. */
function noches(entrada, salida) {
    const ini = aDia(entrada);
    const fin = aDia(salida);
    if (fin <= ini) throw error('La salida tiene que ser después de la entrada.', 'FECHAS_INVALIDAS');
    const lista = [];
    for (let d = new Date(ini); d < fin; d.setUTCDate(d.getUTCDate() + 1)) lista.push(iso(d));
    if (lista.length > 90) throw error('Una estancia no puede pasar de 90 noches.', 'ESTANCIA_DEMASIADO_LARGA');
    return lista;
}

/** ¿Se pisan `[a1, a2)` y `[b1, b2)`? */
function sePisan(a1, a2, b1, b2) {
    return String(a1) < String(b2) && String(b1) < String(a2);
}

function esFinDeSemana(fecha) {
    const dia = aDia(fecha).getUTCDay();
    return dia === 5 || dia === 6; // noches de viernes y sábado
}

/** La temporada que aplica a una noche: la de inicio más reciente entre las que la cubren. */
function temporadaDe(fecha, temporadas) {
    return (temporadas || [])
        .filter((t) => t.estado !== 'I' && String(t.desde) <= fecha && fecha <= String(t.hasta))
        .sort((a, b) => String(b.desde).localeCompare(String(a.desde)) || (b.id_tarifa || 0) - (a.id_tarifa || 0))[0] || null;
}

/**
 * Cotiza una estancia.
 *
 * @param {object} tipo         Fila de `reserva_unidad_tipo`.
 * @param {object[]} temporadas Filas de `reserva_tarifa_temporada` del tipo.
 * @returns {{ noches: {fecha:string, precio:number, temporada:string|null}[], total:number,
 *             min_noches:number, huespedes_extra:number }}
 */
function cotizar(tipo, temporadas, { entrada, salida, huespedes = 1 }) {
    const lista = noches(entrada, salida);
    const h = Number(huespedes) || 1;
    if (h < 1) throw error('Indica cuántos huéspedes.', 'HUESPEDES_INVALIDOS');
    if (h > Number(tipo.capacidad_max)) {
        throw error(`«${tipo.nombre}» admite hasta ${tipo.capacidad_max} huéspedes.`, 'CAPACIDAD_EXCEDIDA', 422);
    }
    const extra = Math.max(0, h - Number(tipo.ocupacion_base));
    const recargo = extra * Number(tipo.tarifa_persona_extra || 0);

    let minNoches = Number(tipo.min_noches || 1);
    const detalle = lista.map((fecha) => {
        const temporada = temporadaDe(fecha, temporadas);
        let base;
        if (temporada) {
            base = Number(temporada.precio_noche);
            if (temporada.min_noches) minNoches = Math.max(minNoches, Number(temporada.min_noches));
        } else if (tipo.tarifa_fin_semana != null && esFinDeSemana(fecha)) {
            base = Number(tipo.tarifa_fin_semana);
        } else {
            base = Number(tipo.tarifa_base);
        }
        return { fecha, precio: base + recargo, temporada: temporada?.nombre || null };
    });

    return {
        noches: detalle,
        total: detalle.reduce((s, n) => s + n.precio, 0),
        min_noches: minNoches,
        huespedes_extra: extra,
    };
}

/** Falla si la estancia no llega al mínimo de noches del tipo o de su temporada. */
function exigirMinimo(cotizacion) {
    if (cotizacion.noches.length < cotizacion.min_noches) {
        throw error(
            `El mínimo para esas fechas es de ${cotizacion.min_noches} noche${cotizacion.min_noches === 1 ? '' : 's'}.`,
            'MINIMO_DE_NOCHES', 422,
        );
    }
}

module.exports = { noches, sePisan, esFinDeSemana, temporadaDe, cotizar, exigirMinimo, sumarDias, aDia, iso };
