/**
 * Contexto del negocio — quién es el inquilino para el que habla el asistente.
 *
 * ## Por qué existe esto y no un JOIN en el motor
 *
 * El asistente saludaba sin decir dónde estaba: «¿Qué servicio quieres agendar?», igual en una
 * barbería que en un consultorio. Para arreglarlo hace falta el nombre del negocio, y el sitio
 * fácil habría sido añadir un JOIN a `general.gener_negocio` en la consulta que el motor ya
 * hace. Eso funciona hoy y estorba mañana: [ADR-020](../../docs/adr/ADR-020-knowledge.md) dice
 * que la **configuración** del negocio —nombre, horarios, instrucciones para el asistente— es
 * *Business Context*, va **siempre** en el prefijo estable del prompt y es lo que consume el
 * Prompt Builder de F6. Con el JOIN cableado en el motor, F6 tendría que deshacerlo primero.
 *
 * Así que esto es una **costura, no una tabla**: un único sitio que responde «¿quién es este
 * negocio?». Hoy lee `general.gener_negocio`; el día que exista `platform.business_context`
 * cambia aquí dentro y ni el motor ni la FSM se enteran.
 *
 * ## Lo que NO es
 *
 * No es Knowledge (ADR-020 §tabla): el menú en PDF, el reglamento o las FAQ son otra cosa, con
 * propiedades opuestas —grandes, ingeridas, recuperadas por turno y **después** del corte de
 * caché—. Meterlas aquí sería el error de categoría que ese ADR describe, y se pagaría en la
 * factura del primer mes con volumen.
 *
 * No cachea. Es un `SELECT` por clave primaria y el test de simplicidad no admite una caché
 * sin evidencia de que haga falta; cuando la haya, se añade aquí y en ningún otro sitio.
 */
'use strict';

const Models = require('../../app_core/models/conection');

/** Lo que se enseña cuando el negocio no se puede leer. Neutro y sin mentir. */
const GENERICO = {
    id: null, nombre: null, tratamiento: 'el negocio', atencion: null,
    tipoNegocio: null, rubro: null, perfilReserva: null, tiempoEstimado: null, domicilioRango: null,
    direccion: null, telefono: null, horario: null,
};

/**
 * ── Lo que cada vertical sabe de su propio negocio ───────────────────────────────────────
 *
 * Un adaptador registra aquí una función que devuelve datos de *Business Context* que solo él
 * puede leer, y `obtener()` los mezcla en lo que devuelve.
 *
 * ## Por qué una costura y no un `require`
 *
 * El horario de atención era el ejemplo que se quedó sin resolver, y la nota que había aquí
 * explicaba bien por qué se descartaron los dos atajos:
 *
 * - **Leer `reserva.reserva_horario` desde el núcleo** rompe
 *   [ADR-005](../../docs/adr/ADR-005-independencia-verticales.md): el acoplamiento con el esquema
 *   de una vertical vive en su adaptador y en ningún otro sitio.
 * - **Una capacidad `consultar_horario`** contradice [ADR-020](../../docs/adr/ADR-020-knowledge.md):
 *   el horario es configuración, va en el prefijo estable del prompt, no se consulta por turno.
 *
 * Las dos objeciones siguen siendo correctas, y **ninguna aplica a un adaptador**, que es
 * literalmente donde vive ese acoplamiento. Así que el núcleo pone el hueco y la vertical lo
 * llena (`adapters/reserva/contexto.js`). El día que exista `platform.business_context`, esto se
 * rellena de ahí y los proveedores se borran sin que nada más cambie.
 *
 * Lo que un proveedor puede devolver: `{ atencion, horario, cerradoHoy }`. Lo que **no** puede es
 * contenido —el menú en PDF, el reglamento, las FAQ—: eso es Knowledge, va después del corte de
 * caché, y meterlo aquí invalidaría el prefijo de todas las conversaciones del inquilino cada vez
 * que lo suban. Es el error de categoría con factura mensual que ADR-020 existe para prevenir.
 */
const proveedores = [];

function registrarProveedor(fn) {
    if (typeof fn !== 'function') throw new Error('Un proveedor de contexto tiene que ser una función.');
    proveedores.push(fn);
}

/** Solo para los tests y para `_reiniciar`. */
function limpiarProveedores() {
    proveedores.length = 0;
}

/**
 * Lo que aporten las verticales, con la falla contenida.
 *
 * Un proveedor que revienta —una tabla sin migrar, una conexión perdida— **no puede tumbar la
 * conversación** por un dato opcional: el asistente sigue sin saber el horario, que es lo que
 * hacía hasta ayer. Mismo criterio que `leerTiempoEstimado`.
 */
async function deLasVerticales(idNegocio, fila) {
    const extra = {};
    for (const proveedor of proveedores) {
        try {
            Object.assign(extra, (await proveedor(idNegocio, fila)) || {});
        } catch (error) {
            console.warn(`[contextoNegocio] un proveedor de contexto falló: ${error.message}`);
        }
    }
    return extra;
}

