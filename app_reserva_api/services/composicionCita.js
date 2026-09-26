'use strict';
/**
 * Composición de una cita: de la lista de servicios pedidos (y sus variantes o precios
 * cotizados) a lo que el motor necesita saber —cuánto dura, cuánto cuesta, en qué tramos queda
 * libre el profesional y qué recurso ocupa—.
 *
 * ## Por qué es un módulo aparte, y puro
 *
 * Lo necesitan cuatro sitios que no pueden divergir: ofrecer horas (`disponibilidadService`),
 * crear, editar y reagendar (`citaService`) y apartar un hueco (`holdService`). Si cada uno
 * sumara duraciones a su manera volvería el problema que `reglasAgenda.js` nació para resolver:
 * horas que se ofrecen y luego se rechazan. Y al ser puro se prueba entero sin base de datos.
 *
 * ## Funciones del perfil
 *
 * Cada particularidad aplica solo si el negocio tiene su función encendida (`funciones`). Con
 * todo apagado —la barbería— el resultado es exactamente la suma de duraciones y precios de
 * lista de siempre, sin tramos y sin recurso. Ver `docs/perfiles-de-reserva.md`.
 */

function error(mensaje, code, statusCode = 400) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

/**
 * @param {Array} servicios        Filas de `reserva_servicio`, **en el orden pedido**.
 * @param {Object} [opciones]
 * @param {Set<string>|string[]} [opciones.funciones]  Funciones activas del negocio.
 * @param {Map<number,object>} [opciones.variantes]    id_servicio → fila de variante elegida.
 * @param {Map<number,{precio?:number,duracion_min?:number}>} [opciones.ajustes]
 *        id_servicio → precio/duración acordados (solo servicios «a cotizar»).
 * @returns {{ duracion:number, monto:number, tramos:number[][]|null, idTipoRecurso:number|null,
 *             requiereConsentimiento:boolean, lineas:object[] }}
 */
function componer(servicios, { funciones = [], variantes = new Map(), ajustes = new Map() } = {}) {
    const activas = funciones instanceof Set ? funciones : new Set(funciones);
    const conVariantes = activas.has('variantes');
    const conProceso = activas.has('tiempo_proceso');
    const conCotizacion = activas.has('a_cotizar');
    const conRecursos = activas.has('recursos');
    const conConsentimiento = activas.has('consentimiento');

    let offset = 0;
    let monto = 0;
    const tramos = [];
    const lineas = [];
    const tiposRecurso = new Set();
    let requiereConsentimiento = false;

    for (const s of servicios) {
        let duracion = Number(s.duracion_min);
        let precio = Number(s.precio);
        let idVariante = null;
        let varianteSnapshot = null;

        const variante = conVariantes ? variantes.get(s.id_servicio) : null;
        if (variante) {
            if (Number(variante.id_servicio) !== Number(s.id_servicio) || variante.estado === 'I') {
                throw error('La variante elegida no pertenece a ese servicio.', 'VARIANTE_NO_VALIDA');
            }
            duracion = Number(variante.duracion_min);
            precio = Number(variante.precio);
            idVariante = variante.id_variante;
            varianteSnapshot = variante.nombre;
        }

        const ajuste = ajustes.get(s.id_servicio);
        if (ajuste && (ajuste.precio != null || ajuste.duracion_min != null)) {
            if (!(conCotizacion && s.a_cotizar)) {
                throw error(`El precio de «${s.nombre}» es el de lista: no se cotiza.`, 'SERVICIO_NO_COTIZABLE');
            }
            if (ajuste.duracion_min != null) {
                const d = Number(ajuste.duracion_min);
                if (!Number.isInteger(d) || d < 5 || d > 24 * 60) {
                    throw error('La duración acordada debe estar entre 5 minutos y 24 horas.', 'DURACION_NO_VALIDA');
                }
                duracion = d;
            }
            if (ajuste.precio != null) {
                const p = Number(ajuste.precio);
                if (!Number.isFinite(p) || p < 0) throw error('El precio acordado no es válido.', 'PRECIO_NO_VALIDO');
                precio = p;
            }
        }

        // Tramo de proceso: solo si cabe dentro del propio servicio. Uno mal configurado (la
        // espera empieza después de terminar) no libera nada, en vez de liberar un rato que
        // pertenece al servicio siguiente.
        if (conProceso) {
            const desde = Number(s.proceso_desde_min || 0);
            const min = Number(s.proceso_min || 0);
            if (min > 0 && desde > 0 && desde + min < duracion) {
                tramos.push([offset + desde, offset + desde + min]);
            }
        }

        if (conRecursos && s.id_tipo_recurso) tiposRecurso.add(Number(s.id_tipo_recurso));
        if (conConsentimiento && s.requiere_consentimiento) requiereConsentimiento = true;

        lineas.push({
            id_servicio: s.id_servicio,
            id_variante: idVariante,
            variante_snapshot: varianteSnapshot,
            precio_snapshot: precio,
            duracion_snapshot_min: duracion,
        });
        offset += duracion;
        monto += precio;
    }

    if (tiposRecurso.size > 1) {
        throw error(
            'Esos servicios usan recursos distintos (por ejemplo, dos cabinas diferentes). Agéndalos por separado.',
            'RECURSOS_INCOMPATIBLES',
        );
    }

    return {
        duracion: offset,
        monto,
        tramos: tramos.length ? tramos : null,
        idTipoRecurso: tiposRecurso.size ? [...tiposRecurso][0] : null,
        requiereConsentimiento,
        lineas,
    };
}

/**
 * Normaliza `{ id_servicio: id_variante }` o `[{ id_servicio, id_variante }]` a un Map de ids.
 * El portal manda un objeto; el formulario del negocio, una lista.
 */
function normalizarVariantes(entrada) {
    const salida = new Map();
    if (!entrada) return salida;
    let bruto = entrada;
    if (typeof bruto === 'string') {
        try { bruto = JSON.parse(bruto); } catch { return salida; }
    }
    const pares = Array.isArray(bruto)
        ? bruto.map((x) => [x?.id_servicio, x?.id_variante])
        : Object.entries(bruto);
    for (const [s, v] of pares) {
        const idS = Number(s);
        const idV = Number(v);
        if (Number.isInteger(idS) && idS > 0 && Number.isInteger(idV) && idV > 0) salida.set(idS, idV);
    }
    return salida;
}

/** Normaliza `[{ id_servicio, precio?, duracion_min? }]` a un Map. */
function normalizarAjustes(entrada) {
    const salida = new Map();
    let bruto = entrada;
    if (typeof bruto === 'string') {
        try { bruto = JSON.parse(bruto); } catch { return salida; }
    }
    if (!Array.isArray(bruto)) return salida;
    for (const a of bruto) {
        const id = Number(a?.id_servicio);
        if (!Number.isInteger(id) || id <= 0) continue;
        salida.set(id, {
            precio: a.precio === '' || a.precio == null ? null : Number(a.precio),
            duracion_min: a.duracion_min === '' || a.duracion_min == null ? null : Number(a.duracion_min),
        });
    }
    return salida;
}

module.exports = { componer, normalizarVariantes, normalizarAjustes };