/**
 * @param {number} idNegocio
 * @returns {Promise<{id: number|null, nombre: string|null, tratamiento: string}>}
 *   `tratamiento` es cómo referirse al negocio en una frase: su nombre si se conoce, y una
 *   fórmula neutra si no. Que la decida esta capa evita que cada mensaje de la FSM tenga que
 *   acordarse de comprobar si hay nombre — el olvido saldría como «te comunicas con null».
 */
async function obtener(idNegocio) {
    const id = Number(idNegocio);
    if (!Number.isInteger(id) || id < 1) return GENERICO;

    // Tres lecturas del catálogo de tipos, porque la misma columna ha significado cosas distintas:
    //
    // - `t` es el tipo guardado en el negocio. Desde los rubros (2026-09-10) es el **módulo**,
    //   pero los negocios anteriores pueden tener un oficio ahí (el primer cliente de reserva se
    //   creó como BARBERIA). `m` traduce ese oficio a su módulo, que es lo que el enrutado
    //   necesita: una lista blanca de oficios en cada adaptador era una segunda fuente de verdad
    //   que fallaba en silencio con el primer rubro nuevo.
    // - `r` es el **rubro**: cómo se llama el negocio para su cliente («Salón de belleza»), y
    //   su perfil de reserva. Sin él el asistente solo sabía que hablaba con un «RESERVA».
    const filas = await Models.sequelize.query(
        `SELECT n.id_negocio, n.nombre, n.direccion, n.telefono,
                COALESCE(m.nombre, t.nombre) AS tipo_negocio,
                COALESCE(r.descripcion, r.nombre) AS rubro,
                r.perfil_reserva
           FROM general.gener_negocio n
           LEFT JOIN general.gener_tipo_negocio t ON t.id_tipo_negocio = n.id_tipo_negocio
           LEFT JOIN general.gener_tipo_negocio m ON m.id_tipo_negocio = t.id_tipo_modulo
           LEFT JOIN general.gener_tipo_negocio r ON r.id_tipo_negocio = COALESCE(n.id_rubro, n.id_tipo_negocio)
          WHERE n.id_negocio = :id AND n.estado = 'A'`,
        { replacements: { id }, type: Models.sequelize.QueryTypes.SELECT }
    );

    const fila = filas[0];
    // Un negocio inactivo o inexistente no revienta la conversación: el asistente sigue
    // sirviendo, solo que sin nombre. Quién puede hablar con quién lo decide el Policy Gate,
    // no este módulo — aquí se resuelve identidad, no autorización.
    if (!fila) return GENERICO;

    const nombre = texto(fila.nombre);
    return {
        id,
        nombre,
        tratamiento: nombre || GENERICO.tratamiento,
        // Lo mas preguntado por WhatsApp, y hasta hoy el asistente no lo sabia: «donde quedan»,
        // «a que hora abren». Las dos primeras estan en la misma fila que ya se leia — nadie las
        // pedia—; el horario lo aporta la vertical por la costura de arriba.
        direccion: texto(fila.direccion),
        telefono: texto(fila.telefono),
        ...(await deLasVerticales(id, fila)),
        // Qué CLASE de negocio es. No se traduce aquí a una vertical: este módulo no sabe qué
        // verticales existen y no debe saberlo (ADR-009). Devuelve el nombre del tipo tal como
        // está en el catálogo —`RESTAURANTE`, `RESERVA`— y quien enruta lo traduce con lo que
        // los adaptadores hayan declarado.
        tipoNegocio: tipoParaEnrutar(fila),
        // El oficio con el que el cliente conoce al negocio. Es texto para frases, no una clave:
        // enrutar por él devolvería la lista blanca que la columna `tipoNegocio` acaba de quitar.
        rubro: String(fila.rubro || '').trim() || null,
        perfilReserva: String(fila.perfil_reserva || '').trim().toUpperCase() || null,
        // Cuánto tarda un pedido, según el propio negocio (`null` = no lo ha dicho).
        tiempoEstimado: await leerTiempoEstimado(id),
        // Cuánto tarda uno PARA RECOGER (`null` = no lo ha dicho: vale el estimado de arriba).
        tiempoRecoger: await leerTiempoRecoger(id),
        // Cuánto vale el domicilio, como rango (`null` = no lo ha dicho).
        domicilioRango: await leerDomicilioRango(id),
    };
}

/**
 * El tiempo estimado que el negocio declaró para sus pedidos: `{ min, max }` (`max` puede ser
 * `null`) o `null` si no lo ha configurado.
 *
 * En una consulta APARTE y con la falla contenida, a propósito: `obtener` corre en cada turno de
 * cada conversación, y si la columna todavía no existe (un entorno sin migrar, un despliegue que
 * llegó antes que su migración) no puede tumbar al asistente entero por un dato opcional. Sin
 * columna, el bot simplemente no promete ningún tiempo —que es lo que hacía hasta hoy—.
 */
let avisoTiempoEmitido = false;
async function leerTiempoEstimado(id) {
    try {
        const [fila] = await Models.sequelize.query(
            `SELECT tiempo_estimado_min AS min, tiempo_estimado_max AS max
               FROM general.gener_negocio WHERE id_negocio = :id`,
            { replacements: { id }, type: Models.sequelize.QueryTypes.SELECT }
        );
        const min = Number(fila?.min);
        if (!Number.isInteger(min) || min < 1) return null;
        const max = Number(fila?.max);
        return { min, max: Number.isInteger(max) && max >= min ? max : null };
    } catch (error) {
        // Una sola vez: esto corre en cada turno y el log no necesita el mismo aviso mil veces.
        if (!avisoTiempoEmitido) {
            avisoTiempoEmitido = true;
            console.warn(`[contextoNegocio] no se pudo leer el tiempo estimado: ${error.message}`);
        }
        return null;
    }
}

/**
 * El tiempo de un pedido para recoger: `{ min, max }` o `null` si el negocio no lo ha dicho.
 *
 * Aparte de `leerTiempoEstimado` (que es el del domicilio: cocina más camino) y con la misma
 * falla contenida: en un entorno sin la columna, el asistente dice el estimado de siempre.
 */
async function leerTiempoRecoger(id, transaction = undefined) {
    try {
        const [fila] = await Models.sequelize.query(
            `SELECT tiempo_recoger_min AS min, tiempo_recoger_max AS max
               FROM general.gener_negocio WHERE id_negocio = :id`,
            { replacements: { id }, type: Models.sequelize.QueryTypes.SELECT, transaction }
        );
        const min = Number(fila?.min);
        if (!Number.isInteger(min) || min < 1) return null;
        const max = Number(fila?.max);
        return { min, max: Number.isInteger(max) && max >= min ? max : null };
    } catch (_) {
        return null;
    }
}

/**
 * El valor del domicilio que declaró el negocio, como rango: `{ min, max, nota }` (`max` y `nota`
 * pueden ser `null`) o `null` si no ha dicho ni un valor ni una nota.
 *
 * Existe desde 2026-10-02 porque cargar el precio barrio por barrio era tedioso: el negocio dice
 * «entre $7.000 y $9.000; fuera de la ciudad, desde $10.000» y eso contesta el asistente. Misma
 * falla contenida que `leerTiempoEstimado`, y por la misma razón.
 */
let avisoDomicilioEmitido = false;
async function leerDomicilioRango(id) {
    try {
        const [fila] = await Models.sequelize.query(
            `SELECT domicilio_valor_min AS min, domicilio_valor_max AS max, domicilio_nota AS nota
               FROM general.gener_negocio WHERE id_negocio = :id`,
            { replacements: { id }, type: Models.sequelize.QueryTypes.SELECT }
        );
        return normalizarDomicilioRango(fila);
    } catch (error) {
        if (!avisoDomicilioEmitido) {
            avisoDomicilioEmitido = true;
            console.warn(`[contextoNegocio] no se pudo leer el rango del domicilio: ${error.message}`);
        }
        return null;
    }
}

/** `{ min, max, nota }` de una fila con esas columnas, o `null` si no dice nada utilizable. */
function normalizarDomicilioRango(fila) {
    const crudoMin = fila?.min;
    const min = crudoMin === null || crudoMin === undefined ? NaN : Number(crudoMin);
    const valido = Number.isInteger(min) && min >= 0;
    const max = Number(fila?.max);
    const nota = String(fila?.nota || '').trim() || null;
    if (!valido && !nota) return null;
    return {
        min: valido ? min : null,
        max: valido && Number.isInteger(max) && max > min ? max : null,
        nota,
    };
}

/**
 * El tipo por el que se elige el flujo de conversación.
 *
 * Es el módulo, salvo en un caso: un alojamiento usa el módulo de reserva pero **no agenda
 * citas** —reserva noches—. Enviarlo al flujo de citas le ofrecería horas a quien pregunta por
 * una habitación. Se le da un tipo propio para que lo atienda el flujo que sí sabe de estancias.
 */
/** Un campo de texto opcional: la cadena limpia, o `null` si no dice nada. */
function texto(valor) {
    return String(valor ?? '').trim() || null;
}

function tipoParaEnrutar(fila) {
    const modulo = String(fila.tipo_negocio || '').trim().toUpperCase() || null;
    if (String(fila.perfil_reserva || '').trim().toUpperCase() === 'ALOJAMIENTO') return 'ALOJAMIENTO';
    return modulo;
}

module.exports = {
    obtener, GENERICO, normalizarDomicilioRango, registrarProveedor, limpiarProveedores,
    leerTiempoRecoger,
};
